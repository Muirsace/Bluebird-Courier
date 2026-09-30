import type { Snapshot } from '../../../../domain/types';
import type { LocalDatabase } from '../../../core/infra/database';

export interface SnapshotValues {
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  latestReleaseTag: string | null;
  pushedAt: string | null;
}

/** The local calendar day is the uniqueness key for a repository snapshot. */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Upsert the day's snapshot. The caller owns the surrounding transaction. */
export function recordSnapshot(
  db: LocalDatabase,
  repositoryId: number,
  values: SnapshotValues,
  capturedAt: Date,
): void {
  db.prepare(
    `INSERT INTO snapshot (repository_id, captured_at, day, stars, forks, open_issues, latest_release_tag, pushed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_id, day) DO UPDATE SET
       captured_at = excluded.captured_at,
       stars = excluded.stars,
       forks = excluded.forks,
       open_issues = excluded.open_issues,
       latest_release_tag = excluded.latest_release_tag,
       pushed_at = excluded.pushed_at`,
  ).run(
    repositoryId,
    capturedAt.toISOString(),
    localDateKey(capturedAt),
    values.stars,
    values.forks,
    values.openIssues,
    values.latestReleaseTag,
    values.pushedAt,
  );
}

export function listSnapshots(db: LocalDatabase, repositoryId: number): Snapshot[] {
  const rows = db
    .prepare(
      'SELECT captured_at, stars, forks, open_issues, latest_release_tag, pushed_at FROM snapshot WHERE repository_id = ? ORDER BY captured_at ASC',
    )
    .all(repositoryId) as Array<{
    captured_at: string;
    stars: number | null;
    forks: number | null;
    open_issues: number | null;
    latest_release_tag: string | null;
    pushed_at: string | null;
  }>;
  return rows.map((row) => ({
    capturedAt: row.captured_at,
    stars: row.stars,
    forks: row.forks,
    openIssues: row.open_issues,
    latestReleaseTag: row.latest_release_tag,
    pushedAt: row.pushed_at,
  }));
}

