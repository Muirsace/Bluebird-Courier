import type { LocalDatabase } from '../../../core/infra/database';
import type { Glance, FetchedGlance } from '../../../../domain/types';

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
  latest_tag?: string | null;
  collaboration_activity_at?: string | null;
  code_activity_at?: string | null;
  repository_status?: 'active' | 'archived' | 'deleted' | 'renamed';
  last_error_kind?: string | null;
  last_error_message?: string | null;
  last_success_at?: string | null;
}

export function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function rowToGlance(row: RepositoryRow): Glance {
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
    latestTag: row.latest_tag ?? null,
    collaborationAt: row.collaboration_activity_at ?? null,
    activityAt: row.code_activity_at ?? row.pushed_at ?? null,
    status: row.repository_status ?? 'active',
    lastSucceededAt: row.last_success_at ?? row.fetched_at,
    failure: row.last_error_kind && row.last_error_message ? { kind: row.last_error_kind as import('../../../../domain/types').ErrorKind, message: row.last_error_message, fullName: row.full_name } : null,
  };
}

export function readRow(db: LocalDatabase, id: number): RepositoryRow | null {
  return (db.prepare('SELECT * FROM repository WHERE id = ?').get(id) as RepositoryRow | undefined) ?? null;
}

export function readRowByFullName(db: LocalDatabase, fullName: string): RepositoryRow | null {
  return (db.prepare('SELECT * FROM repository WHERE full_name = ? COLLATE NOCASE').get(fullName) as RepositoryRow | undefined) ?? null;
}

export function insertFetched(db: LocalDatabase, values: FetchedGlance, capturedAt: string): number {
  const slash = values.fullName.indexOf('/');
  const owner = slash < 0 ? values.fullName : values.fullName.slice(0, slash);
  const name = slash < 0 ? '' : values.fullName.slice(slash + 1);
  const result = db.prepare(
    `INSERT INTO repository (owner, name, full_name, added_at, stars, forks, open_issues, pushed_at, latest_release_tag, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(owner, name, values.fullName, capturedAt, values.stars, values.forks, values.openIssues, values.pushedAt, values.latestReleaseTag, capturedAt);
  return Number(result.lastInsertRowid);
}
