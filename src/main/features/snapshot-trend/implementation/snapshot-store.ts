import type { LocalDatabase } from '../../../core/infra/database';
import type { CacheStatus, GlanceValues, RepositoryStatus, Snapshot } from '../../../../domain/types';
import type { TrendPoint } from '../contract';

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 保留 30 个本地自然日（含今天）：今天与之前 29 天内的日期都算有效。 */
export function retentionCutoffDay(now: Date): string {
  const cutoff = new Date(now.getTime());
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 29);
  return localDateKey(cutoff);
}

/** 观察日期是否已落在保留窗口之外（按注入时钟的当前本地日期判定）。 */
export function isExpiredObservationDay(observedAt: Date, now: Date): boolean {
  return localDateKey(observedAt) < retentionCutoffDay(now);
}

export function recordSnapshot(db: LocalDatabase, repositoryId: number, values: GlanceValues, capturedAt: Date, accessContextRevision: number, sequence: number): void {
  // 时间表示事实日期，同毫秒以持久登记序号仲裁；仅顺序记账变化不推进展示版本。
  const day = localDateKey(capturedAt);
  const previous = db.prepare('SELECT captured_at, observation_at, stars, forks, open_issues, latest_release_tag, pushed_at, access_context_revision, observation_sequence FROM snapshot WHERE repository_id = ? AND day = ?').get(repositoryId, day) as Record<string, unknown> | undefined;
  const at = capturedAt.toISOString();
  const previousAt = previous?.observation_at ?? previous?.captured_at;
  if (previous && (String(previousAt) > at || (previousAt === at && Number(previous.observation_sequence) >= sequence))) return;
  const changed = !previous || previous.stars !== values.stars || previous.forks !== values.forks || previous.open_issues !== values.openIssues || previous.latest_release_tag !== values.latestReleaseTag || previous.pushed_at !== values.pushedAt || previous.access_context_revision !== accessContextRevision;
  const written = db.prepare(
    `INSERT INTO snapshot (repository_id, captured_at, day, stars, forks, open_issues, latest_release_tag, pushed_at, access_context_revision, observation_sequence, observation_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_id, day) DO UPDATE SET
       captured_at = CASE WHEN snapshot.stars IS excluded.stars AND snapshot.forks IS excluded.forks AND snapshot.open_issues IS excluded.open_issues AND snapshot.latest_release_tag IS excluded.latest_release_tag AND snapshot.pushed_at IS excluded.pushed_at AND snapshot.access_context_revision IS excluded.access_context_revision THEN snapshot.captured_at ELSE excluded.captured_at END,
       stars = excluded.stars,
       forks = excluded.forks,
       open_issues = excluded.open_issues,
       latest_release_tag = excluded.latest_release_tag,
       pushed_at = excluded.pushed_at,
       access_context_revision = excluded.access_context_revision,
       observation_sequence = excluded.observation_sequence,
       observation_at = excluded.observation_at`,
  ).run(repositoryId, at, day, values.stars, values.forks, values.openIssues, values.latestReleaseTag, values.pushedAt, accessContextRevision, sequence, at);
  if (written.changes === 0) throw new Error('快照写入未生效，保留观察意图等待恢复');
  if (changed) bumpSnapshotViewVersion(db, repositoryId);
}

// —— 待补偿的真实采样意图：先登记，写成功后再与快照同事务清除 ——

/** 无来源身份旧入口的兼容重试键；不能区分同内容同时间的独立观察。 */
export function pendingSnapshotIdentity(repositoryId: number, observedAt: Date, accessContextRevision: number, values: GlanceValues): string {
  const content = JSON.stringify([
    values.stars, values.forks, values.openIssues,
    values.pushedAt ?? null, values.latestReleaseTag ?? null,
    values.latestTag ?? null, values.collaborationAt ?? null, values.status ?? null,
  ]);
  return `${repositoryId}|${observedAt.toISOString()}|${accessContextRevision}|${content}`;
}

export interface PendingSnapshotEntry {
  /** 仅用于恢复调度的行位置，不参与成功样本的先后仲裁。 */
  rowId: number;
  /** 成功与待补偿共用的持久观察序号；V8 旧资料为未知的 0。 */
  sequence: number;
  identity: string;
  repositoryId: number;
  accessContextRevision: number;
  observedAt: string;
  /** 结构损坏或字段非法时为 null：无法还原真实观察，补偿时按身份丢弃。 */
  values: GlanceValues | null;
  createdAt: string;
}

const REPOSITORY_STATUSES: readonly RepositoryStatus[] = ['active', 'archived', 'deleted', 'renamed'];

/** 严格 ISO 时间：显式时区、真实日历日期；不允许 Date 自动修正非法日历。 */
export function parseObservationTime(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss, zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) return null;
  if (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59)) return null;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at : null;
}

/** 身份只负责去重；序号在持久事务中分配，成功后仍保留，绝不依赖待补偿 rowid。 */
export function registerSnapshotObservation(db: LocalDatabase, entry: Omit<PendingSnapshotEntry, 'rowId' | 'sequence' | 'values'> & { values: GlanceValues }): void {
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM snapshot_observation WHERE identity = ?').get(entry.identity)) return;
    const legacyPending = db.prepare('SELECT 1 FROM snapshot_pending WHERE identity = ?').get(entry.identity);
    const result = db.prepare('INSERT INTO snapshot_observation (identity, repository_id, observed_at) VALUES (?, ?, ?)').run(entry.identity, entry.repositoryId, entry.observedAt);
    if (result.changes !== 1) throw new Error('观察身份登记未生效，不能声称已持久化');
    if (legacyPending) return; // V8旧意图保留原载荷与未知序号0，不补造历史顺序。
    insertPendingSnapshot(db, { ...entry, sequence: Number(result.lastInsertRowid) });
  })();
}

/** 合法、有限、非负的指标；非法数值（字符串、NaN、Infinity、负数）不构成真实观察。 */
function validMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validNullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * 只接受真正的归一化 GlanceValues：对象、必需指标为合法数值、可选字段类型正确。
 * 数组、缺字段、错误类型或非法指标一律视为数据损坏（返回 null），不得写成空指标伪快照。
 */
export function normalizeGlanceValues(value: unknown): GlanceValues | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!validMetric(candidate.stars) || !validMetric(candidate.forks) || !validMetric(candidate.openIssues)) return null;
  if (!validNullableText(candidate.pushedAt) || !validNullableText(candidate.latestReleaseTag)) return null;
  if (candidate.pushedAt !== null && parseObservationTime(candidate.pushedAt) === null) return null;
  if (candidate.latestTag !== undefined && !validNullableText(candidate.latestTag)) return null;
  if (candidate.collaborationAt !== undefined && !validNullableText(candidate.collaborationAt)) return null;
  if (candidate.collaborationAt !== undefined && candidate.collaborationAt !== null && parseObservationTime(candidate.collaborationAt) === null) return null;
  if (candidate.status !== undefined && !REPOSITORY_STATUSES.includes(candidate.status as RepositoryStatus)) return null;
  return {
    stars: candidate.stars,
    forks: candidate.forks,
    openIssues: candidate.openIssues,
    pushedAt: candidate.pushedAt,
    latestReleaseTag: candidate.latestReleaseTag,
    ...(candidate.latestTag !== undefined ? { latestTag: candidate.latestTag } : {}),
    ...(candidate.collaborationAt !== undefined ? { collaborationAt: candidate.collaborationAt } : {}),
    ...(candidate.status !== undefined ? { status: candidate.status as RepositoryStatus } : {}),
  };
}

/** 登记真实采样意图；整库不可写时抛出（不静默声称已持久化）。 */
export function insertPendingSnapshot(db: LocalDatabase, entry: Omit<PendingSnapshotEntry, 'rowId' | 'values'> & { values: GlanceValues }): void {
  const result = db.prepare(
    'INSERT OR IGNORE INTO snapshot_pending (identity, repository_id, access_context_revision, observed_at, payload, created_at, observation_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(entry.identity, entry.repositoryId, entry.accessContextRevision, entry.observedAt, JSON.stringify(entry.values), entry.createdAt, entry.sequence);
  if (result.changes !== 1) throw new Error('采样意图登记未生效，不能声称已持久化');
}

export function deletePendingSnapshot(db: LocalDatabase, identity: string): void {
  const result = db.prepare('DELETE FROM snapshot_pending WHERE identity = ?').run(identity);
  if (result.changes === 0 && db.prepare('SELECT 1 FROM snapshot_pending WHERE identity = ?').get(identity)) {
    throw new Error('采样意图清除未生效，保留事务等待恢复');
  }
}

/**
 * 按登记顺序有界读取待补偿意图（从 afterRowId 之后开始）。
 * 结构损坏或字段非法的条目保留身份并把 values 标为 null，由补偿按数据损坏丢弃。
 */
export function readPendingSnapshots(db: LocalDatabase, afterRowId: number, limit: number): PendingSnapshotEntry[] {
  const rows = db.prepare(
    'SELECT rowid AS row_id, observation_sequence, identity, repository_id, access_context_revision, observed_at, payload, created_at FROM snapshot_pending WHERE rowid > ? ORDER BY rowid ASC LIMIT ?',
  ).all(afterRowId, limit) as Array<{ row_id: number; observation_sequence: number; identity: string; repository_id: number; access_context_revision: number; observed_at: string; payload: string; created_at: string }>;
  return rows.map((row) => {
    let values: GlanceValues | null = null;
    try {
      values = normalizeGlanceValues(JSON.parse(row.payload) as unknown);
    } catch {
      values = null;
    }
    return { rowId: row.row_id, sequence: row.observation_sequence, identity: row.identity, repositoryId: row.repository_id, accessContextRevision: row.access_context_revision, observedAt: row.observed_at, values, createdAt: row.created_at };
  });
}

export function countPendingSnapshots(db: LocalDatabase): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get() as { n: number }).n;
}

export function readPendingSnapshotByIdentity(db: LocalDatabase, identity: string): PendingSnapshotEntry | undefined {
  const row = db.prepare('SELECT rowid AS n FROM snapshot_pending WHERE identity = ?').get(identity) as { n: number } | undefined;
  return row ? readPendingSnapshots(db, row.n - 1, 1)[0] : undefined;
}

export function maxPendingSnapshotRowId(db: LocalDatabase): number {
  return (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM snapshot_pending').get() as { n: number }).n;
}

// —— 采样补偿的可恢复游标：越过瞬时失败前缀，走到队尾后回到起点重试 ——

export function readPendingSnapshotCursor(db: LocalDatabase): number {
  return (db.prepare('SELECT last_rowid FROM snapshot_pending_cursor WHERE id = 1').get() as { last_rowid: number } | undefined)?.last_rowid ?? 0;
}

export function writePendingSnapshotCursor(db: LocalDatabase, lastRowId: number): void {
  db.prepare('INSERT INTO snapshot_pending_cursor (id, last_rowid) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_rowid = excluded.last_rowid').run(lastRowId);
}

/** 仓库是否仍存在；补偿前校验，避免为已删仓库写入快照。 */
export function pendingSnapshotRepositoryExists(db: LocalDatabase, repositoryId: number): boolean {
  return db.prepare('SELECT 1 FROM repository WHERE id = ?').get(repositoryId) !== undefined;
}

/** 按注入时钟的当前时间执行 30 个本地自然日保留；观察时间只作为样本事实。 */
export function deleteExpired(db: LocalDatabase, repositoryId: number | undefined, now: Date): void {
  const day = retentionCutoffDay(now);
  db.transaction(() => {
    const affected = db.prepare('SELECT repository_id, COUNT(*) AS count FROM snapshot WHERE day < ? AND (? IS NULL OR repository_id = ?) GROUP BY repository_id').all(day, repositoryId ?? null, repositoryId ?? null) as Array<{ repository_id: number; count: number }>;
    const removed = repositoryId === undefined
      ? db.prepare('DELETE FROM snapshot WHERE day < ?').run(day)
      : db.prepare('DELETE FROM snapshot WHERE repository_id = ? AND day < ?').run(repositoryId, day);
    if (removed.changes !== affected.reduce((count, row) => count + row.count, 0)) {
      throw new Error('过期快照清理未完成，不能推进展示版本');
    }
    for (const row of affected) bumpSnapshotViewVersion(db, row.repository_id);
    // 过期观察即使再次交付也不能入样；保留期内成功身份继续用于去重。
    db.prepare('DELETE FROM snapshot_observation WHERE observed_at < ? AND (? IS NULL OR repository_id = ?) AND identity NOT IN (SELECT identity FROM snapshot_pending)').run(new Date(`${day}T00:00:00`).toISOString(), repositoryId ?? null, repositoryId ?? null);
  })();
}

export function listSnapshots(db: LocalDatabase, repositoryId: number, now: Date): Snapshot[] {
  const rows = db.prepare('SELECT captured_at, stars, forks, open_issues, latest_release_tag, pushed_at FROM snapshot WHERE repository_id = ? AND day >= ? ORDER BY captured_at ASC').all(repositoryId, retentionCutoffDay(now)) as Array<{ captured_at: string; stars: number | null; forks: number | null; open_issues: number | null; latest_release_tag: string | null; pushed_at: string | null }>;
  return rows.map((row) => ({ capturedAt: row.captured_at, stars: row.stars, forks: row.forks, openIssues: row.open_issues, latestReleaseTag: row.latest_release_tag, pushedAt: row.pushed_at }));
}

export function listTrend(db: LocalDatabase, repositoryId: number, now: Date): TrendPoint[] {
  const rows = db.prepare('SELECT captured_at, stars, forks FROM snapshot WHERE repository_id = ? AND day >= ? ORDER BY captured_at ASC').all(repositoryId, retentionCutoffDay(now)) as Array<{ captured_at: string; stars: number | null; forks: number | null }>;
  return rows.map((row) => ({ capturedAt: row.captured_at, stars: row.stars, forks: row.forks }));
}

/** 趋势窗口版本与分页属于快照 feature；内容变更后旧游标失效。 */
export function readSnapshotViewVersion(db: LocalDatabase, id: number): number {
  return (db.prepare('SELECT view_version FROM snapshot_view_state WHERE repository_id = ?').get(id) as { view_version: number } | undefined)?.view_version ?? 0;
}
export function bumpSnapshotViewVersion(db: LocalDatabase, id: number): void {
  db.prepare('INSERT INTO snapshot_view_state (repository_id, view_version) SELECT id, 1 FROM repository WHERE id = ? ON CONFLICT(repository_id) DO UPDATE SET view_version = view_version + 1').run(id);
}
export function readLocalTrend(db: LocalDatabase, id: number, offset: number, limit: number, accessContextRevision: number, now: Date): { points: TrendPoint[]; hasMore: boolean } {
  const rows = db.prepare('SELECT captured_at, stars, forks FROM snapshot WHERE repository_id = ? AND access_context_revision = ? AND day >= ? ORDER BY captured_at ASC, day ASC LIMIT ? OFFSET ?').all(id, accessContextRevision, retentionCutoffDay(now), limit + 1, offset) as Array<{ captured_at: string; stars: number | null; forks: number | null }>;
  return { points: rows.slice(0, limit).map(row => ({ capturedAt: row.captured_at, stars: row.stars, forks: row.forks })), hasMore: rows.length > limit };
}

/** 缓存可用性只读计数，不读取或解析任何快照正文。 */
export function readLocalTrendState(db: LocalDatabase, id: number, revision: number, now: Date): { viewVersion: number; cacheStatus: CacheStatus; windowKey: string } {
  const row = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(access_context_revision = ?), 0) AS current FROM snapshot WHERE repository_id = ? AND day >= ?').get(revision, id, retentionCutoffDay(now)) as { total: number; current: number };
  return { viewVersion: readSnapshotViewVersion(db, id), cacheStatus: row.current > 0 ? 'valid' : row.total > 0 ? 'invalid' : 'missing', windowKey: retentionCutoffDay(now) };
}
