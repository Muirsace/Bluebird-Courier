import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Logger } from '../../../core/infra/logger';
import { parseRepoInput } from '../../../../domain/rules/repo-input';
import type {
  Detail,
  DetailValues,
  FetchedGlance,
  Glance,
  GlanceValues,
  RepoInputResult,
} from '../../../../domain/types';
import type { WatchlistFeature } from '../contract';
import { listSnapshots, recordSnapshot } from './snapshots';

interface RepositoryRow {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  added_at: string;
  stars: number | null;
  forks: number | null;
  open_issues: number | null;
  pushed_at: string | null;
  latest_release_tag: string | null;
  fetched_at: string | null;
}

export interface WatchlistDependencies {
  db: LocalDatabase;
  clock: Clock;
  logger?: Logger;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function rowToGlance(row: RepositoryRow): Glance {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    addedAt: row.added_at,
    stars: row.stars,
    forks: row.forks,
    openIssues: row.open_issues,
    pushedAt: row.pushed_at,
    latestReleaseTag: row.latest_release_tag,
    fetchedAt: row.fetched_at,
  };
}

function findRow(db: LocalDatabase, id: number): RepositoryRow | null {
  const row = db.prepare('SELECT * FROM repository WHERE id = ?').get(id) as RepositoryRow | undefined;
  return row ?? null;
}

function requireRow(db: LocalDatabase, id: number): RepositoryRow {
  const row = findRow(db, id);
  if (!row) throw new Error(`监控仓库不存在：${id}`);
  return row;
}

function findRowByFullName(db: LocalDatabase, fullName: string): RepositoryRow | null {
  const row = db
    .prepare('SELECT * FROM repository WHERE full_name = ? COLLATE NOCASE')
    .get(fullName) as RepositoryRow | undefined;
  return row ?? null;
}

function updateGlance(
  db: LocalDatabase,
  repositoryId: number,
  values: GlanceValues,
  fetchedAt: string,
): void {
  db.prepare(
    `UPDATE repository
     SET stars = ?, forks = ?, open_issues = ?, pushed_at = ?, latest_release_tag = ?, fetched_at = ?
     WHERE id = ?`,
  ).run(
    values.stars,
    values.forks,
    values.openIssues,
    values.pushedAt,
    values.latestReleaseTag,
    fetchedAt,
    repositoryId,
  );
}

function updateLatestRelease(
  db: LocalDatabase,
  repositoryId: number,
  latestReleaseTag: string | null,
  fetchedAt: string,
): void {
  db.prepare('UPDATE repository SET latest_release_tag = ?, fetched_at = ? WHERE id = ?').run(
    latestReleaseTag,
    fetchedAt,
    repositoryId,
  );
}

export function createWatchlist({ db, clock, logger }: WatchlistDependencies): WatchlistFeature {
  const inspectInput = (input: unknown): RepoInputResult =>
    parseRepoInput(typeof input === 'string' ? input : '');

  const list = (): Glance[] =>
    (db
      .prepare('SELECT * FROM repository ORDER BY added_at DESC, id DESC')
      .all() as RepositoryRow[]).map(rowToGlance);

  const findById = (id: number): Glance | null => {
    if (!isPositiveId(id)) return null;
    const row = findRow(db, id);
    return row ? rowToGlance(row) : null;
  };

  const findByFullName = (fullName: string): Glance | null => {
    const row = findRowByFullName(db, fullName);
    return row ? rowToGlance(row) : null;
  };

  const add = (values: FetchedGlance): Glance => {
    const slash = values.fullName.indexOf('/');
    const owner = slash < 0 ? values.fullName : values.fullName.slice(0, slash);
    const name = slash < 0 ? '' : values.fullName.slice(slash + 1);
    if (!owner || !name) throw new Error(`仓库落库失败：${values.fullName}`);
    const capturedAt = clock.now();

    // Insertion, the initial glance, and its snapshot are one unit. A failed
    // snapshot can never leave a half-added repository behind.
    const insert = db.transaction(() => {
      const result = db
        .prepare('INSERT INTO repository (owner, name, full_name, added_at) VALUES (?, ?, ?, ?)')
        .run(owner, name, values.fullName, capturedAt.toISOString());
      const id = Number(result.lastInsertRowid);
      updateGlance(db, id, values, capturedAt.toISOString());
      recordSnapshot(db, id, values, capturedAt);
      return requireRow(db, id);
    });
    return rowToGlance(insert());
  };

  const remove = (id: unknown): void => {
    if (!isPositiveId(id)) {
      logger?.error('忽略非法的监控仓库标识，未删除任何行', id);
      return;
    }
    db.prepare('DELETE FROM repository WHERE id = ?').run(id);
  };

  const applyGlance = (id: number, values: GlanceValues): Glance => {
    const capturedAt = clock.now();
    const apply = db.transaction(() => {
      requireRow(db, id);
      updateGlance(db, id, values, capturedAt.toISOString());
      recordSnapshot(db, id, values, capturedAt);
      return requireRow(db, id);
    });
    return rowToGlance(apply());
  };

  const applyDetail = (id: number, values: DetailValues): Detail => {
    const capturedAt = clock.now();
    const apply = db.transaction(() => {
      const row = requireRow(db, id);
      const latestReleaseTag = values.releases[0]?.tagName ?? null;
      updateLatestRelease(db, id, latestReleaseTag, capturedAt.toISOString());
      recordSnapshot(
        db,
        id,
        {
          stars: row.stars,
          forks: row.forks,
          openIssues: row.open_issues,
          pushedAt: row.pushed_at,
          latestReleaseTag,
        },
        capturedAt,
      );
      return requireRow(db, id);
    });
    const repository = rowToGlance(apply());
    return {
      repository,
      releases: values.releases,
      commits: values.commits,
      issues: values.issues,
      pullRequests: values.pullRequests,
      build: values.build,
      trend: listSnapshots(db, id),
    };
  };

  return { inspectInput, list, findById, findByFullName, add, remove, applyGlance, applyDetail };
}

export type { WatchlistFeature } from '../contract';
