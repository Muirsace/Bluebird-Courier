import { PortFailure } from '../../../../domain/ports';
import type { OverviewContent, ScopeFetchOutcome, ScopeFetchPort } from '../../../../domain/ports';
import type { BuildItem, CommitItem, DetailScope, DetailValues, Glance, GlanceValues, ReadmeDocument, ReleaseItem, RepositoryMetadata, TagItem, TreeEntry } from '../../../../domain/types';
import { emptyLocalBuild } from '../../../../domain/rules/local-read';
import { REMOTE_SCOPES, SCOPE_COLUMNS } from '../../../../domain/rules/detail-scope';
import type { ColumnName, ColumnResult } from '../contract';
import { aggregateColumns } from './column-aggregator';

export interface LoadedFullDetail {
  values: DetailValues;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  fingerprints: Partial<Record<DetailScope, string>>;
  observation?: { values: GlanceValues; observedAt: string };
  failures: Partial<Record<DetailScope, string>>;
  failureErrors: Partial<Record<DetailScope, unknown>>;
}

/** 有界补齐同一采集窗口；历史 hasMore 不等于未覆盖，窗口重启必须丢弃旧片段。 */
export async function collectScope(port: ScopeFetchPort, token: string, request: Parameters<ScopeFetchPort['fetchScope']>[1], writable: () => boolean): Promise<ScopeFetchOutcome> {
  let cursor = request.cursor;
  let items: unknown[] = [];
  let fingerprint: string | undefined;
  let last: ScopeFetchOutcome | null = null;
  for (let page = 0; page < 3; page++) {
    if (!writable()) throw new Error('任务结果已过期，停止范围读取');
    const result = await port.fetchScope(token, { ...request, cursor });
    const fatal = result.errors?.find(error => error.kind === 'access_token_invalid' || error.kind === 'rate_limited');
    if (fatal) throw new PortFailure(fatal.kind, fatal.message, fatal.resetAt);
    last = result;
    if (result.scope !== request.scope || result.accessContextRevision !== request.accessContextRevision) throw new Error('范围结果身份不匹配');
    if (!writable()) throw new Error('任务结果已过期，放弃范围结果');
    if (result.windowRestarted) { items = []; fingerprint = undefined; cursor = result.nextCursor; if (cursor === null) break; continue; }
    if (Object.values(result.parts ?? {}).some(part => part?.ok === false)) return { ...result, items: [...items, ...result.items], coverageComplete: false, fingerprint: undefined };
    items.push(...result.items);
    fingerprint ??= result.fingerprint;
    if (result.coverageComplete) {
      if (!fingerprint || Object.values(result.parts ?? {}).some(part => part?.coverageComplete === false)) return { ...result, items, coverageComplete: false, fingerprint: undefined };
      return { ...result, items, fingerprint };
    }
    cursor = result.nextCursor;
    if (cursor === null) break;
  }
  if (last) return { ...last, items, coverageComplete: false, fingerprint: undefined };
  throw new Error(request.scope + ' 未取得任何范围内容');
}

/** 完整获取使用真实范围结果；任一必要范围不完整时不提交整套覆盖确认。 */
export async function loadFullDetail(port: ScopeFetchPort, token: string, repository: Glance, defaultBranch: string | null, revision: number, now: () => string, writable: () => boolean): Promise<LoadedFullDetail> {
  const request = (scope: DetailScope) => ({ scope, fullName: repository.fullName, defaultBranch, accessContextRevision: revision, observedAt: now(), cursor: null, limit: 50 });
  const overview = await collectScope(port, token, request('overview'), writable);
  const content = overview.items[0] as OverviewContent | undefined;
  if (!content?.values || !content.metadata) throw new Error('概览内容缺失，不能确认覆盖');
  defaultBranch = content.metadata.defaultBranch;
  const scopes = REMOTE_SCOPES.filter(scope => scope !== 'overview');
  const failures: Partial<Record<DetailScope, string>> = {};
  const failureErrors: Partial<Record<DetailScope, unknown>> = {};
  const results: ScopeFetchOutcome[] = [];
  for (const scope of scopes) {
    try { results.push(await collectScope(port, token, request(scope), writable)); }
    catch (error) {
      if (!writable() || error instanceof PortFailure && (error.kind === 'access_token_invalid' || error.kind === 'rate_limited')) throw error;
      failures[scope] = error instanceof Error ? error.message : '范围请求失败';
      failureErrors[scope] = error;
      results.push({ scope, items: [], coverageComplete: false, hasMore: false, nextCursor: null, accessContextRevision: revision, observedAt: now() });
    }
  }
  const outcomes = new Map<DetailScope, ScopeFetchOutcome>([['overview', overview], ...results.map(result => [result.scope, result] as [DetailScope, ScopeFetchOutcome])]);
  const releaseItems = outcomes.get('releases')!.items as Array<(ReleaseItem | TagItem) & { kind: 'release' | 'tag' }>;
  const collaboration = outcomes.get('issuesAndPr')!.items as Array<DetailValues['issues'][number] & { kind: 'issue' | 'pull' }>;
  const builds = outcomes.get('builds')!.items as BuildItem[];
  const values: DetailValues = {
    metadata: content.metadata as RepositoryMetadata,
    releases: releaseItems.filter(item => item.kind === 'release').map(({ kind: _kind, ...item }) => item) as ReleaseItem[],
    tags: releaseItems.filter(item => item.kind === 'tag').map(({ kind: _kind, ...item }) => item) as TagItem[],
    commits: outcomes.get('commits')!.items as CommitItem[],
    issues: collaboration.filter(item => item.kind === 'issue').map(({ kind: _kind, ...item }) => item),
    pullRequests: collaboration.filter(item => item.kind === 'pull').map(({ kind: _kind, ...item }) => item),
    builds, build: builds[0] ?? emptyLocalBuild(),
    readmes: outcomes.get('readme')!.items as ReadmeDocument[],
    tree: outcomes.get('tree')!.items as TreeEntry[],
  };
  for (const [scope, result] of outcomes) if (!result.coverageComplete || !result.fingerprint) {
    const sourceError = result.errors?.[0];
    failures[scope] ??= sourceError?.message ?? scope + ' 覆盖尚未完成，保留未确认状态';
    if (sourceError) failureErrors[scope] ??= new PortFailure(sourceError.kind, sourceError.message, sourceError.resetAt);
  }
  const columns = aggregateColumns({ overview: { ...repository, ...content.values }, releases: values.releases, tags: values.tags!, commits: values.commits, issues: values.issues, pullRequests: values.pullRequests, builds, readme: values.readmes!, tree: values.tree! });
  for (const [scope, message] of Object.entries(failures)) for (const name of SCOPE_COLUMNS[scope as DetailScope] ?? []) {
    const column = columns[name];
    if (column) { column.status = 'failed'; column.error = { kind: 'unknown', message: message!, fullName: repository.fullName }; column.hasMore = outcomes.get(scope as DetailScope)?.hasMore; column.cursor = outcomes.get(scope as DetailScope)?.nextCursor;
      if (Array.isArray(column.value) && column.value.length === 0) column.value = null;
    }
  }
  return { values, columns, failures, failureErrors, fingerprints: Object.fromEntries([...outcomes].filter(([, result]) => result.coverageComplete && result.fingerprint).map(([scope, result]) => [scope, result.fingerprint!])),
    ...(overview.coverageComplete ? { observation: { values: content.values, observedAt: overview.observedAt } } : {}) };
}
