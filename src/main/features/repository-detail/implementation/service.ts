import type { AccessContextPort, GitHubPort, RepositoryRefPort, ScopeFetchPort, ScopeVerificationPort } from '../../../../domain/ports';
import type { Glance, ObservationHandoff } from '../../../../domain/types';
import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type {
  DetailAccessResult,
  DetailObservation,
  LocalDetailView,
  LocalReadRequest,
  ObservationApplyOutcome,
  RepositoryDetailService,
} from '../contract';
import { applyScopeObservation, initialScopeState, observationReasons } from '../../../../domain/rules/observation-application';
import { SCOPE_ORDER } from '../../../../domain/rules/detail-scope';
import { hasReadableDetail, historyReadOffset, readLocalColumns, readLocalScopePage, readHistoryPage } from './local-detail-store';
import {
  DETAIL_CACHE_SCHEMA_VERSION,
  bumpViewVersion,
  clearDetails,
  deleteDetail,
  hasObservationApply,
  insertObservationApply,
  readDetail,
  readDetailMeta,
  readScopeState,
  readScopeStates,
  readViewVersion,
  writeScopeState,
} from './detail-store';
import { applyViewAcknowledgment } from './acknowledge-viewed';
import { buildLocalView } from './open-detail';
import { createSyncTaskRunner } from './task-runner';

export interface RepositoryDetailDependencies {
  db: LocalDatabase;
  github: GitHubPort;
  clock: Clock;
  repositoryById(id: number): Glance | null;
  /** 默认分支等仓库窄引用（来自清单观察）；由组合根注入。 */
  repositoryRef: RepositoryRefPort;
  /** 当前访问上下文；读取与写入前实时读取，跨上下文观察不改动账本。 */
  accessContext: AccessContextPort;
  /** 范围验证与范围抓取端口（后台任务的实际执行能力）。 */
  scopeVerify: ScopeVerificationPort;
  scopeFetch: ScopeFetchPort;
  nextTaskId: () => string;
}

export function createRepositoryDetailService(dependencies: RepositoryDetailDependencies): RepositoryDetailService {
  const { db, repositoryById, accessContext } = dependencies;
  let observationListener: ((observation: DetailObservation) => void) | undefined;
  const taskRunner = createSyncTaskRunner({ ...dependencies, onObserved: observation => observationListener?.(observation) });

  /** 本地视图：读取路径共用；不启动任务、不写库、不刷新任何时间。 */
  function localView(repositoryId: number, request: LocalReadRequest = {}): LocalDetailView | null {
    const repository = repositoryById(repositoryId);
    if (!repository) return null;
    const current = accessContext.currentRevision();
    const cacheMeta = readDetailMeta(db, repositoryId);
    const mode = request.mode === 'status' ? 'status' : 'view';
    const validMeta = cacheMeta?.schemaVersion === DETAIL_CACHE_SCHEMA_VERSION && cacheMeta.accessContextRevision === current;
    const corrupted = mode === 'view' && validMeta && !hasReadableDetail(db, repositoryId);
    return buildLocalView(repository, {
      cacheMeta, corrupted, currentAccessContextRevision: current,
      scopeStates: readScopeStates(db, repositoryId, current),
      viewVersion: readViewVersion(db, repositoryId),
      columns: validMeta ? readLocalColumns(db, repositoryId) : {},
      task: taskRunner.snapshot(repositoryId),
      readScope: (scope, offset, limit) => readLocalScopePage(db, repositoryId, scope, offset, limit),
    }, request);
  }

  function requireRepository(repositoryId: number): Glance {
    const repository = repositoryById(repositoryId);
    if (!repository) throw new Error(`监控仓库不存在：${repositoryId}`);
    return repository;
  }

  async function open(repositoryId: number, token: string | null): Promise<DetailAccessResult> {
    requireRepository(repositoryId);
    const view = localView(repositoryId)!;
    if (!token) return { view, fetched: false, error: null };
    const scheduled = taskRunner.schedule(repositoryId, token, 'open');
    if (!scheduled) return { view, fetched: false, error: null };
    if (view.values !== null) {
      // 有可展示缓存：立即返回本地视图与真实任务快照，不等待后台网络完成。
      return { view: { ...view, task: scheduled.snapshot }, fetched: false, error: null };
    }
    // 没有可展示缓存：等待必要的首次获取（失败返回原始错误，由 facade 归一化）。
    const outcome = await scheduled.settled;
    return { view: localView(repositoryId) ?? view, fetched: outcome.stored ?? outcome.ok, error: outcome.ok ? null : outcome.error };
  }

  async function refresh(repositoryId: number, token: string): Promise<DetailAccessResult> {
    requireRepository(repositoryId);
    const before = localView(repositoryId)!;
    const scheduled = taskRunner.schedule(repositoryId, token, 'force');
    const outcome = scheduled ? await scheduled.settled : { ok: false, error: new Error('强制同步未能安排') };
    return { view: localView(repositoryId) ?? before, fetched: outcome.stored ?? outcome.ok, error: outcome.ok ? null : outcome.error };
  }

  return {
    getCached: (repositoryId) => readDetail(db, repositoryId),
    onObservation: listener => { observationListener = listener; },
    open,
    refresh,
    async loadHistory(repositoryId, _token, kind, cursor) {
      requireRepository(repositoryId);
      // 本地优先：分页只读已保存内容，不在读取路径触发网络；首次获取由打开用例负责。
      const meta = readDetailMeta(db, repositoryId);
      const revision = accessContext.currentRevision();
      if (!meta || meta.schemaVersion !== DETAIL_CACHE_SCHEMA_VERSION || meta.accessContextRevision !== revision) return { items: [], nextCursor: null, hasMore: false };
      // 续读绑定仓库、上下文、内容版本与栏目；后台换版后旧游标不能继续消费新列表。
      const identity = { repositoryId, accessContextRevision: revision, viewVersion: readViewVersion(db, repositoryId), fetchedAt: meta.fetchedAt };
      const offset = historyReadOffset(cursor, kind, identity);
      if (offset === null) return { items: [], nextCursor: null, hasMore: false };
      return readHistoryPage(db, repositoryId, kind, offset, identity);
    },
    remove: (repositoryId) => deleteDetail(db, repositoryId),
    clear: () => clearDetails(db),

    readLocal: (repositoryId, request = {}) => localView(repositoryId, request),

    applyObservation(handoff: ObservationHandoff, appliedAt: string): ObservationApplyOutcome {
      if (!repositoryById(handoff.repoId)) return { applied: false, duplicate: false, affectedScopes: [] };
      const current = accessContext.currentRevision();
      // 跨访问上下文观察不得修改当前账本。
      if (handoff.accessContextRevision !== current) return { applied: false, duplicate: false, affectedScopes: [] };
      // 幂等：同一 observationId 重放不再重复递增序号。
      if (hasObservationApply(db, handoff.repoId, handoff.observationId)) return { applied: false, duplicate: true, affectedScopes: [] };

      if (handoff.changeSet.repoId !== handoff.repoId) return { applied: false, duplicate: false, affectedScopes: [] };
      const scopes = SCOPE_ORDER.filter(scope => handoff.changeSet.affectedScopes.includes(scope));
      const write = db.transaction(() => {
        const cacheMeta = readDetailMeta(db, handoff.repoId);
        for (const scope of scopes) {
          const existing = readScopeState(db, handoff.repoId, scope, current);
          const status = cacheMeta === null ? 'missing' : cacheMeta.schemaVersion === DETAIL_CACHE_SCHEMA_VERSION && cacheMeta.accessContextRevision === current ? 'valid' : 'invalid';
          const base = existing ?? initialScopeState(status);
          writeScopeState(db, handoff.repoId, scope, applyScopeObservation(base, observationReasons(scope, handoff.changeSet)), current);
        }
        insertObservationApply(db, {
          observationId: handoff.observationId,
          repositoryId: handoff.repoId,
          appliedAt,
          accessContextRevision: current,
          affectedScopes: scopes,
        });
        bumpViewVersion(db, handoff.repoId, appliedAt);
      });
      write();
      return { applied: true, duplicate: false, affectedScopes: [...scopes] };
    },

    acknowledgeViewed(repositoryId, acknowledgment) {
      // 同步确认原语：只读账本、按需推进 viewedRevision；无网络、无 Token、不改写视图版本。
      return applyViewAcknowledgment(db, {
        repositoryId,
        repositoryExists: repositoryById(repositoryId) !== null,
        currentAccessContextRevision: accessContext.currentRevision(),
        currentDetailViewVersion: readViewVersion(db, repositoryId),
        acknowledgment,
      });
    },
  };
}
