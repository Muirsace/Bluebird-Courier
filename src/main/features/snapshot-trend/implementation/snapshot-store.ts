import type { LocalDatabase } from '../../../core/infra/database';
import type { CacheStatus, GlanceValues, Snapshot } from '../../../../domain/types';
import type { TrendPoint } from '../contract';

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function recordSnapshot(db: LocalDatabase, repositoryId: number, values: GlanceValues, capturedAt: Date, accessContextRevision: number): void {
  db.prepare(
    `INSERT INTO snapshot (repository_id, captured_at, day, stars, forks, open_issues, latest_release_tag, pushed_at, access_context_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_id, day) DO UPDATE SET
       captured_at = excluded.captured_at,
       stars = excluded.stars,
       forks = excluded.forks,
       open_issues = excluded.open_issues,
       latest_release_tag = excluded.latest_release_tag,
       pushed_at = excluded.pushed_at,
       access_context_revision = excluded.access_context_revision`,
  ).run(repositoryId, capturedAt.toISOString(), localDateKey(capturedAt), values.stars, values.forks, values.openIssues, values.latestReleaseTag, values.pushedAt, accessContextRevision);
  bumpSnapshotViewVersion(db, repositoryId);
}

export function deleteExpired(db: LocalDatabase, repositoryId: number | undefined, now: Date): void {
  const cutoff = new Date(now.getTime());
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 29);
  const day = localDateKey(cutoff);
  db.transaction(() => {
    const affected = db.prepare('SELECT DISTINCT repository_id FROM snapshot WHERE day < ? AND (? IS NULL OR repository_id = ?)').all(day, repositoryId ?? null, repositoryId ?? null) as Array<{ repository_id: number }>;
    if (repositoryId === undefined) db.prepare('DELETE FROM snapshot WHERE day < ?').run(day);
    else db.prepare('DELETE FROM snapshot WHERE repository_id = ? AND day < ?').run(repositoryId, day);
    for (const row of affected) bumpSnapshotViewVersion(db, row.repository_id);
  })();
}

export function listSnapshots(db: LocalDatabase, repositoryId: number): Snapshot[] {
  const rows = db.prepare('SELECT captured_at, stars, forks, open_issues, latest_release_tag, pushed_at FROM snapshot WHERE repository_id = ? ORDER BY captured_at ASC').all(repositoryId) as Array<{ captured_at: string; stars: number | null; forks: number | null; open_issues: number | null; latest_release_tag: string | null; pushed_at: string | null }>;
  return rows.map((row) => ({ capturedAt: row.captured_at, stars: row.stars, forks: row.forks, openIssues: row.open_issues, latestReleaseTag: row.latest_release_tag, pushedAt: row.pushed_at }));
}

export function listTrend(db: LocalDatabase, repositoryId: number): TrendPoint[] {
  const rows = db.prepare('SELECT captured_at, stars, forks FROM snapshot WHERE repository_id = ? ORDER BY captured_at ASC').all(repositoryId) as Array<{ captured_at: string; stars: number | null; forks: number | null }>;
  return rows.map((row) => ({ capturedAt: row.captured_at, stars: row.stars, forks: row.forks }));
}

/** 趋势窗口版本与分页属于快照 feature；内容变更后旧游标失效。 */
export function readSnapshotViewVersion(db: LocalDatabase, id: number): number {
  return (db.prepare('SELECT view_version FROM snapshot_view_state WHERE repository_id = ?').get(id) as { view_version: number } | undefined)?.view_version ?? 0;
}
export function bumpSnapshotViewVersion(db: LocalDatabase, id: number): void {
  db.prepare('INSERT INTO snapshot_view_state (repository_id, view_version) SELECT id, 1 FROM repository WHERE id = ? ON CONFLICT(repository_id) DO UPDATE SET view_version = view_version + 1').run(id);
}
export function readLocalTrend(db: LocalDatabase, id: number, offset: number, limit: number, accessContextRevision: number): { points: TrendPoint[]; hasMore: boolean } {
  const rows = db.prepare('SELECT captured_at, stars, forks FROM snapshot WHERE repository_id = ? AND access_context_revision = ? ORDER BY captured_at ASC, day ASC LIMIT ? OFFSET ?').all(id, accessContextRevision, limit + 1, offset) as Array<{ captured_at: string; stars: number | null; forks: number | null }>;
  return { points: rows.slice(0, limit).map(row => ({ capturedAt: row.captured_at, stars: row.stars, forks: row.forks })), hasMore: rows.length > limit };
}

/** 缓存可用性只读计数，不读取或解析任何快照正文。 */
export function readLocalTrendState(db: LocalDatabase, id: number, revision: number): { viewVersion: number; cacheStatus: CacheStatus } {
  const row = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(access_context_revision = ?), 0) AS current FROM snapshot WHERE repository_id = ?').get(revision, id) as { total: number; current: number };
  return { viewVersion: readSnapshotViewVersion(db, id), cacheStatus: row.current > 0 ? 'valid' : row.total > 0 ? 'invalid' : 'missing' };
}
