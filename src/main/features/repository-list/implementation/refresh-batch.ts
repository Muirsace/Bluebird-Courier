import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Logger } from '../../../core/infra/logger';
import { PortFailure } from '../../../../domain/ports';
import type { AccessContextPort, SummaryObservationPort } from '../../../../domain/ports';
import type {
  ActivityCandidate,
  CheckedSignal,
  Glance,
  NormalizedError,
  RepositoryObservation,
  SummaryObservation,
} from '../../../../domain/types';
import { detectChanges } from '../../../../domain/rules/change-detection';
import { resolveActivity } from '../../../../domain/rules/activity-sort';
import { classifyObservationActivity } from '../../../../domain/rules/activity-importance';
import type { ObservedSummaryRecord, RepositoryCheckOutcome, RepositorySingleCheckOutcome } from '../contract';
import { readRow, readStoredObservation, rowToGlance, insertObservationHandoff } from './repository-list-store';
import { listRepositories } from './list-repositories';
import { writeObservedGlance, writeRepositoryGlance } from './repository-status';
import { markRepositoryFailure } from './retry-repository';

/** 详情侧（facade）写回摘要的兼容入口：只更新展示值，不产生观察快照。 */
export function applyRepositoryGlance(db: LocalDatabase, clock: Clock, id: number, values: Parameters<typeof writeRepositoryGlance>[2]): Glance {
  const observedAt = clock.now().toISOString();
  if (!readRow(db, id)) throw new Error(`监控仓库不存在：${id}`);
  writeRepositoryGlance(db, id, values, observedAt);
  return rowToGlance(readRow(db, id)!);
}

export interface ObservationCheckDependencies {
  db: LocalDatabase;
  clock: Clock;
  /** 归一化观察端口（组合根注入）；清单检查只做观察，不抓取详情。 */
  github: SummaryObservationPort;
  logger?: Logger;
  accessContext: AccessContextPort;
  nextObservationId: () => string;
  onObserved?(observation: ObservedSummaryRecord): void;
}

/** 清单 feature 的轻量检查：归一化观察、变化比较、原子保存与待交接记录。 */
export function createObservationCheck({ db, clock, github, logger, accessContext, nextObservationId, onObserved }: ObservationCheckDependencies) {
  // 去重登记：启动检查 / 手动检查 / 单仓库重试共用；键包含仓库与访问上下文。
  const inFlight = new Map<string, Promise<RepositorySingleCheckOutcome>>();
  const batches = new Map<number, Promise<RepositoryCheckOutcome>>();
  let startupChecked = false;
  const ignored = (): RepositorySingleCheckOutcome => ({ repository: null, error: null, observed: null });
  const isCurrent = (id: number, revision: number): boolean => accessContext.currentRevision() === revision && readRow(db, id) !== null;

  /** 与 facade 的错误归一同构：端口失败按类别透传，中止 / 类型错误归为网络失败。 */
  function toError(error: unknown, fullName: string): NormalizedError {
    if (error instanceof PortFailure) {
      return { kind: error.kind, message: error.message, fullName, ...(error.resetAt ? { resetAt: error.resetAt } : {}) };
    }
    if (typeof error === 'object' && error !== null) {
      const name = (error as { name?: unknown }).name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        return { kind: 'network', message: '网络请求超时，请检查网络后重试', fullName };
      }
    }
    if (error instanceof TypeError) return { kind: 'network', message: '网络失败，请检查网络后重试', fullName };
    return { kind: 'unknown', message: error instanceof Error ? error.message : '发生未知错误', fullName };
  }

  /**
   * 合并观察：信号为 unknown 或候选缺失时，保留同上下文旧观察的对应项。
   * 失败或空的信号不得清空已有有效来源；跨上下文的旧观察不参与合并。
   */
  function mergeObservation(previous: RepositoryObservation | null, next: SummaryObservation): SummaryObservation {
    if (previous === null || previous.accessContextRevision !== next.accessContextRevision) return next;
    const signal = <T>(prev: CheckedSignal<T>, nxt: CheckedSignal<T>): CheckedSignal<T> => (nxt.state === 'known' ? nxt : prev);
    const candidate = (prev: ActivityCandidate, nxt: ActivityCandidate): ActivityCandidate => (nxt.at !== null ? nxt : prev);
    const activity = {
      code: candidate(previous.activity.code, next.activity.code),
      release: next.signals.releaseRevision.state === 'unknown' ? previous.activity.release : candidate(previous.activity.release, next.activity.release),
      collaboration: candidate(previous.activity.collaboration, next.activity.collaboration),
    };
    return {
      ...next,
      values: {
        ...next.values,
        latestTag: next.signals.tagRevision.state === 'unknown' ? previous.values.latestTag : next.values.latestTag,
        latestReleaseTag: next.signals.releaseRevision.state === 'unknown'
          ? previous.values.latestReleaseTag
          : next.signals.releaseRevision.value === null
            ? (next.signals.tagRevision.state === 'unknown' ? previous.values.latestTag ?? null : next.values.latestTag ?? null)
            : next.values.latestReleaseTag,
        collaborationAt: activity.collaboration.at,
      },
      signals: {
        defaultBranch: signal(previous.signals.defaultBranch, next.signals.defaultBranch),
        headRevision: signal(previous.signals.headRevision, next.signals.headRevision),
        releaseRevision: signal(previous.signals.releaseRevision, next.signals.releaseRevision),
        tagRevision: signal(previous.signals.tagRevision, next.signals.tagRevision),
      },
      activity,
    };
  }

  async function observeAndPersist(repository: Glance, accessToken: string, accessContextRevision: number): Promise<RepositorySingleCheckOutcome> {
    if (!isCurrent(repository.id, accessContextRevision)) return ignored();
    const observedAt = clock.now().toISOString();
    let observation: SummaryObservation;
    try {
      observation = await github.observeSummary(accessToken, repository.fullName, observedAt, accessContextRevision);
    } catch (error) {
      if (!isCurrent(repository.id, accessContextRevision)) return ignored();
      // 失败保留旧摘要与旧活动：只记录失败状态，不触碰展示列。
      const normalized = toError(error, repository.fullName);
      markRepositoryFailure(db, clock, repository.id, normalized);
      logger?.error(`清单轻量检查失败：${repository.fullName}`, error);
      return { repository: null, error: normalized, observed: null };
    }

    if (!isCurrent(repository.id, accessContextRevision) || observation.accessContextRevision !== accessContextRevision) return ignored();
    const row = readRow(db, repository.id);
    if (!row) return { repository: null, error: { kind: 'not_found', message: '监控仓库不存在', fullName: repository.fullName }, observed: null };
    const previous = readStoredObservation(row);
    const merged = mergeObservation(previous, observation);
    // 兼容旧摘要和损坏快照：unknown 展示值可保留同上下文旧值，但信号仍未知。
    if (previous === null && (row.access_context_revision ?? 0) === accessContextRevision) {
      if (observation.signals.tagRevision.state === 'unknown') merged.values.latestTag = row.latest_tag ?? null;
      if (observation.signals.releaseRevision.state === 'unknown') merged.values.latestReleaseTag = row.latest_release_tag;
      else if (observation.signals.releaseRevision.value === null && observation.signals.tagRevision.state === 'unknown') merged.values.latestReleaseTag = row.latest_tag ?? null;
    }
    const judgedActivity = classifyObservationActivity(previous, merged);
    // 旧的重要源事件仍有效；新的普通更新时间不能把它清空或替换成噪声。
    const retained = previous?.accessContextRevision === accessContextRevision
      ? [previous.activity.code, previous.activity.release, previous.activity.collaboration] : [];
    const previousActivity = previous?.accessContextRevision === accessContextRevision
      ? { at: row.activity_at ?? null, kind: row.activity_kind as ActivityCandidate['kind'] | null } : undefined;
    const resolved = resolveActivity([...retained, judgedActivity.code, judgedActivity.release, judgedActivity.collaboration], observedAt, undefined, previousActivity);
    const changeSet = detectChanges(previous, { ...merged, repoId: repository.id });
    const observationId = nextObservationId();

    // Summary、观察信号与待交接记录同事务保存；失败一起回滚（保留旧值并记录失败）。
    try {
      const write = db.transaction(() => {
        writeObservedGlance(db, repository.id, {
          values: merged.values,
          observation: { ...merged, repoId: repository.id, activity: judgedActivity },
          activityAt: resolved.at,
          activityKind: resolved.kind,
          accessContextRevision,
          fetchedAt: observedAt,
        });
        if (changeSet.affectedScopes.length > 0) {
          insertObservationHandoff(db, {
            observationId,
            repositoryId: repository.id,
            detectedAt: changeSet.detectedAt,
            accessContextRevision,
            changeSet,
          });
        }
      });
      write();
    } catch (error) {
      const normalized = toError(error, repository.fullName);
      markRepositoryFailure(db, clock, repository.id, normalized);
      logger?.error(`清单观察保存失败：${repository.fullName}`, error);
      return { repository: null, error: normalized, observed: null };
    }

    const partialError = observation.errors?.find(error => error.kind === 'access_token_invalid' || error.kind === 'rate_limited') ?? observation.errors?.[0] ?? null;
    if (partialError) markRepositoryFailure(db, clock, repository.id, partialError);
    const updated = readRow(db, repository.id)!;
    const observed = { observationId, repositoryId: repository.id, accessContextRevision, observedAt, values: merged.values };
    // 真实观察已经提交，立即同步通知；批次等待其他仓库不能倒置与详情来源的先后。
    try { onObserved?.(observed); } catch (error) { logger?.error('真实清单观察通知失败', error); }
    return {
      repository: rowToGlance(updated),
      error: partialError,
      observed,
    };
  }

  /** 单仓库检查：同仓库同上下文在途任务复用同一 Promise（启动 / 手动 / 重试共用）。 */
  function checkRepository(repositoryId: number, accessToken: string, accessContextRevision: number): Promise<RepositorySingleCheckOutcome> {
    if (accessContext.currentRevision() !== accessContextRevision) return Promise.resolve(ignored());
    const row = readRow(db, repositoryId);
    if (!row) {
      return Promise.resolve({ repository: null, error: { kind: 'not_found', message: '监控仓库不存在' }, observed: null });
    }
    const key = `${repositoryId}|${accessContextRevision}|check`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const tracked = observeAndPersist(rowToGlance(row), accessToken, accessContextRevision).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, tracked);
    return tracked;
  }

  /** 全部仓库的轻量检查；Token 无效或限流时停止后续请求，其余错误逐条记录。 */
  async function runBatch(accessToken: string, accessContextRevision: number): Promise<RepositoryCheckOutcome> {
    const errors: NormalizedError[] = [];
    const observed: ObservedSummaryRecord[] = [];
    let stopped = false;
    let stopReason: 'access_token_invalid' | 'rate_limited' | null = null;
    for (const repository of listRepositories(db)) {
      if (accessContext.currentRevision() !== accessContextRevision) break;
      const result = await checkRepository(repository.id, accessToken, accessContextRevision);
      if (result.observed) observed.push(result.observed);
      if (result.error) {
        if (!errors.some((item) => item.kind === result.error!.kind)) errors.push(result.error);
        if (result.error.kind === 'access_token_invalid' || result.error.kind === 'rate_limited') {
          stopped = true;
          stopReason = result.error.kind;
          break;
        }
      }
    }
    return { repositories: listRepositories(db), errors, stopped, stopReason, observed };
  }

  /** 主进程生命周期内启动检查只执行一次；手动检查仍可重复，并与在途批次复用。 */
  function checkRepositories(accessToken: string, revision: number, origin: 'startup' | 'manual' = 'manual'): Promise<RepositoryCheckOutcome> {
    const existing = batches.get(revision);
    if (origin === 'startup') {
      if (startupChecked) return existing ?? Promise.resolve({ repositories: listRepositories(db), errors: [], stopped: false, stopReason: null, observed: [], skipped: true });
      startupChecked = true;
    }
    if (existing) return existing;
    const tracked = runBatch(accessToken, revision).finally(() => batches.delete(revision));
    batches.set(revision, tracked);
    return tracked;
  }

  return { checkRepository, checkRepositories };
}
