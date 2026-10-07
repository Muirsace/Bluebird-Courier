import type { DetailScope, DetailValues } from '../../../../domain/types';
import { emptyLocalBuild } from '../../../../domain/rules/local-read';
import type { LocalDatabase } from '../../../core/infra/database';
import type { ColumnName, ColumnResult } from '../contract';

type ListKey = 'releases' | 'tags' | 'commits' | 'issues' | 'pullRequests' | 'builds' | 'readmes' | 'tree';
const RANGE_LISTS: Partial<Record<DetailScope, readonly ListKey[]>> = {
  releases: ['releases', 'tags'], commits: ['commits'], issuesAndPr: ['issues', 'pullRequests'],
  builds: ['builds'], readme: ['readmes'], tree: ['tree'],
};
const REQUIRED_LISTS = new Set<ListKey>(['releases', 'commits', 'issues', 'pullRequests']);
export interface LocalScopePage { values: Partial<DetailValues>; hasMore: boolean; count: number; missing: boolean; }

/** 只在 SQLite 内检验总对象结构；不把完整 payload 送入 JavaScript。 */
export function hasReadableDetail(db: LocalDatabase, repositoryId: number): boolean {
  const row = db.prepare("SELECT CASE WHEN json_valid(payload) THEN json_type(payload, '$.values') = 'object' AND json_extract(payload, '$.repositoryId') = repository_id ELSE 0 END AS ok FROM detail_cache WHERE repository_id = ?")
    .get(repositoryId) as { ok: number } | undefined;
  return row?.ok === 1;
}

function valueType(db: LocalDatabase, id: number, key: string): string | null {
  const row = db.prepare('SELECT json_type(payload, ?) AS kind FROM detail_cache WHERE repository_id = ?')
    .get('$.values.' + key, id) as { kind: string | null };
  return row.kind;
}
function objectValue(db: LocalDatabase, id: number, key: string): Record<string, unknown> | null {
  const kind = valueType(db, id, key);
  if (kind === null || kind === 'null') return null;
  if (kind !== 'object') throw new Error(key + ' 栏目结构损坏');
  const row = db.prepare('SELECT json_extract(payload, ?) AS value FROM detail_cache WHERE repository_id = ?')
    .get('$.values.' + key, id) as { value: string };
  return JSON.parse(row.value) as Record<string, unknown>;
}
function validItem(key: ListKey, value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (key === 'releases') return typeof item.tagName === 'string' && typeof item.title === 'string';
  if (key === 'tags') return typeof item.name === 'string';
  if (key === 'commits') return typeof item.sha === 'string' && typeof item.message === 'string';
  if (key === 'issues' || key === 'pullRequests') return Number.isSafeInteger(item.number) && typeof item.title === 'string' && (item.state === 'open' || item.state === 'closed');
  if (key === 'builds') return ['success', 'failure', 'pending', 'neutral', 'none'].includes(String(item.status));
  if (key === 'readmes') return typeof item.language === 'string' && typeof item.content === 'string';
  return typeof item.path === 'string' && (item.kind === 'file' || item.kind === 'directory');
}

/** 列表按范围共享 LIMIT，SQLite 返回至多一页；双栏目固定次序拼接，不重用两个独立 offset。 */
export function readLocalScopePage(db: LocalDatabase, id: number, scope: DetailScope, offset: number, limit: number): LocalScopePage {
  if (scope === 'overview') {
    const metadata = objectValue(db, id, 'metadata');
    return { values: metadata ? { metadata: metadata as unknown as NonNullable<DetailValues['metadata']> } : {}, hasMore: false, count: 0, missing: false };
  }
  if (scope === 'trends') return { values: {}, hasMore: false, count: 0, missing: true };
  const keys = RANGE_LISTS[scope] ?? [];
  const validKeys: ListKey[] = [];
  for (const key of keys) {
    const kind = valueType(db, id, key);
    if (kind === 'array') validKeys.push(key);
    else if (REQUIRED_LISTS.has(key) || (kind !== null && kind !== 'null')) throw new Error(key + ' 栏目结构损坏');
  }
  const values: Partial<DetailValues> = {};
  let build = null;
  if (scope === 'builds') {
    build = objectValue(db, id, 'build');
    if (!build) throw new Error('build 栏目结构损坏');
    if (build && !['success', 'failure', 'pending', 'neutral', 'none'].includes(String(build.status))) throw new Error('build 栏目结构损坏');
    values.build = (build ?? emptyLocalBuild()) as unknown as DetailValues['build'];
  }
  const rows: Array<{ part: ListKey; value: string; kind: string }> = validKeys.length === 0 ? [] :
    db.prepare(validKeys.map((key, index) =>
      'SELECT ' + index + " AS part_index, '" + key + "' AS part, CAST(j.key AS INTEGER) AS item_index, j.value AS value, j.type AS kind FROM detail_cache AS c, json_each(c.payload, '$.values." + key + "') AS j WHERE c.repository_id = ?")
      .join(' UNION ALL ') + ' ORDER BY part_index, item_index LIMIT ? OFFSET ?')
      .all(...validKeys.map(() => id), limit + 1, offset) as Array<{ part: ListKey; value: string; kind: string }>;
  for (const key of keys) Object.assign(values, { [key]: [] });
  for (const row of rows.slice(0, limit)) {
    if (row.kind !== 'object') throw new Error(row.part + ' 条目损坏');
    const item: unknown = JSON.parse(row.value);
    if (!validItem(row.part, item)) throw new Error(row.part + ' 条目损坏');
    (values[row.part] as unknown[]).push(item);
  }
  return { values, hasMore: rows.length > limit, count: Math.min(rows.length, limit), missing: validKeys.length === 0 && build === null };
}

/** 栏目元信息不读取 value，避免返回已裁剪之外的完整栏目副本。 */
export function readLocalColumns(db: LocalDatabase, id: number): Partial<Record<ColumnName, ColumnResult>> {
  const rows = db.prepare('SELECT column_name, state, error_kind, error_message FROM detail_column WHERE repository_id = ?').all(id) as
    Array<{ column_name: ColumnName; state: ColumnResult['status']; error_kind: string | null; error_message: string | null }>;
  const result: Partial<Record<ColumnName, ColumnResult>> = {};
  for (const row of rows) result[row.column_name] = { status: row.state, value: null,
    error: row.error_kind && row.error_message ? { kind: row.error_kind as NonNullable<ColumnResult['error']>['kind'], message: row.error_message } : null };
  return result;
}

/** 既有本地历史按栏目独立分页，不能先取默认30条视图再二次裁剪。 */
export function readHistoryPage(db: LocalDatabase, id: number, kind: 'commits' | 'issues' | 'pullRequests', offset: number): { items: unknown[]; nextCursor: string | null; hasMore: boolean } {
  if (!['commits', 'issues', 'pullRequests'].includes(kind) || !hasReadableDetail(db, id) || valueType(db, id, kind) !== 'array') return { items: [], nextCursor: null, hasMore: false };
  const rows = db.prepare('SELECT j.value AS value, j.type AS kind FROM detail_cache AS c, json_each(c.payload, ?) AS j WHERE c.repository_id = ? ORDER BY CAST(j.key AS INTEGER) LIMIT 31 OFFSET ?').all('$.values.' + kind, id, offset) as Array<{ value: string; kind: string }>;
  const items = rows.slice(0, 30).map(row => { const item: unknown = row.kind === 'object' ? JSON.parse(row.value) : null; if (!validItem(kind, item)) throw new Error('历史条目损坏'); return item; });
  return { items, nextCursor: rows.length > 30 ? String(offset + items.length) : null, hasMore: rows.length > 30 };
}
