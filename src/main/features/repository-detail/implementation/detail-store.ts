import type { LocalDatabase } from '../../../core/infra/database';
import type { BuildInfo, BuildItem, DetailScope, DetailValues, ScopeSyncState } from '../../../../domain/types';
import { applyScopeSync } from '../../../../domain/rules/scope-ledger';
import { initialScopeState } from '../../../../domain/rules/observation-application';
import type { ColumnName, ColumnResult, DetailCache } from '../contract';

/** 当前详情缓存 schema；不匹配的旧缓存视为不可用，由同步流程重建。 */
export const DETAIL_CACHE_SCHEMA_VERSION = 1;

/** 缓存元信息：不含 payload，供纯状态读取与校验使用。 */
export interface DetailCacheMeta {
  /** 缓存身份/最近写入时间；用于本地续读身份与验证有效期回退，不代表完整详情成功时间。 */
  fetchedAt: string;
  /** 最近一次全部远端范围完整覆盖的时间；null 表示还没有可信的完整详情（旧库或首次部分成功）。 */
  completeFetchedAt: string | null;
  schemaVersion: number;
  accessContextRevision: number;
}

export function readDetailMeta(db: LocalDatabase, repositoryId: number): DetailCacheMeta | null {
  const row = db.prepare(
    'SELECT fetched_at, complete_fetched_at, schema_version, access_context_revision FROM detail_cache WHERE repository_id = ?',
  ).get(repositoryId) as { fetched_at: string; complete_fetched_at: string | null; schema_version: number; access_context_revision: number } | undefined;
  if (!row) return null;
  return { fetchedAt: row.fetched_at, completeFetchedAt: row.complete_fetched_at, schemaVersion: row.schema_version, accessContextRevision: row.access_context_revision };
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

// —— 成功同步的原子写入（步骤 8A）：数据、覆盖基线、范围确认与视图版本同事务 ——

/** 单范围的确认写入：目标序号与适配器指纹；covered=false 时不改动账本。 */
export interface ScopeConfirmationWrite {
  scope: DetailScope;
  targetRevision: number;
  covered: boolean;
  fingerprint?: string;
}

function applyConfirmations(
  db: LocalDatabase,
  repositoryId: number,
  accessContextRevision: number,
  confirmations: readonly ScopeConfirmationWrite[],
  syncedAt: string,
): void {
  for (const confirmation of confirmations) {
    const base = readScopeState(db, repositoryId, confirmation.scope, accessContextRevision) ?? initialScopeState();
    const next = applyScopeSync(base, {
      targetRevision: confirmation.targetRevision,
      covered: confirmation.covered,
      syncedAt,
      ...(confirmation.fingerprint !== undefined ? { fingerprint: confirmation.fingerprint } : {}),
    });
    if (next !== base) writeScopeState(db, repositoryId, confirmation.scope, next, accessContextRevision);
  }
}

function upsertColumn(db: LocalDatabase, repositoryId: number, name: ColumnName, column: ColumnResult | undefined, updatedAt: string): void {
  db.prepare('INSERT INTO detail_column (repository_id, column_name, state, payload, error_kind, error_message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, column_name) DO UPDATE SET state = excluded.state, payload = excluded.payload, error_kind = excluded.error_kind, error_message = excluded.error_message, updated_at = excluded.updated_at')
    .run(repositoryId, name, column?.status ?? 'unsupported', column?.value === null || column?.value === undefined ? null : JSON.stringify(column.value), column?.error?.kind ?? null, column?.error?.message ?? null, updatedAt);
}

/**
 * 建立/重建缓存：详情 payload、栏目、范围确认（只推进覆盖到的目标版本）与视图版本同一事务保存。
 * 适配器未提供指纹的范围保留旧基线，不用本地拼装的指纹冒充。
 * `complete=false`（部分成功、含仍有范围在暂存）时完整成功时间保持未知/旧值，不把创建时刻冒充完整同步。
 */
export function writeSyncedDetail(
  db: LocalDatabase,
  cache: DetailCache,
  accessContextRevision: number,
  confirmations: readonly ScopeConfirmationWrite[],
  syncedAt: string,
  complete: boolean,
): void {
  const write = db.transaction(() => {
    db.prepare('INSERT INTO detail_cache (repository_id, payload, fetched_at, source_updated_at, schema_version, access_context_revision, complete_fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, source_updated_at = excluded.source_updated_at, schema_version = excluded.schema_version, access_context_revision = excluded.access_context_revision, complete_fetched_at = excluded.complete_fetched_at')
      .run(cache.repositoryId, JSON.stringify(cache), cache.fetchedAt, cache.fetchedAt, DETAIL_CACHE_SCHEMA_VERSION, accessContextRevision, complete ? syncedAt : null);
    for (const [name, column] of Object.entries(cache.columns)) upsertColumn(db, cache.repositoryId, name as ColumnName, column, cache.fetchedAt);
    applyConfirmations(db, cache.repositoryId, accessContextRevision, confirmations, syncedAt);
    bumpViewVersion(db, cache.repositoryId, cache.fetchedAt);
  });
  write();
}

/**
 * 部分提交的单个范围写入：只包含本次成功来源的 values 键与栏目；完整覆盖时附带确认。
 * 失败范围不出现在写入列表里，保留旧值与旧成功时间。
 */
export interface ScopeContentWrite {
  scope: DetailScope;
  values: Partial<DetailValues>;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  confirmation?: ScopeConfirmationWrite;
}

/** payload 允许被分级改写的 values 键；SQL 路径只能由白名单拼接。 */
const CONTENT_VALUE_KEYS: readonly (keyof DetailValues)[] = ['metadata', 'releases', 'tags', 'commits', 'issues', 'pullRequests', 'builds', 'build', 'readmes', 'tree'];

/**
 * 有旧缓存时的分级提交：逐范围改写 payload 内本次成功来源的键，其他栏目原样保留；
 * 完整覆盖的范围随指纹与成功时间一起推进同步基线。
 * 只有 `complete=true`（全部远端范围完整覆盖，且没有范围仍在暂存）才推进完整成功时间；
 * 后续部分更新或构建独立更新保留旧完整时间。
 * payload 损坏或缓存缺失时整体回滚，不产生半套写入。
 */
export function writeScopeContents(
  db: LocalDatabase,
  repositoryId: number,
  accessContextRevision: number,
  writes: readonly ScopeContentWrite[],
  syncedAt: string,
  complete: boolean,
): void {
  if (writes.length === 0 && !complete) return;
  const write = db.transaction(() => {
    for (const entry of writes) {
      const keys = (Object.entries(entry.values) as Array<[keyof DetailValues, unknown]>)
        .filter(([key, value]) => value !== undefined && CONTENT_VALUE_KEYS.includes(key));
      if (keys.length > 0) {
        const sql = 'UPDATE detail_cache SET payload = json_set(payload' + keys.map(([key]) => `, '$.values.${key}', json(?)`).join('') + ') WHERE repository_id = ?';
        const updated = db.prepare(sql).run(...keys.map(([, value]) => JSON.stringify(value)), repositoryId);
        if (updated.changes === 0) throw new Error('详情缓存不存在，无法写入范围结果');
      }
      for (const [name, column] of Object.entries(entry.columns)) upsertColumn(db, repositoryId, name as ColumnName, column, syncedAt);
      if (entry.confirmation) applyConfirmations(db, repositoryId, accessContextRevision, [entry.confirmation], syncedAt);
    }
    // 完整覆盖的一轮推进缓存身份时间与完整成功时间；部分轮次两者都保留，未完成不得冒充完整详情。
    if (complete) db.prepare('UPDATE detail_cache SET fetched_at = ?, source_updated_at = ?, complete_fetched_at = ? WHERE repository_id = ?').run(syncedAt, syncedAt, syncedAt, repositoryId);
    bumpViewVersion(db, repositoryId, syncedAt);
  });
  write();
}

/**
 * 范围抓取成功：只在 SQLite 内改写该范围的内容（不触碰完整抓取时间与 schema/上下文），
 * 覆盖确认与视图版本同事务保存；payload 损坏或缓存缺失时整体回滚。
 */
export function writeBuildsScope(
  db: LocalDatabase,
  repositoryId: number,
  builds: BuildItem[],
  build: BuildInfo,
  accessContextRevision: number,
  confirmations: readonly ScopeConfirmationWrite[],
  syncedAt: string,
): void {
  const write = db.transaction(() => {
    const updated = db.prepare("UPDATE detail_cache SET payload = json_set(payload, '$.values.builds', json(?), '$.values.build', json(?)) WHERE repository_id = ?")
      .run(JSON.stringify(builds), JSON.stringify(build), repositoryId);
    if (updated.changes === 0) throw new Error('详情缓存不存在，无法写入范围结果');
    upsertColumn(db, repositoryId, 'builds', { status: builds.length === 0 ? 'empty' : 'success', value: builds, error: null }, syncedAt);
    applyConfirmations(db, repositoryId, accessContextRevision, confirmations, syncedAt);
    bumpViewVersion(db, repositoryId, syncedAt);
  });
  write();
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

function decodeFailure(value: string | null): import('../../../../domain/types').NormalizedError | undefined {
  if (!value || !value.startsWith('{')) return undefined;
  try { const parsed = JSON.parse(value) as import('../../../../domain/types').NormalizedError; return typeof parsed.message === 'string' && ['network', 'unknown', 'not_found', 'rate_limited', 'access_token_invalid'].includes(parsed.kind) ? parsed : undefined; } catch { return undefined; }
}

function rowToScopeState(row: ScopeStateRow): ScopeSyncState {
  const checkFailure = decodeFailure(row.last_check_error);
  const syncFailure = decodeFailure(row.last_sync_error);
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
    ...(row.last_check_error !== null ? { lastCheckError: checkFailure?.message ?? row.last_check_error, ...(checkFailure ? { lastCheckFailure: checkFailure } : {}) } : {}),
    ...(row.last_sync_error !== null ? { lastSyncError: syncFailure?.message ?? row.last_sync_error, ...(syncFailure ? { lastSyncFailure: syncFailure } : {}) } : {}),
  };
}

export function readScopeStates(db: LocalDatabase, repositoryId: number, accessContextRevision: number): Partial<Record<DetailScope, ScopeSyncState>> {
  const rows = db.prepare('SELECT scope, cache_status, freshness, check_status, sync_status, detected_revision, synced_revision, important_revision, viewed_revision, dirty_reasons, last_checked_at, last_synced_at, last_check_error, last_sync_error FROM detail_scope_state WHERE repository_id = ? AND access_context_revision = ?').all(repositoryId, accessContextRevision) as ScopeStateRow[];
  const result: Partial<Record<DetailScope, ScopeSyncState>> = {};
  for (const row of rows) result[row.scope as DetailScope] = rowToScopeState(row);
  return result;
}

/** 内部规划与执行读取：含内部指纹基线；面向展示的状态读取不经过这里。 */
export function readScopeStatesFull(db: LocalDatabase, repositoryId: number, accessContextRevision: number): Partial<Record<DetailScope, ScopeSyncState>> {
  const rows = db.prepare('SELECT * FROM detail_scope_state WHERE repository_id = ? AND access_context_revision = ?').all(repositoryId, accessContextRevision) as ScopeStateRow[];
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
    state.lastSyncedAt ?? null, state.lastCheckFailure ? JSON.stringify(state.lastCheckFailure) : state.lastCheckError ?? null, state.lastSyncFailure ? JSON.stringify(state.lastSyncFailure) : state.lastSyncError ?? null, accessContextRevision,
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

/** 只读当前上下文的已采集默认分支；不猜测分支名，也不把旧上下文作为查询参数。 */
export function readCachedBranch(db: LocalDatabase, id: number, revision: number): string | null {
  const row = db.prepare("SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, '$.values.metadata.defaultBranch') END AS branch FROM detail_cache WHERE repository_id = ? AND schema_version = ? AND access_context_revision = ?").get(id, DETAIL_CACHE_SCHEMA_VERSION, revision) as { branch: unknown } | undefined;
  return typeof row?.branch === 'string' ? row.branch : null;
}
export function hasColumnData(db: LocalDatabase, id: number, names: readonly string[]): boolean {
  if (names.length === 0) return false;
  return Boolean(db.prepare('SELECT 1 FROM detail_column WHERE repository_id = ? AND payload IS NOT NULL AND column_name IN (' + names.map(() => '?').join(',') + ') LIMIT 1').get(id, ...names));
}
