import type { LocalDatabase } from '../../../core/infra/database';
import type { DetailScope, ScopeSyncState } from '../../../../domain/types';
import type { DetailCache } from '../contract';

/** 当前详情缓存 schema；不匹配的旧缓存视为不可用，由同步流程重建。 */
export const DETAIL_CACHE_SCHEMA_VERSION = 1;

/** 缓存元信息：不含 payload，供纯状态读取与校验使用。 */
export interface DetailCacheMeta {
  fetchedAt: string;
  schemaVersion: number;
  accessContextRevision: number;
}

export function readDetailMeta(db: LocalDatabase, repositoryId: number): DetailCacheMeta | null {
  const row = db.prepare(
    'SELECT fetched_at, schema_version, access_context_revision FROM detail_cache WHERE repository_id = ?',
  ).get(repositoryId) as { fetched_at: string; schema_version: number; access_context_revision: number } | undefined;
  if (!row) return null;
  return { fetchedAt: row.fetched_at, schemaVersion: row.schema_version, accessContextRevision: row.access_context_revision };
}

export function readDetail(db: LocalDatabase, repositoryId: number): DetailCache | null {
  const row = db.prepare('SELECT payload, fetched_at FROM detail_cache WHERE repository_id = ?').get(repositoryId) as { payload: string; fetched_at: string } | undefined;
  if (!row) return null;
  try { return { ...(JSON.parse(row.payload) as DetailCache), fetchedAt: row.fetched_at }; } catch { return null; }
}

export function writeDetail(db: LocalDatabase, cache: DetailCache, accessContextRevision: number): void {
  const write = db.transaction(() => {
    db.prepare('INSERT INTO detail_cache (repository_id, payload, fetched_at, source_updated_at, schema_version, access_context_revision) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, source_updated_at = excluded.source_updated_at, schema_version = excluded.schema_version, access_context_revision = excluded.access_context_revision')
      .run(cache.repositoryId, JSON.stringify(cache), cache.fetchedAt, cache.fetchedAt, DETAIL_CACHE_SCHEMA_VERSION, accessContextRevision);
    const upsert = db.prepare('INSERT INTO detail_column (repository_id, column_name, state, payload, error_kind, error_message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, column_name) DO UPDATE SET state = excluded.state, payload = excluded.payload, error_kind = excluded.error_kind, error_message = excluded.error_message, updated_at = excluded.updated_at');
    for (const [name, column] of Object.entries(cache.columns)) {
      upsert.run(cache.repositoryId, name, column?.status ?? 'unsupported', column?.value === null || column?.value === undefined ? null : JSON.stringify(column.value), column?.error?.kind ?? null, column?.error?.message ?? null, cache.fetchedAt);
    }
    bumpViewVersion(db, cache.repositoryId, cache.fetchedAt);
  });
  write();
}

export function deleteDetail(db: LocalDatabase, repositoryId: number): void {
  db.prepare('DELETE FROM detail_cache WHERE repository_id = ?').run(repositoryId);
  db.prepare('DELETE FROM detail_column WHERE repository_id = ?').run(repositoryId);
}

export function clearDetails(db: LocalDatabase): void {
  db.prepare('DELETE FROM detail_cache').run();
  db.prepare('DELETE FROM detail_column').run();
}

// —— 范围账本、本地视图版本与观察应用记录（步骤 7） ——

interface ScopeStateRow {
  scope: string;
  cache_status: ScopeSyncState['cacheStatus'];
  freshness: ScopeSyncState['freshness'];
  check_status: ScopeSyncState['checkStatus'];
  sync_status: ScopeSyncState['syncStatus'];
  detected_revision: number;
  synced_revision: number;
  important_revision: number;
  viewed_revision: number;
  dirty_reasons: string;
  observed_fingerprint: string | null;
  synced_fingerprint: string | null;
  last_checked_at: string | null;
  last_synced_at: string | null;
  last_check_error: string | null;
  last_sync_error: string | null;
}

function rowToScopeState(row: ScopeStateRow): ScopeSyncState {
  let dirtyReasons: string[] = [];
  try {
    const parsed = JSON.parse(row.dirty_reasons) as unknown;
    if (Array.isArray(parsed)) dirtyReasons = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    dirtyReasons = [];
  }
  return {
    cacheStatus: row.cache_status,
    freshness: row.freshness,
    checkStatus: row.check_status,
    syncStatus: row.sync_status,
    detectedRevision: row.detected_revision,
    syncedRevision: row.synced_revision,
    importantRevision: row.important_revision,
    viewedRevision: row.viewed_revision,
    dirtyReasons,
    ...(typeof row.observed_fingerprint === 'string' ? { observedFingerprint: row.observed_fingerprint } : {}),
    ...(typeof row.synced_fingerprint === 'string' ? { syncedFingerprint: row.synced_fingerprint } : {}),
    ...(row.last_checked_at !== null ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(row.last_synced_at !== null ? { lastSyncedAt: row.last_synced_at } : {}),
    ...(row.last_check_error !== null ? { lastCheckError: row.last_check_error } : {}),
    ...(row.last_sync_error !== null ? { lastSyncError: row.last_sync_error } : {}),
  };
}

export function readScopeStates(db: LocalDatabase, repositoryId: number, accessContextRevision: number): Partial<Record<DetailScope, ScopeSyncState>> {
  const rows = db.prepare('SELECT scope, cache_status, freshness, check_status, sync_status, detected_revision, synced_revision, important_revision, viewed_revision, dirty_reasons, last_checked_at, last_synced_at, last_check_error, last_sync_error FROM detail_scope_state WHERE repository_id = ? AND access_context_revision = ?').all(repositoryId, accessContextRevision) as ScopeStateRow[];
  const result: Partial<Record<DetailScope, ScopeSyncState>> = {};
  for (const row of rows) result[row.scope as DetailScope] = rowToScopeState(row);
  return result;
}

export function readScopeState(db: LocalDatabase, repositoryId: number, scope: DetailScope, accessContextRevision: number): ScopeSyncState | null {
  const row = db.prepare('SELECT * FROM detail_scope_state WHERE repository_id = ? AND scope = ? AND access_context_revision = ?').get(repositoryId, scope, accessContextRevision) as ScopeStateRow | undefined;
  return row ? rowToScopeState(row) : null;
}

export function writeScopeState(db: LocalDatabase, repositoryId: number, scope: DetailScope, state: ScopeSyncState, accessContextRevision: number): void {
  db.prepare(
    `INSERT INTO detail_scope_state (
       repository_id, scope, cache_status, freshness, check_status, sync_status,
       detected_revision, synced_revision, important_revision, viewed_revision, dirty_reasons,
       observed_fingerprint, synced_fingerprint, last_checked_at, last_synced_at, last_check_error, last_sync_error, access_context_revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_id, scope) DO UPDATE SET
       cache_status = excluded.cache_status, freshness = excluded.freshness,
       check_status = excluded.check_status, sync_status = excluded.sync_status,
       detected_revision = excluded.detected_revision, synced_revision = excluded.synced_revision,
       important_revision = excluded.important_revision, viewed_revision = excluded.viewed_revision,
       dirty_reasons = excluded.dirty_reasons, observed_fingerprint = excluded.observed_fingerprint,
       synced_fingerprint = excluded.synced_fingerprint, last_checked_at = excluded.last_checked_at,
       last_synced_at = excluded.last_synced_at, last_check_error = excluded.last_check_error,
       last_sync_error = excluded.last_sync_error, access_context_revision = excluded.access_context_revision`,
  ).run(
    repositoryId, scope, state.cacheStatus, state.freshness, state.checkStatus, state.syncStatus,
    state.detectedRevision, state.syncedRevision, state.importantRevision, state.viewedRevision, JSON.stringify(state.dirtyReasons),
    state.observedFingerprint ?? null, state.syncedFingerprint ?? null, state.lastCheckedAt ?? null,
    state.lastSyncedAt ?? null, state.lastCheckError ?? null, state.lastSyncError ?? null, accessContextRevision,
  );
}

/** 本地视图版本：每次成功写入本地资料（内容或账本）后递增，供展示层比对是否重读。 */
export function readViewVersion(db: LocalDatabase, repositoryId: number): number {
  const row = db.prepare('SELECT view_version FROM detail_view_state WHERE repository_id = ?').get(repositoryId) as { view_version: number } | undefined;
  return row?.view_version ?? 0;
}

export function bumpViewVersion(db: LocalDatabase, repositoryId: number, updatedAt: string): number {
  db.prepare(
    'INSERT INTO detail_view_state (repository_id, view_version, updated_at) VALUES (?, 1, ?) ON CONFLICT(repository_id) DO UPDATE SET view_version = view_version + 1, updated_at = excluded.updated_at',
  ).run(repositoryId, updatedAt);
  return readViewVersion(db, repositoryId);
}

export function hasObservationApply(db: LocalDatabase, repositoryId: number, observationId: string): boolean {
  const row = db.prepare('SELECT 1 AS applied FROM detail_observation_apply WHERE repository_id = ? AND observation_id = ?').get(repositoryId, observationId);
  return row !== undefined;
}

export function insertObservationApply(
  db: LocalDatabase,
  entry: { observationId: string; repositoryId: number; appliedAt: string; accessContextRevision: number; affectedScopes: readonly DetailScope[] },
): void {
  db.prepare(
    'INSERT INTO detail_observation_apply (observation_id, repository_id, applied_at, access_context_revision, affected_scopes) VALUES (?, ?, ?, ?, ?)',
  ).run(entry.observationId, entry.repositoryId, entry.appliedAt, entry.accessContextRevision, JSON.stringify(entry.affectedScopes));
}
