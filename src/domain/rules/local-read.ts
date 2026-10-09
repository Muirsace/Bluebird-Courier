import type { BuildInfo, DetailScope, DetailValues } from '../types';
import { LOCAL_READ_DEFAULT_LIMIT, LOCAL_READ_MAX_LIMIT } from '../types';
import { DETAIL_SYNC_SCOPES, SCOPE_ORDER } from './detail-scope';

export interface LocalQueryIdentity {
  repositoryId: number;
  accessContextRevision: number;
  viewVersion: number;
  fetchedAt: string | null;
}

/** 同一范围的多个栏目共用总预算；非法预算回到缺省值。 */
export function localReadLimit(value?: number): number {
  return Number.isFinite(value) ? Math.min(LOCAL_READ_MAX_LIMIT, Math.max(1, Math.floor(value!))) : LOCAL_READ_DEFAULT_LIMIT;
}
export function selectedLocalScopes(scopes?: readonly DetailScope[]): DetailScope[] {
  return scopes === undefined ? [...DETAIL_SYNC_SCOPES, 'trends'] : SCOPE_ORDER.filter(scope => scopes.includes(scope));
}
/** 续读绑定仓库、上下文、内容版本和范围；失效返回 null，不能把旧 offset 用在新窗口。 */
export function localReadOffset(cursor: string | null | undefined, scope: DetailScope, identity: LocalQueryIdentity): number | null {
  if (cursor == null) return 0;
  if (cursor.length > 4096) return null;
  try {
    const value = JSON.parse(cursor) as LocalQueryIdentity & { scope?: unknown; offset?: unknown };
    return value.repositoryId === identity.repositoryId && value.accessContextRevision === identity.accessContextRevision &&
      value.viewVersion === identity.viewVersion && value.fetchedAt === identity.fetchedAt && value.scope === scope &&
      typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : null;
  } catch { return null; }
}
export function localReadCursor(scope: DetailScope, offset: number, identity: LocalQueryIdentity): string {
  return JSON.stringify({ ...identity, scope, offset });
}
export function emptyLocalBuild(): BuildInfo {
  return { status: 'none', workflowName: null, url: null, finishedAt: null, resultDescription: null };
}

/** 无已选远端内容时，仅为独立本地范围提供结构；缓存可用性仍由范围状态表达。 */
export function emptyLocalValues(): DetailValues {
  return { releases: [], commits: [], issues: [], pullRequests: [], tags: [], builds: [], readmes: [], tree: [], build: emptyLocalBuild() };
}
