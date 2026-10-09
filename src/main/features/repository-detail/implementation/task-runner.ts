import { PortFailure, type AccessContextPort, type GitHubPort, type RepositoryRefPort, type ScopeFetchPort, type ScopeVerificationPort } from '../../../../domain/ports';
import type { BuildItem, CacheStatus, ContentVersion, DetailScope, Glance, RepositoryCapabilities, ScopeSyncState, TaskContext } from '../../../../domain/types';
import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import { BUILD_SCOPE_GROUP, planSync } from '../../../../domain/rules/sync-plan';
import { DETAIL_SYNC_SCOPES, SCOPE_COLUMNS } from '../../../../domain/rules/detail-scope';
import { DETAIL_VERIFICATION_TTL_MS, isVerificationExpired } from '../../../../domain/rules/refresh-window';
import { coversSourceTarget, sourceTargetConflicts } from '../../../../domain/rules/source-coverage';
import { canCommitTaskResult, deriveFreshness, hasUnsyncedChanges, ledgerOf } from '../../../../domain/rules/scope-ledger';
import { applyScopeObservation, applyScopeVerification, initialScopeState, verificationChangeScopes } from '../../../../domain/rules/observation-application';
import { emptyLocalBuild } from '../../../../domain/rules/local-read';
import type { DetailCache, DetailObservation, SourceTargetMismatch, SourceTargetRecoveryOutcome, SyncTaskState } from '../contract';
import { DETAIL_CACHE_SCHEMA_VERSION, bumpViewVersion, readDetailMeta, readScopeState, readScopeStatesFull, writeBuildsScope, writeScopeContents, writeSyncedDetail, writeScopeState, readCachedBranch, hasColumnData, type ScopeConfirmationWrite, type ScopeContentWrite } from './detail-store';
import { hasReadableDetail, readLocalColumns } from './local-detail-store';
import { clearStagedScope, pendingStagedScopes, pruneForeignStagedScopes, pruneStagedQueries, readStagedScope, writeStagedScope } from './staged-scope';
import { collectScope, loadFullDetail, type OpenScopeStaging, type ScopeStaging } from './refresh-detail';

export interface SyncTaskOutcome { ok: boolean; error: unknown; stored?: boolean; sourceTargetMismatch?: Partial<ContentVersion>; /** 验证发现变化时，同一次打开流程内需要安排的后继同步。 */ followUp?: boolean; }
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
  recoverSourceTarget?(mismatch: SourceTargetMismatch): Promise<SourceTargetRecoveryOutcome>;
}
interface ActiveTask extends ScheduledSyncTask { repoId: number; revision: number; key: string; }

export function createSyncTaskRunner({ db, clock, repositoryById, repositoryRef, accessContext, scopeVerify, scopeFetch, nextTaskId, onObserved, recoverSourceTarget }: SyncTaskDependencies): SyncTaskRunner {
  const active = new Map<string, ActiveTask>();
  const versions = new Map<number, number>();
  const attempts = new Map<string, string>();
  function cachedCapabilities(repositoryId: number, revision: number): RepositoryCapabilities | undefined {
    const row = db.prepare("SELECT json_extract(payload, '$.values.metadata.capabilities') AS capabilities FROM detail_cache WHERE repository_id = ? AND access_context_revision = ? AND schema_version = ? AND json_valid(payload)")
      .get(repositoryId, revision, DETAIL_CACHE_SCHEMA_VERSION) as { capabilities: string | null } | undefined;
    if (!row?.capabilities) return undefined;
    try {
      const parsed = JSON.parse(row.capabilities) as RepositoryCapabilities;
      return parsed && ['enabled', 'disabled', 'unknown'].includes(parsed.issues) && ['enabled', 'disabled', 'unknown'].includes(parsed.pullRequests) ? parsed : undefined;
    } catch { return undefined; }
  }
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
  /** 按范围给出暂存句柄：身份含仓库、默认分支、每页上限、访问上下文与 schema，参数漂移即不可接续。 */
  function scopeStaging(repositoryId: number, context: TaskContext, scope: DetailScope, params: { fullName: string; defaultBranch: string | null; limit: number; targetVersion?: Partial<ContentVersion> }): ScopeStaging {
    const query = { scope, fullName: params.fullName, defaultBranch: params.defaultBranch, limit: params.limit,
      targetVersion: params.targetVersion,
      accessContextRevision: context.accessContextRevision, schemaVersion: DETAIL_CACHE_SCHEMA_VERSION };
    pruneStagedQueries(db, repositoryId, query);
    return {
      read: () => readStagedScope(db, repositoryId, query),
      save: state => writeStagedScope(db, repositoryId, query, state, clock.now().toISOString()),
      clear: () => clearStagedScope(db, repositoryId, scope),
    };
  }
  async function executeFull(repository: Glance, token: string, context: TaskContext): Promise<SyncTaskOutcome> {
    // Token 更换或 schema 升级后旧上下文的暂存不得回填。
    pruneForeignStagedScopes(db, repository.id, context.accessContextRevision, DETAIL_CACHE_SCHEMA_VERSION);
    const openStaging: OpenScopeStaging = (scope, params) => scopeStaging(repository.id, context, scope, params);
    const states = readScopeStatesFull(db, repository.id, context.accessContextRevision);
    const loaded = await loadFullDetail(scopeFetch, token, repository, readCachedBranch(db, repository.id, context.accessContextRevision) ?? repositoryRef.findById(repository.id)?.defaultBranch ?? null,
      context.accessContextRevision, () => clock.now().toISOString(), () => writable(context, repository.fullName), openStaging,
      observation => onObserved?.({ observationId: `detail:${context.taskId}:overview`, repositoryId: repository.id, accessContextRevision: context.accessContextRevision, ...observation }), context.targets,
      DETAIL_SYNC_SCOPES.filter(scope => (context.targets[scope]?.targetRevision ?? 0) > (states[scope]?.syncedRevision ?? 0)),
      Object.fromEntries(DETAIL_SYNC_SCOPES.flatMap(scope => states[scope]?.verificationProgress !== undefined ? [[scope, states[scope]!.verificationProgress]] : [])));
    if (!writable(context, repository.fullName)) throw new Error('任务结果已过期，放弃写入');
    const cache: DetailCache = { repositoryId: repository.id, fullName: repository.fullName,
      values: loaded.values, columns: loaded.columns, fetchedAt: clock.now().toISOString(), source: 'fresh' };
    if (!writable(context, repository.fullName)) throw new Error('任务身份已变化，放弃写入');
    const failedScopes = Object.keys(loaded.failures) as DetailScope[];
    const syncedAt = cache.fetchedAt;
    const meta = readDetailMeta(db, repository.id);
    const validCache = meta !== null && meta.schemaVersion === DETAIL_CACHE_SCHEMA_VERSION && meta.accessContextRevision === context.accessContextRevision && hasReadableDetail(db, repository.id);
    const hasContent = loaded.deliveries.some(delivery => Object.keys(delivery.values).length > 0);
    // 只有全部常规详情范围完整覆盖、且没有范围仍在暂存时才算一轮完整详情；否则完整成功时间保持旧值/未知。
    const complete = failedScopes.length === 0 && loaded.stagedScopes.length === 0;
    // 成功范围（含来源级成功栏目）与失败错误在同一事务提交；失败范围保留旧值、旧成功时间与 dirty。
    const write = db.transaction(() => {
      if (validCache) {
        const writes: ScopeContentWrite[] = loaded.deliveries.filter(delivery => Object.keys(delivery.values).length > 0).map(delivery => ({
            scope: delivery.scope,
            values: delivery.values,
            columns: delivery.columns,
            ...(delivery.complete && delivery.fingerprint !== undefined ? { confirmation: confirmation(context, delivery.scope, delivery.fingerprint) } : {}),
          }));
        const previousColumns = readLocalColumns(db, repository.id);
        // 本轮权威能力已不再禁用的失败来源，不能继续沿用旧unsupported标签；内容与基线仍保留。
        for (const name of ['issues', 'pullRequests'] as const) {
          const availability = loaded.values.metadata?.capabilities?.[name];
          const failedColumn = loaded.columns[name];
          if (availability === undefined || availability === 'disabled' || previousColumns[name]?.status !== 'unsupported' || failedColumn?.status !== 'failed') continue;
          let entry = writes.find(value => value.scope === 'issuesAndPr');
          if (!entry) { entry = { scope: 'issuesAndPr', values: {}, columns: {} }; writes.push(entry); }
          entry.columns[name] = failedColumn;
        }
        writeScopeContents(db, repository.id, context.accessContextRevision, writes, syncedAt, complete);
      } else if (hasContent) {
        // 无有效旧缓存但取得部分内容：建立缓存；失败范围明示错误，不确认其覆盖。
        writeSyncedDetail(db, cache, context.accessContextRevision,
          loaded.deliveries.filter(delivery => delivery.complete && delivery.fingerprint !== undefined).map(delivery => confirmation(context, delivery.scope, delivery.fingerprint)), syncedAt, complete);
      }
      // 未取得任何内容的首次获取不建立缓存；失败与错误仍完整记录。
      for (const scope of failedScopes) recordFailure(context, repository.fullName, [scope], loaded.failureErrors[scope] ?? new Error(loaded.failures[scope]));
    });
    write();
    const blockingError = loaded.blocked ? new PortFailure(loaded.blocked.kind, loaded.blocked.message, loaded.blocked.resetAt) : null;
    const first = failedScopes[0];
    return { ok: failedScopes.length === 0, stored: hasContent,
      ...(!blockingError && loaded.sourceTargetMismatch ? { sourceTargetMismatch: loaded.sourceTargetMismatch } : {}),
      error: blockingError ?? (first ? loaded.failureErrors[first] ?? new Error(loaded.failures[first]) : null) };
  }
  async function executeBuilds(repository: Glance, token: string, context: TaskContext): Promise<void> {
    pruneForeignStagedScopes(db, repository.id, context.accessContextRevision, DETAIL_CACHE_SCHEMA_VERSION);
    const sourceVersion = context.targets.builds?.sourceVersion;
    const defaultBranch = sourceVersion?.defaultBranch !== undefined ? sourceVersion.defaultBranch : readCachedBranch(db, repository.id, context.accessContextRevision) ?? repositoryRef.findById(repository.id)?.defaultBranch ?? null;
    const collected = await collectScope(scopeFetch, token, { fullName: repository.fullName, scope: 'builds', defaultBranch, cursor: null, limit: 30,
      targetVersion: sourceVersion, capabilities: cachedCapabilities(repository.id, context.accessContextRevision),
      baselineFingerprint: context.targets.builds?.baselineFingerprint ?? null,
      verificationProgress: readScopeState(db, repository.id, 'builds', context.accessContextRevision)?.verificationProgress,
      accessContextRevision: context.accessContextRevision, observedAt: clock.now().toISOString() },
      () => writable(context, repository.fullName), scopeStaging(repository.id, context, 'builds', { fullName: repository.fullName, defaultBranch, limit: 30, targetVersion: sourceVersion }));
    // 本轮未完成但有可续读暂存：保持 dirty，下一批继续；不记录错误、不触碰旧构建内容。
    if (collected.staged) return;
    if (collected.blocked) throw new PortFailure(collected.blocked.kind, collected.blocked.message, collected.blocked.resetAt);
    const outcome = collected.outcome;
    if (!outcome.coverageComplete || !outcome.fingerprint) throw new Error('构建范围覆盖未完成，保留旧内容和dirty');
    if (!coversSourceTarget('builds', sourceVersion, outcome.version, (context.targets.builds?.targetRevision ?? 0) > (readScopeState(db, repository.id, 'builds', context.accessContextRevision)?.syncedRevision ?? 0))) throw new Error('构建默认分支未覆盖任务目标，保留旧内容和dirty');
    const items = outcome.items as BuildItem[];
    writeBuildsScope(db, repository.id, items, items[0] ?? emptyLocalBuild(), context.accessContextRevision,
      [confirmation(context, 'builds', outcome.fingerprint), confirmation(context, 'overview')], outcome.observedAt);
  }
  async function executeCheck(repository: Glance, token: string, context: TaskContext): Promise<SyncTaskOutcome> {
    const failures: Array<{ scope: DetailScope; error: unknown }> = [];
    const capabilities = cachedCapabilities(repository.id, context.accessContextRevision);
    let blocked = false;
    for (const scope of Object.keys(context.targets) as DetailScope[]) {
      if (!writable(context, repository.fullName)) throw new Error('任务结果已过期，停止验证');
      const checkedAt = clock.now().toISOString();
      attempts.set(repository.id + '|' + context.accessContextRevision + '|' + scope, checkedAt);
      try {
        const result = await scopeVerify.verifyScopes(token, { fullName: repository.fullName, scope,
          defaultBranch: readCachedBranch(db, repository.id, context.accessContextRevision) ?? repositoryRef.findById(repository.id)?.defaultBranch ?? null,
          accessContextRevision: context.accessContextRevision, mode: 'reread',
          verificationProgress: readScopeState(db, repository.id, scope, context.accessContextRevision)?.verificationProgress,
          capabilities,
          maxPages: 3, checkedAt, baselineFingerprint: context.targets[scope]?.baselineFingerprint ?? null });
        if (result.scope !== scope || result.accessContextRevision !== context.accessContextRevision) throw new Error('验证结果身份不匹配');
        if (!writable(context, repository.fullName)) throw new Error('任务结果已过期，放弃验证结果');
        db.transaction(() => {
          const base = readScopeState(db, context.repoId, scope, context.accessContextRevision);
          if (!base) return;
          const change = verificationChangeScopes(scope);
          const newEvidence = result.changed && (result.fingerprint === undefined ? !base.dirtyReasons.includes(change.reason) : result.fingerprint !== base.observedFingerprint);
          const verified = applyScopeVerification(base, { ...result, changedReason: change.reason });
          const next = result.verificationProgress === undefined ? verified : { ...verified, verificationProgress: result.verificationProgress ?? undefined };
          writeScopeState(db, context.repoId, scope, next, context.accessContextRevision);
          // 关联范围只得到变化证据，不能接收来源范围的指纹或检查时间。
          if (newEvidence) for (const related of change.scopes.filter(value => value !== scope)) {
            const state = readScopeState(db, context.repoId, related, context.accessContextRevision) ?? initialScopeState();
            writeScopeState(db, context.repoId, related, applyScopeObservation(state, [change.reason]), context.accessContextRevision);
          }
          bumpViewVersion(db, context.repoId, checkedAt);
        })();
        if (result.error) failures.push({ scope, error: new PortFailure(result.error.kind, result.error.message, result.error.resetAt) });
        else if (!result.checkComplete) failures.push({ scope, error: new Error('检查窗口尚未完整覆盖，保留旧基线') });
        if (result.error?.kind === 'access_token_invalid' || result.error?.kind === 'rate_limited') { blocked = true; break; }
      } catch (error) { failures.push({ scope, error }); if (error instanceof PortFailure && (error.kind === 'access_token_invalid' || error.kind === 'rate_limited')) { blocked = true; break; } }
    }
    for (const failure of failures) recordFailure(context, repository.fullName, [failure.scope], failure.error);
    // 验证发现变化后，同一次打开流程内安排至多一个兼容后继同步；后续动作仍由 domain 计划按账本目标决定。
    // 令牌无效或限流时不再追加请求，避免无界重试。
    const states = readScopeStatesFull(db, repository.id, context.accessContextRevision);
    const followUp = !blocked && DETAIL_SYNC_SCOPES.some(scope => { const state = states[scope]; return state !== undefined && hasUnsyncedChanges(ledgerOf(state)); });
    return { ok: failures.length === 0, error: failures[0]?.error ?? null, followUp };
  }
  function schedule(repositoryId: number, token: string, intent: 'open' | 'force'): ScheduledSyncTask | null {
    const repository = repositoryById(repositoryId);
    if (!repository) return null;
    const revision = accessContext.currentRevision();
    const meta = readDetailMeta(db, repositoryId);
    const valid = meta?.schemaVersion === DETAIL_CACHE_SCHEMA_VERSION && meta.accessContextRevision === revision && hasReadableDetail(db, repositoryId);
    const cacheStatus: CacheStatus = meta === null ? 'missing' : valid ? 'valid' : 'invalid';
    const states = readScopeStatesFull(db, repositoryId, revision);
    // 仍有暂存进度的范围同样属于"未同步工作"：下一批从续读点继续，而不是永久从头重读。
    const stagedScopes = pendingStagedScopes(db, repositoryId, revision, DETAIL_CACHE_SCHEMA_VERSION);
    const dirtyScopes = DETAIL_SYNC_SCOPES.filter(scope => stagedScopes.includes(scope) || (states[scope] !== undefined && hasUnsyncedChanges(ledgerOf(states[scope]!))));
    const dirtyReasonsByScope = Object.fromEntries(dirtyScopes.map(scope => [scope,
      [...new Set([...(states[scope]?.dirtyReasons ?? []), ...(stagedScopes.includes(scope) ? ['staged'] : [])])]]));
    const now = clock.now().toISOString();
    const expiredScopes = DETAIL_SYNC_SCOPES.filter(scope => {
      const state = states[scope];
      const times = [state?.lastCheckedAt, state?.lastSyncedAt, attempts.get(repositoryId + '|' + revision + '|' + scope), meta?.fetchedAt]
        .filter((time): time is string => typeof time === 'string').sort();
      return isVerificationExpired(times.at(-1) ?? null, now, DETAIL_VERIFICATION_TTL_MS);
    });
    const baselineMissingScopes = expiredScopes.filter(scope => states[scope]?.syncedFingerprint === undefined);
    const decision = planSync({ intent, cacheStatus, changeSet: null, dirtyScopes, dirtyReasonsByScope, expiredScopes, baselineMissingScopes });
    if (decision === 'reuse-cache' || decision === 'update-summary-only' || decision === 'mark-scopes-stale') return null;
    const kind: SyncTaskState['kind'] = decision === 'force-full-fetch' ? 'force' : decision === 'background-scope-fetch' ? 'scope' : decision === 'revalidate-scopes' ? 'check' : 'open';
    const targetScopes: DetailScope[] = kind === 'scope' ? [...BUILD_SCOPE_GROUP] : kind === 'check' ? [...expiredScopes] : [...DETAIL_SYNC_SCOPES];
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
      const captureTargets = (): TaskContext['targets'] => {
        const targets: TaskContext['targets'] = {};
        const currentStates = readScopeStatesFull(db, repositoryId, revision);
        const sourceVersion = repositoryRef.findById(repositoryId)?.contentVersion;
        for (const scope of targetScopes) {
          targets[scope] = { targetRevision: currentStates[scope]?.detectedRevision ?? 0, baselineFingerprint: currentStates[scope]?.syncedFingerprint ?? null, ...(sourceVersion !== undefined ? { sourceVersion: { ...sourceVersion } } : {}) };
          snapshot.targetRevisions[scope] = targets[scope]!.targetRevision;
        }
        return targets;
      };
      let context: TaskContext = { taskId: snapshot.taskId, repoId: repositoryId, kind, targets: captureTargets(), accessContextRevision: revision, taskVersion, startedAt: clock.now().toISOString() };
      try {
        if (!writable(context, repository.fullName)) throw new Error('任务上下文已变化，放弃执行');
        snapshot.status = 'running';
        snapshot.startedAt = context.startedAt;
        let outcome: SyncTaskOutcome = kind === 'open' || kind === 'force' ? await executeFull(repository, token, context)
          : kind === 'scope' ? (await executeBuilds(repository, token, context), { ok: true, error: null }) : await executeCheck(repository, token, context);
        if (outcome.sourceTargetMismatch && recoverSourceTarget && writable(context, repository.fullName)) {
          const targetVersion = context.targets.overview?.sourceVersion ?? {};
          const conflicts = sourceTargetConflicts('overview', targetVersion, outcome.sourceTargetMismatch);
          const recovery = await recoverSourceTarget({ repositoryId, fullName: repository.fullName,
            accessContextRevision: revision, targetVersion, actualVersion: outcome.sourceTargetMismatch });
          if (!writable(context, repository.fullName)) throw new Error('源目标恢复期间仓库或访问上下文已变化，放弃重试');
          const refreshedVersion = repositoryRef.findById(repositoryId)?.contentVersion;
          const changed = conflicts.some(field => refreshedVersion?.[field] !== undefined && refreshedVersion[field] !== targetVersion[field]);
          if (recovery.refreshed && changed && recovery.error?.kind !== 'access_token_invalid' && recovery.error?.kind !== 'rate_limited') {
            // 保持原任务登记和写入版本，重读全部账本目标；第二轮观察使用独立身份，最多重抓一次。
            context = { ...context, taskId: `${snapshot.taskId}:source-retry`, targets: captureTargets(), startedAt: clock.now().toISOString() };
            const retried = await executeFull(repository, token, context);
            outcome = { ...retried, stored: outcome.stored === true || retried.stored === true };
          } else if (recovery.error) {
            const error = new PortFailure(recovery.error.kind, recovery.error.message, recovery.error.resetAt);
            recordFailure(context, repository.fullName, ['overview'], error);
            outcome = { ...outcome, error };
          }
        }
        snapshot.status = outcome.ok ? 'idle' : 'error';
        // 验证发现变化：在释放本任务登记之前同步登记后继同步（重新读取账本目标、遵循 domain 计划），
        // 页面轮询不会看到任务快照间隙；上下文或仓库已变化时不再追加。
        if (kind === 'check' && outcome.followUp === true && writable(context, repository.fullName)) {
          try { schedule(repositoryId, token, 'open'); } catch { /* 后继登记失败不改变本次验证结果与账本 */ }
        }
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
