import { PortFailure, type AccessContextPort, type GitHubPort, type RepositoryRefPort, type ScopeFetchPort, type ScopeVerificationPort } from '../../../../domain/ports';
import type { BuildItem, CacheStatus, DetailScope, Glance, ScopeSyncState, TaskContext } from '../../../../domain/types';
import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import { BUILD_SCOPE_GROUP, planSync } from '../../../../domain/rules/sync-plan';
import { REMOTE_SCOPES, SCOPE_COLUMNS } from '../../../../domain/rules/detail-scope';
import { isVerificationExpired } from '../../../../domain/rules/refresh-window';
import { canCommitTaskResult, deriveFreshness, hasUnsyncedChanges, ledgerOf } from '../../../../domain/rules/scope-ledger';
import { applyScopeObservation, applyScopeVerification, initialScopeState, verificationChangeScopes } from '../../../../domain/rules/observation-application';
import { emptyLocalBuild } from '../../../../domain/rules/local-read';
import type { DetailCache, DetailObservation, SyncTaskState } from '../contract';
import { DETAIL_CACHE_SCHEMA_VERSION, bumpViewVersion, readDetailMeta, readScopeState, readScopeStatesFull, writeBuildsScope, writeSyncedDetail, writeScopeState, readDetail, readCachedBranch, hasColumnData, type ScopeConfirmationWrite } from './detail-store';
import { hasReadableDetail } from './local-detail-store';
import { collectScope, loadFullDetail } from './refresh-detail';

const DETAIL_VERIFICATION_TTL_MS = 30 * 60_000;
export interface SyncTaskOutcome { ok: boolean; error: unknown; stored?: boolean; }
export interface ScheduledSyncTask { snapshot: SyncTaskState; settled: Promise<SyncTaskOutcome>; }
export interface SyncTaskRunner {
  schedule(repositoryId: number, token: string, intent: 'open' | 'force'): ScheduledSyncTask | null;
  snapshot(repositoryId: number): SyncTaskState | null;
}
export interface SyncTaskDependencies {
  db: LocalDatabase; clock: Clock; github: GitHubPort;
  repositoryById(repositoryId: number): Glance | null;
  repositoryRef: RepositoryRefPort; accessContext: AccessContextPort;
  scopeVerify: ScopeVerificationPort; scopeFetch: ScopeFetchPort; nextTaskId(): string;
  onObserved?(observation: DetailObservation): void;
}
interface ActiveTask extends ScheduledSyncTask { repoId: number; revision: number; key: string; }

export function createSyncTaskRunner({ db, clock, repositoryById, repositoryRef, accessContext, scopeVerify, scopeFetch, nextTaskId, onObserved }: SyncTaskDependencies): SyncTaskRunner {
  const active = new Map<string, ActiveTask>();
  const versions = new Map<number, number>();
  const attempts = new Map<string, string>();
  function writable(context: TaskContext, fullName: string): boolean {
    return repositoryById(context.repoId)?.fullName === fullName && canCommitTaskResult(context, {
      repositoryExists: true, accessContextRevision: accessContext.currentRevision(),
      latestTaskVersion: versions.get(context.repoId) ?? context.taskVersion,
    });
  }
  function confirmation(context: TaskContext, scope: DetailScope, fingerprint?: string): ScopeConfirmationWrite {
    return { scope, targetRevision: context.targets[scope]?.targetRevision ?? 0, covered: true, ...(fingerprint !== undefined ? { fingerprint } : {}) };
  }
  function normalizedFailure(error: unknown): import('../../../../domain/types').NormalizedError {
    if (error instanceof PortFailure) return { kind: error.kind, message: error.message, ...(error.resetAt ? { resetAt: error.resetAt } : {}) };
    if (error instanceof TypeError) return { kind: 'network', message: '网络失败，请检查网络后重试' };
    return { kind: 'unknown', message: error instanceof Error ? error.message : '后台任务失败' };
  }
  /** 请求失败只改错误与请求状态；不擦除缓存、源指纹、成功时间和未同步序号。 */
  function recordFailure(context: TaskContext, fullName: string, scopes: readonly DetailScope[], error: unknown): void {
    if (!writable(context, fullName)) return;
    const failure = normalizedFailure(error);
    db.transaction(() => {
      for (const scope of scopes) {
        const base = readScopeState(db, context.repoId, scope, context.accessContextRevision) ?? initialScopeState();
        const next: ScopeSyncState = { ...base, cacheStatus: base.cacheStatus === 'missing' && hasColumnData(db, context.repoId, SCOPE_COLUMNS[scope] ?? []) ? 'valid' : base.cacheStatus, freshness: deriveFreshness(ledgerOf(base), false),
          ...(context.kind === 'check' ? { checkStatus: 'error' as const, lastCheckError: failure.message, lastCheckFailure: failure } : { syncStatus: 'error' as const, lastSyncError: failure.message, lastSyncFailure: failure }) };
        writeScopeState(db, context.repoId, scope, next, context.accessContextRevision);
      }
      bumpViewVersion(db, context.repoId, clock.now().toISOString());
    })();
  }
  async function executeFull(repository: Glance, token: string, context: TaskContext): Promise<SyncTaskOutcome> {
    const loaded = await loadFullDetail(scopeFetch, token, repository, readCachedBranch(db, repository.id, context.accessContextRevision) ?? repositoryRef.findById(repository.id)?.defaultBranch ?? null,
      context.accessContextRevision, () => clock.now().toISOString(), () => writable(context, repository.fullName));
    if (!writable(context, repository.fullName)) throw new Error('任务结果已过期，放弃写入');
    const cache: DetailCache = { repositoryId: repository.id, fullName: repository.fullName,
      values: loaded.values, columns: loaded.columns, fetchedAt: clock.now().toISOString(), source: 'fresh' };
    try { if (loaded.observation) onObserved?.({ repositoryId: repository.id, accessContextRevision: context.accessContextRevision, ...loaded.observation }); } catch {}
    if (!writable(context, repository.fullName)) throw new Error('任务身份已变化，放弃写入');
    const failedScopes = Object.keys(loaded.failures) as DetailScope[];
    if (failedScopes.length > 0 && readDetailMeta(db, repository.id)?.accessContextRevision === context.accessContextRevision && readDetailMeta(db, repository.id)?.schemaVersion === DETAIL_CACHE_SCHEMA_VERSION && hasReadableDetail(db, repository.id)) throw loaded.failureErrors[failedScopes[0]!] ?? new Error(loaded.failures[failedScopes[0]!]!);
    db.transaction(() => {
      writeSyncedDetail(db, cache, context.accessContextRevision,
        REMOTE_SCOPES.filter(scope => loaded.fingerprints[scope] !== undefined).map(scope => confirmation(context, scope, loaded.fingerprints[scope])), cache.fetchedAt);
      for (const scope of failedScopes) recordFailure(context, repository.fullName, [scope], loaded.failureErrors[scope] ?? new Error(loaded.failures[scope]));
    })();
    // 摘要观察独立于内容提交；监听器故障不改变详情事务的结果。
    return { ok: failedScopes.length === 0, stored: true, error: failedScopes.length > 0 ? loaded.failureErrors[failedScopes[0]!] ?? new Error(loaded.failures[failedScopes[0]!]) : null };
  }
  async function executeBuilds(repository: Glance, token: string, context: TaskContext): Promise<void> {
    const outcome = await collectScope(scopeFetch, token, { fullName: repository.fullName, scope: 'builds',
      defaultBranch: readCachedBranch(db, repository.id, context.accessContextRevision) ?? repositoryRef.findById(repository.id)?.defaultBranch ?? null, cursor: null, limit: 30,
      accessContextRevision: context.accessContextRevision, observedAt: clock.now().toISOString() }, () => writable(context, repository.fullName));
    if (!outcome.coverageComplete || !outcome.fingerprint) throw new Error('构建范围覆盖未完成，保留旧内容和dirty');
    const items = outcome.items as BuildItem[];
    writeBuildsScope(db, repository.id, items, items[0] ?? emptyLocalBuild(), context.accessContextRevision,
      [confirmation(context, 'builds', outcome.fingerprint), confirmation(context, 'overview')], outcome.observedAt);
  }
  async function executeCheck(repository: Glance, token: string, context: TaskContext): Promise<SyncTaskOutcome> {
    const failures: Array<{ scope: DetailScope; error: unknown }> = [];
    for (const scope of Object.keys(context.targets) as DetailScope[]) {
      if (!writable(context, repository.fullName)) throw new Error('任务结果已过期，停止验证');
      const checkedAt = clock.now().toISOString();
      attempts.set(repository.id + '|' + context.accessContextRevision + '|' + scope, checkedAt);
      try {
        const result = await scopeVerify.verifyScopes(token, { fullName: repository.fullName, scope,
          defaultBranch: readCachedBranch(db, repository.id, context.accessContextRevision) ?? repositoryRef.findById(repository.id)?.defaultBranch ?? null,
          accessContextRevision: context.accessContextRevision, mode: 'reread',
          maxPages: 3, checkedAt, baselineFingerprint: context.targets[scope]?.baselineFingerprint ?? null });
        if (result.scope !== scope || result.accessContextRevision !== context.accessContextRevision) throw new Error('验证结果身份不匹配');
        if (!writable(context, repository.fullName)) throw new Error('任务结果已过期，放弃验证结果');
        db.transaction(() => {
          const base = readScopeState(db, context.repoId, scope, context.accessContextRevision);
          if (!base) return;
          const change = verificationChangeScopes(scope);
          const newEvidence = result.changed && (result.fingerprint === undefined ? !base.dirtyReasons.includes(change.reason) : result.fingerprint !== base.observedFingerprint);
          writeScopeState(db, context.repoId, scope, applyScopeVerification(base, { ...result, changedReason: change.reason }), context.accessContextRevision);
          // 关联范围只得到变化证据，不能接收来源范围的指纹或检查时间。
          if (newEvidence) for (const related of change.scopes.filter(value => value !== scope)) {
            const state = readScopeState(db, context.repoId, related, context.accessContextRevision) ?? initialScopeState();
            writeScopeState(db, context.repoId, related, applyScopeObservation(state, [change.reason]), context.accessContextRevision);
          }
          bumpViewVersion(db, context.repoId, checkedAt);
        })();
        if (result.error) failures.push({ scope, error: new PortFailure(result.error.kind, result.error.message, result.error.resetAt) });
        else if (!result.checkComplete) failures.push({ scope, error: new Error('检查窗口尚未完整覆盖，保留旧基线') });
        if (result.error?.kind === 'access_token_invalid' || result.error?.kind === 'rate_limited') break;
      } catch (error) { failures.push({ scope, error }); if (error instanceof PortFailure && (error.kind === 'access_token_invalid' || error.kind === 'rate_limited')) break; }
    }
    for (const failure of failures) recordFailure(context, repository.fullName, [failure.scope], failure.error);
    return { ok: failures.length === 0, error: failures[0]?.error ?? null };
  }
  function schedule(repositoryId: number, token: string, intent: 'open' | 'force'): ScheduledSyncTask | null {
    const repository = repositoryById(repositoryId);
    if (!repository) return null;
    const revision = accessContext.currentRevision();
    const meta = readDetailMeta(db, repositoryId);
    const valid = meta?.schemaVersion === DETAIL_CACHE_SCHEMA_VERSION && meta.accessContextRevision === revision && hasReadableDetail(db, repositoryId);
    const cacheStatus: CacheStatus = meta === null ? 'missing' : valid ? 'valid' : 'invalid';
    const states = readScopeStatesFull(db, repositoryId, revision);
    const dirtyScopes = REMOTE_SCOPES.filter(scope => states[scope] && hasUnsyncedChanges(ledgerOf(states[scope]!)));
    const dirtyReasonsByScope = Object.fromEntries(dirtyScopes.map(scope => [scope, states[scope]!.dirtyReasons]));
    const now = clock.now().toISOString();
    const expiredScopes = REMOTE_SCOPES.filter(scope => {
      const state = states[scope];
      const times = [state?.lastCheckedAt, state?.lastSyncedAt, attempts.get(repositoryId + '|' + revision + '|' + scope), meta?.fetchedAt]
        .filter((time): time is string => typeof time === 'string').sort();
      return isVerificationExpired(times.at(-1) ?? null, now, DETAIL_VERIFICATION_TTL_MS);
    });
    const baselineMissingScopes = expiredScopes.filter(scope => states[scope]?.syncedFingerprint === undefined);
    const decision = planSync({ intent, cacheStatus, changeSet: null, dirtyScopes, dirtyReasonsByScope, expiredScopes, baselineMissingScopes });
    if (decision === 'reuse-cache' || decision === 'update-summary-only' || decision === 'mark-scopes-stale') return null;
    const kind: SyncTaskState['kind'] = decision === 'force-full-fetch' ? 'force' : decision === 'background-scope-fetch' ? 'scope' : decision === 'revalidate-scopes' ? 'check' : 'open';
    const targetScopes: DetailScope[] = kind === 'scope' ? [...BUILD_SCOPE_GROUP] : kind === 'check' ? [...expiredScopes] : [...REMOTE_SCOPES];
    const prior = [...active.values()].filter(task => task.repoId === repositoryId && task.revision === revision);
    const covering = prior.find(task => targetScopes.every(scope => task.snapshot.targetScopes.includes(scope)) &&
      (intent !== 'force' || task.snapshot.kind === 'force') && (task.snapshot.kind !== 'check' || kind === 'check'));
    if (covering) return covering;
    const key = repositoryId + '|' + revision + '|' + kind + '|' + targetScopes.join(',');
    const existing = active.get(key);
    if (existing) return existing;
    const snapshot: SyncTaskState = { taskId: nextTaskId(), kind, status: 'queued', targetScopes, targetRevisions: {}, startedAt: now };
    let record: ActiveTask;
    const settled = Promise.resolve().then(async (): Promise<SyncTaskOutcome> => {
      const outcomes = await Promise.all(prior.map(task => task.settled));
      const blocked = outcomes.find(outcome => outcome.error instanceof PortFailure && (outcome.error.kind === 'access_token_invalid' || outcome.error.kind === 'rate_limited'));
      if (blocked) { active.delete(key); snapshot.status = 'error'; return blocked; }
      const taskVersion = (versions.get(repositoryId) ?? 0) + 1;
      versions.set(repositoryId, taskVersion);
      const targets: TaskContext['targets'] = {};
      const currentStates = readScopeStatesFull(db, repositoryId, revision);
      for (const scope of targetScopes) {
        targets[scope] = { targetRevision: currentStates[scope]?.detectedRevision ?? 0, baselineFingerprint: currentStates[scope]?.syncedFingerprint ?? null };
        snapshot.targetRevisions[scope] = targets[scope]!.targetRevision;
      }
      const context: TaskContext = { taskId: snapshot.taskId, repoId: repositoryId, kind, targets, accessContextRevision: revision, taskVersion, startedAt: clock.now().toISOString() };
      try {
        if (!writable(context, repository.fullName)) throw new Error('任务上下文已变化，放弃执行');
        snapshot.status = 'running';
        snapshot.startedAt = context.startedAt;
        const outcome = kind === 'open' || kind === 'force' ? await executeFull(repository, token, context)
          : kind === 'scope' ? (await executeBuilds(repository, token, context), { ok: true, error: null }) : await executeCheck(repository, token, context);
        snapshot.status = outcome.ok ? 'idle' : 'error';
        return outcome;
      } catch (error) {
        snapshot.status = 'error';
        try { recordFailure(context, repository.fullName, targetScopes, error); } catch {}
        return { ok: false, error };
      } finally { if (active.get(key) === record) active.delete(key); }
    }).catch(error => { if (active.get(key) === record) active.delete(key); return { ok: false, error }; });
    record = { key, repoId: repositoryId, revision, snapshot, settled };
    active.set(key, record);
    return record;
  }
  function snapshot(repositoryId: number): SyncTaskState | null {
    const current = accessContext.currentRevision();
    return [...active.values()].filter(task => task.repoId === repositoryId && task.revision === current).at(-1)?.snapshot ?? null;
  }
  return { schedule, snapshot };
}
