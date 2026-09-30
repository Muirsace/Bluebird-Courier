import type Database from 'better-sqlite3';
import type { Glance } from '../../shared/types';

export interface RepositoryRow {
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

export interface GlanceValues {
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
  latestReleaseTag: string | null;
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
  };
}

export function listRepositoryRows(db: Database.Database): RepositoryRow[] {
  return db
    .prepare('SELECT * FROM repository ORDER BY added_at DESC, id DESC')
    .all() as RepositoryRow[];
}

export function findRepositoryRow(db: Database.Database, id: number): RepositoryRow | null {
  const row = db.prepare('SELECT * FROM repository WHERE id = ?').get(id) as RepositoryRow | undefined;
  return row ?? null;
}

/** 取行或抛错（业务前置条件不满足属于编程错误）。 */
export function mustFindRepositoryRow(db: Database.Database, id: number): RepositoryRow {
  const row = findRepositoryRow(db, id);
  if (!row) throw new Error(`监控仓库不存在：${id}`);
  return row;
}

export function findRepositoryByFullName(db: Database.Database, fullName: string): RepositoryRow | null {
  // GitHub 仓库名大小写不敏感：查重同语义，防止同一仓库不同大小写重复入列
  const row = db.prepare('SELECT * FROM repository WHERE full_name = ? COLLATE NOCASE').get(fullName) as
    | RepositoryRow
    | undefined;
  return row ?? null;
}

export function insertRepositoryRow(
  db: Database.Database,
  owner: string,
  name: string,
  addedAt: string,
): RepositoryRow {
  const fullName = `${owner}/${name}`;
  const result = db
    .prepare('INSERT INTO repository (owner, name, full_name, added_at) VALUES (?, ?, ?, ?)')
    .run(owner, name, fullName, addedAt);
  const row = findRepositoryRow(db, Number(result.lastInsertRowid));
  if (!row) throw new Error(`仓库落库失败：${fullName}`);
  return row;
}

export function updateRepositoryGlance(
  db: Database.Database,
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

/** 全量抓取的展示字段更新：只带最新发版标签与抓取时间（全量不含元数据调用）。 */
export function updateRepositoryLatestRelease(
  db: Database.Database,
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

export function deleteRepositoryRow(db: Database.Database, repositoryId: number): void {
  db.prepare('DELETE FROM repository WHERE id = ?').run(repositoryId);
}
