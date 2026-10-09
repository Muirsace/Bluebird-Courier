import type { LocalDatabase } from '../../../core/infra/database';
import type { ContentVersion, DetailScope, PaginationCursor } from '../../../../domain/types';
import { isLocalColumnItemValid } from './local-detail-store';

/**
 * 暂存身份：范围与会话窗口参数（仓库、默认分支、每页上限）。
 * 访问上下文与缓存 schema 另存列上；任一变化都不得接续旧片段。
 */
export interface StagedScopeQuery {
  scope: DetailScope;
  fullName: string;
  defaultBranch: string | null;
  limit: number;
  accessContextRevision: number;
  schemaVersion: number;
  targetVersion?: Partial<ContentVersion>;
}

/**
 * 未完成稳定窗口的进度：已处理片段、续读游标与窗口起点指纹。
 * 只有完整覆盖后才能作为成功内容与确认基线使用；未完成不得替换有效缓存。
 */
export interface StagedScopeState {
  items: unknown[];
  cursor: PaginationCursor;
  fingerprint?: string;
  version?: Partial<ContentVersion>;
  pages: number;
  bytes: number;
}

/** 暂存体积上限（约 2 MiB）：超出即放弃暂存并保留未确认状态，不做无界增长。 */
export const MAX_STAGED_BYTES = 2 * 1024 * 1024;

/** 查询身份：参数变化就是新查询，旧游标与旧片段都不能接续。 */
export function stagedQueryKey(query: Pick<StagedScopeQuery, 'fullName' | 'defaultBranch' | 'limit' | 'targetVersion'>): string {
  const identity: unknown[] = [query.fullName, query.defaultBranch, query.limit];
  if (query.targetVersion && Object.keys(query.targetVersion).length > 0) identity.push(
    ['defaultBranch', 'headRevision', 'releaseRevision', 'tagRevision'].map(field => {
      const value = query.targetVersion![field as keyof ContentVersion];
      return value === undefined ? ['unknown'] : ['known', value];
    }));
  return JSON.stringify(identity);
}

interface StagedRow { payload: string | null; cursor: string | null }

function deleteStagedRow(db: LocalDatabase, repositoryId: number, scope: DetailScope, queryKey: string, accessContextRevision: number, schemaVersion: number): void {
  db.prepare('DELETE FROM cache_query_page WHERE repository_id = ? AND scope = ? AND query_key = ? AND access_context_revision = ? AND schema_version = ?')
    .run(repositoryId, scope, queryKey, accessContextRevision, schemaVersion);
}

/**
 * 读取同一窗口的既有进度。身份不匹配、结构损坏或没有续读游标的记录都不可接续：
 * 就地清理，避免永久把该范围标记为"待续读"，然后返回 null 由调用方从稳定窗口起点重建。
 */
export function readStagedScope(db: LocalDatabase, repositoryId: number, query: StagedScopeQuery): StagedScopeState | null {
  const queryKey = stagedQueryKey(query);
  // 先在SQLite内检查实际字节数，超限记录不把整个字符串送入JavaScript。
  const row = db.prepare('SELECT CASE WHEN length(CAST(payload AS BLOB)) <= ? THEN payload ELSE NULL END AS payload, cursor FROM cache_query_page WHERE repository_id = ? AND scope = ? AND query_key = ? AND access_context_revision = ? AND schema_version = ?')
    .get(MAX_STAGED_BYTES, repositoryId, query.scope, queryKey, query.accessContextRevision, query.schemaVersion) as StagedRow | undefined;
  if (!row) return null;
  const decoded = decodeStaged(row, query.scope);
  if (decoded === null) { deleteStagedRow(db, repositoryId, query.scope, queryKey, query.accessContextRevision, query.schemaVersion); return null; }
  return decoded;
}

/** 暂存条目仍须通过本地内容的结构校验；合法JSON不等于合法栏目内容。 */
function validStagedItem(scope: DetailScope, value: unknown): boolean {
  if (scope === 'commits') return isLocalColumnItemValid('commits', value);
  if (scope === 'builds') return isLocalColumnItemValid('builds', value);
  if (scope === 'readme') return isLocalColumnItemValid('readmes', value);
  if (scope === 'tree') return isLocalColumnItemValid('tree', value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (scope === 'releases') return item.kind === 'release' ? isLocalColumnItemValid('releases', item) : item.kind === 'tag' && isLocalColumnItemValid('tags', item);
  if (scope === 'issuesAndPr') return item.kind === 'issue' ? isLocalColumnItemValid('issues', item) : item.kind === 'pull' && isLocalColumnItemValid('pullRequests', item);
  return scope === 'overview' && typeof item.values === 'object' && item.values !== null && typeof item.metadata === 'object' && item.metadata !== null;
}

function decodeStaged(row: StagedRow, scope: DetailScope): StagedScopeState | null {
  if (row.cursor === null || row.payload === null) return null;
  try {
    const parsed = JSON.parse(row.payload) as { items?: unknown; fingerprint?: unknown; version?: unknown; pages?: unknown; bytes?: unknown };
    if (!Array.isArray(parsed.items) || !parsed.items.every(item => validStagedItem(scope, item))) return null;
    if (parsed.fingerprint !== undefined && typeof parsed.fingerprint !== 'string') return null;
    if (parsed.version !== undefined && (typeof parsed.version !== 'object' || parsed.version === null || Array.isArray(parsed.version) ||
      !Object.entries(parsed.version).every(([field, value]) => ['defaultBranch', 'headRevision', 'releaseRevision', 'tagRevision'].includes(field) && (value === null || typeof value === 'string')))) return null;
    if (typeof parsed.pages !== 'number' || !Number.isSafeInteger(parsed.pages) || parsed.pages < 0) return null;
    if (typeof parsed.bytes !== 'number' || !Number.isFinite(parsed.bytes) || parsed.bytes < 0 || parsed.bytes > MAX_STAGED_BYTES) return null;
    return {
      items: parsed.items,
      cursor: row.cursor,
      ...(typeof parsed.fingerprint === 'string' ? { fingerprint: parsed.fingerprint } : {}),
      ...(parsed.version !== undefined ? { version: parsed.version as Partial<ContentVersion> } : {}),
      pages: parsed.pages,
      bytes: stagedItemsBytes(parsed.items),
    };
  } catch { return null; }
}

/** 保存/覆盖本批进度；超出暂存预算时返回 false（调用方按未完成处理并清理）。 */
export function writeStagedScope(db: LocalDatabase, repositoryId: number, query: StagedScopeQuery, state: StagedScopeState, savedAt: string): boolean {
  if (state.cursor === null || state.bytes > MAX_STAGED_BYTES) return false;
  const payload = JSON.stringify({ ...(state.fingerprint !== undefined ? { fingerprint: state.fingerprint } : {}), ...(state.version !== undefined ? { version: state.version } : {}), pages: state.pages, bytes: state.bytes, items: state.items });
  if (new TextEncoder().encode(payload).byteLength > MAX_STAGED_BYTES) return false;
  db.prepare(
    `INSERT INTO cache_query_page (repository_id, scope, query_key, access_context_revision, schema_version, payload, cursor, next_cursor, has_more, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
     ON CONFLICT(repository_id, scope, query_key) DO UPDATE SET
       access_context_revision = excluded.access_context_revision, schema_version = excluded.schema_version,
       payload = excluded.payload, cursor = excluded.cursor, next_cursor = NULL, has_more = 1, saved_at = excluded.saved_at`,
  ).run(repositoryId, query.scope, stagedQueryKey(query), query.accessContextRevision, query.schemaVersion, payload, state.cursor, savedAt);
  return true;
}

/** 丢弃某范围的全部暂存（完成、窗口重建或无法继续）。 */
export function clearStagedScope(db: LocalDatabase, repositoryId: number, scope: DetailScope): void {
  db.prepare('DELETE FROM cache_query_page WHERE repository_id = ? AND scope = ?').run(repositoryId, scope);
}

/** 只保留当前窗口身份的暂存行；参数漂移（上限/分支变化）的旧行不可接续。 */
export function pruneStagedQueries(db: LocalDatabase, repositoryId: number, query: StagedScopeQuery): void {
  db.prepare('DELETE FROM cache_query_page WHERE repository_id = ? AND scope = ? AND query_key <> ?').run(repositoryId, query.scope, stagedQueryKey(query));
}

/** 清理其他访问上下文或缓存 schema 的暂存：Token 更换、schema 升级后旧片段不得回填。 */
export function pruneForeignStagedScopes(db: LocalDatabase, repositoryId: number, accessContextRevision: number, schemaVersion: number): void {
  db.prepare('DELETE FROM cache_query_page WHERE repository_id = ? AND (access_context_revision <> ? OR schema_version <> ?)')
    .run(repositoryId, accessContextRevision, schemaVersion);
}

/** 当前上下文与 schema 下仍有暂存进度的范围；用于计划下一批继续，而不是永久从头重读。 */
export function pendingStagedScopes(db: LocalDatabase, repositoryId: number, accessContextRevision: number, schemaVersion: number): DetailScope[] {
  const rows = db.prepare('SELECT DISTINCT scope FROM cache_query_page WHERE repository_id = ? AND access_context_revision = ? AND schema_version = ? ORDER BY scope')
    .all(repositoryId, accessContextRevision, schemaVersion) as Array<{ scope: string }>;
  return rows.map(row => row.scope as DetailScope);
}

/** 片段 JSON 体积估计：用于暂存预算，不做二次序列化。 */
export function stagedItemsBytes(items: readonly unknown[]): number {
  return new TextEncoder().encode(JSON.stringify(items)).byteLength;
}
