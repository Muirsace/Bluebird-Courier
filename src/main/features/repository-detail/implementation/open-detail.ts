import type { DetailScope, DetailValues, Glance, NormalizedError, ScopeSyncState } from '../../../../domain/types';
import { COLUMN_SCOPE, SCOPE_ORDER } from '../../../../domain/rules/detail-scope';
import { emptyLocalBuild, localReadCursor, localReadLimit, localReadOffset, selectedLocalScopes } from '../../../../domain/rules/local-read';
import { initialScopeState } from '../../../../domain/rules/observation-application';
import type { LocalDetailView, LocalReadRequest, SyncTaskState } from '../contract';
import { DETAIL_CACHE_SCHEMA_VERSION, type DetailCacheMeta } from './detail-store';
import type { LocalScopePage } from './local-detail-store';

export interface LocalViewInput {
  cacheMeta: DetailCacheMeta | null;
  corrupted: boolean;
  currentAccessContextRevision: number;
  scopeStates: Partial<Record<DetailScope, ScopeSyncState>>;
  viewVersion: number;
  columns: LocalDetailView['columns'];
  /** 当前上下文内的在途任务快照；无任务为 null（不返回虚假 running / queued）。 */
  task: SyncTaskState | null;
  readScope(scope: DetailScope, offset: number, limit: number): LocalScopePage;
}

/** 组装有界本地视图；每个范围独立失败，状态读取不触碰任何内容。 */
export function buildLocalView(repository: Glance, input: LocalViewInput, request: LocalReadRequest): LocalDetailView {
  const mode = request.mode === 'status' ? 'status' : 'view';
  let error: NormalizedError | null = null;
  let cacheStatus: ScopeSyncState['cacheStatus'] = input.cacheMeta ? 'valid' : 'missing';
  const failure = (message: string): NormalizedError => ({ kind: 'unknown', message, fullName: repository.fullName });
  if (input.cacheMeta?.schemaVersion !== undefined && input.cacheMeta.schemaVersion !== DETAIL_CACHE_SCHEMA_VERSION) {
    cacheStatus = 'invalid'; error = failure('详情缓存 schema 不兼容，需重新同步');
  } else if (input.cacheMeta && input.cacheMeta.accessContextRevision !== input.currentAccessContextRevision) {
    cacheStatus = 'invalid'; error = failure('详情缓存属于其他访问上下文，暂不可展示');
  } else if (mode === 'view' && input.corrupted) {
    cacheStatus = 'invalid'; error = failure('详情缓存损坏，需重新同步');
  }
  const selected = selectedLocalScopes(request.scopes);
  if (selected.every(scope => scope === 'trends')) error = null;
  const scopes: LocalDetailView['scopes'] = {};
  for (const scope of SCOPE_ORDER) {
    const present = Object.entries(input.columns).some(([name, column]) => COLUMN_SCOPE[name as keyof typeof COLUMN_SCOPE] === scope && (column?.status === 'success' || column?.status === 'empty'));
    const base = input.scopeStates[scope] ?? initialScopeState(present ? 'valid' : 'missing');
    scopes[scope] = { ...base, cacheStatus: cacheStatus === 'valid' ? base.cacheStatus : cacheStatus };
  }
  for (const scope of input.task?.targetScopes ?? []) {
    scopes[scope] = { ...scopes[scope]!, ...(input.task?.kind === 'check' ? { checkStatus: input.task.status } : { syncStatus: input.task!.status }) };
  }
  for (const state of Object.values(scopes)) {
    if (state?.syncStatus === 'error' && state.lastSyncError) error ??= state.lastSyncFailure ?? failure(state.lastSyncError);
    if (state?.checkStatus === 'error' && state.lastCheckError) error ??= state.lastCheckFailure ?? failure(state.lastCheckError);
  }
  const base = { repository, values: null, columns: {}, viewVersion: input.viewVersion,
    accessContextRevision: input.currentAccessContextRevision, scopes, task: input.task, truncated: false, error };
  if (mode === 'status' || cacheStatus !== 'valid') return base;

  const identity = { repositoryId: repository.id, accessContextRevision: input.currentAccessContextRevision,
    viewVersion: input.viewVersion, fetchedAt: input.cacheMeta!.fetchedAt };
  const limit = localReadLimit(request.itemLimit);
  const values: DetailValues = { releases: [], commits: [], issues: [], pullRequests: [], builds: [],
    tags: [], readmes: [], tree: [], build: emptyLocalBuild() };
  const cursors: LocalDetailView['cursors'] = {};
  const columns: LocalDetailView['columns'] = {};
  let truncated = false;
  for (const scope of selected) {
    if (scope === 'trends') continue;
    const offset = localReadOffset(request.cursors?.[scope], scope, identity);
    if (offset === null) {
      error ??= failure(scope + ' 本地续读游标已失效，请重新读取该范围');
      continue;
    }
    try {
      const page = input.readScope(scope, offset, limit);
      Object.assign(values, page.values);
      scopes[scope] = { ...scopes[scope]!, cacheStatus: page.missing ? 'missing' : 'valid' };
      if (page.hasMore) { truncated = true; cursors[scope] = localReadCursor(scope, offset + page.count, identity); }
      for (const [name, column] of Object.entries(input.columns)) {
        if (COLUMN_SCOPE[name as keyof typeof COLUMN_SCOPE] === scope) columns[name as keyof typeof columns] = column;
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '内容不可用';
      error ??= failure(scope + ' 缓存损坏：' + message);
      scopes[scope] = { ...scopes[scope]!, cacheStatus: 'invalid' };
    }
  }
  return { ...base, values, columns, truncated, error,
    ...(Object.keys(cursors).length > 0 ? { cursors } : {}) };
}
