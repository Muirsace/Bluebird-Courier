import { PortFailure } from '../../../../domain/ports';
import type { OverviewContent, ScopeFetchOutcome, ScopeFetchPort, ScopePartName, ScopePartResult } from '../../../../domain/ports';
import type { BuildItem, CommitItem, DetailScope, DetailValues, Glance, GlanceValues, NormalizedError, ReadmeDocument, ReleaseItem, RepositoryMetadata, TagItem, TreeEntry } from '../../../../domain/types';
import { emptyLocalBuild } from '../../../../domain/rules/local-read';
import { REMOTE_SCOPES, SCOPE_COLUMNS } from '../../../../domain/rules/detail-scope';
import type { ColumnName, ColumnResult } from '../contract';
import { aggregateColumns } from './column-aggregator';
import { stagedItemsBytes, type StagedScopeState } from './staged-scope';

/**
 * 单次任务对单个范围的采集页数上限（每页条目由请求 limit 决定）。
 * 这是每批的预算：超过上限时把已处理片段与续读游标暂存，下一批从续读点继续，
 * 不再每次从头重读，也不靠提高本常量掩盖大树。
 */
export const MAX_COLLECT_PAGES = 30;

/** 每批可续读的暂存句柄；由调用方按仓库、访问上下文、schema 与查询参数构建。 */
export interface ScopeStaging {
  /** 读取同一窗口的既有进度；身份不匹配或不可接续时返回 null。 */
  read(): StagedScopeState | null;
  /** 保存本批进度；超出暂存预算返回 false。 */
  save(state: StagedScopeState, savedAt: string): boolean;
  /** 丢弃该范围暂存（完整覆盖、窗口重建或无法继续）。 */
  clear(): void;
}

export interface CollectedScope {
  outcome: ScopeFetchOutcome;
  /** 本轮未完成但已保存可续读进度：不是失败，也不得据正确认覆盖。 */
  staged: boolean;
  /** 供应商阻塞（限流/认证）：应停止后续 HTTP；已取得片段仍可安全提交。 */
  blocked?: NormalizedError;
}

/** 供应商级阻塞：限流与令牌无效都必须停止后续请求（与上下文变化、任务过期的整批放弃不同）。 */
function blockingError(errors: readonly NormalizedError[] | undefined): NormalizedError | undefined {
  return errors?.find(error => error.kind === 'access_token_invalid' || error.kind === 'rate_limited');
}

function isBlocking(error: unknown): error is PortFailure {
  return error instanceof PortFailure && (error.kind === 'access_token_invalid' || error.kind === 'rate_limited');
}

/**
 * 有界续读同一采集窗口：历史 hasMore 不等于未覆盖，窗口重启必须丢弃旧片段。
 * 存在暂存时从上次的片段与游标接续；本轮仍不完整则保存进度供下一批继续。
 */
export async function collectScope(port: ScopeFetchPort, token: string, request: Parameters<ScopeFetchPort['fetchScope']>[1], writable: () => boolean, staging?: ScopeStaging): Promise<CollectedScope> {
  const resumed = staging?.read() ?? null;
  let cursor = resumed?.cursor ?? request.cursor;
  let items: unknown[] = resumed?.items ?? [];
  let fingerprint = resumed?.fingerprint;
  let pages = resumed?.pages ?? 0;
  let bytes = resumed?.bytes ?? 0;
  const resumeCursor = cursor;
  let last: ScopeFetchOutcome | null = null;
  for (let page = 0; page < MAX_COLLECT_PAGES; page++) {
    if (!writable()) throw new Error('任务结果已过期，停止范围读取');
    const result = await port.fetchScope(token, { ...request, cursor });
    last = result;
    if (result.scope !== request.scope || result.accessContextRevision !== request.accessContextRevision) throw new Error('范围结果身份不匹配');
    if (!writable()) throw new Error('任务结果已过期，放弃范围结果');
    // 阻塞也可能只来自同范围的一侧来源；身份有效时保留本次另一侧真实成功的条目。
    const blocked = blockingError(result.errors);
    if (blocked) {
      if (result.windowRestarted) { items = []; fingerprint = undefined; staging?.clear(); }
      return { outcome: { ...result, items: [...items, ...result.items], coverageComplete: false, fingerprint: undefined }, staged: false, blocked };
    }
    // 窗口变化/重启：丢弃旧窗口已读片段（含既有暂存）与指纹，按新游标重读同一稳定窗口。
    if (result.windowRestarted) {
      items = []; fingerprint = undefined; pages = 0; bytes = 0;
      cursor = result.nextCursor;
      if (cursor === null) break;
      continue;
    }
    // 来源失败：不再续读；成功来源的栏目仍可按部分结果提交。
    if (Object.values(result.parts ?? {}).some(part => part?.ok === false)) {
      staging?.clear();
      return { outcome: { ...result, items: [...items, ...result.items], coverageComplete: false, fingerprint: undefined }, staged: false };
    }
    items.push(...result.items);
    bytes += stagedItemsBytes(result.items);
    pages += 1;
    fingerprint ??= result.fingerprint;
    if (result.coverageComplete) {
      if (!fingerprint || Object.values(result.parts ?? {}).some(part => part?.coverageComplete === false)) {
        staging?.clear();
        return { outcome: { ...result, items, coverageComplete: false, fingerprint: undefined }, staged: false };
      }
      staging?.clear();
      return { outcome: { ...result, items, fingerprint }, staged: false };
    }
    const next = result.nextCursor;
    // 游标未前进（异常适配器）：停止续读，不保留无法推进的暂存。
    if (next !== null && next === cursor) { staging?.clear(); break; }
    if (next === null) break; // 无更多页（含服务端截断）：本窗口无法完成
    cursor = next;
  }
  if (!last) throw new Error(request.scope + ' 未取得任何范围内容');
  const partial: ScopeFetchOutcome = { ...last, items, coverageComplete: false, fingerprint: undefined };
  // 仍可从续读点继续、且本轮确实前进过：保存进度供下一批接续（不是失败）。
  const canContinue = last.nextCursor !== null && cursor !== null && cursor !== resumeCursor;
  if (staging && canContinue && staging.save({ items, cursor, ...(fingerprint !== undefined ? { fingerprint } : {}), pages, bytes }, last.observedAt)) {
    return { outcome: partial, staged: true };
  }
  staging?.clear();
  return { outcome: partial, staged: false };
}

/** 未完成原因：服务端截断与普通预算未完成分别明示，都不确认覆盖。 */
function incompleteReason(scope: DetailScope, outcome: ScopeFetchOutcome): string {
  if (outcome.hasMore && outcome.nextCursor === null) return scope + ' 服务端响应不完整（截断），保留旧内容与未确认状态';
  return scope + ' 覆盖尚未完成，保留未确认状态';
}

/** 本次完整获取中单个范围的交付结果：成功来源的栏目可更新，全部必要来源完整覆盖时才可确认。 */
export interface ScopeDelivery {
  scope: DetailScope;
  complete: boolean;
  fingerprint?: string;
  values: Partial<DetailValues>;
  columns: Partial<Record<ColumnName, ColumnResult>>;
}

export interface LoadedFullDetail {
  /** 建立缓存所需的完整 payload 视图；失败来源是空数组，失败范围由栏目状态另行标记。 */
  values: DetailValues;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  deliveries: ScopeDelivery[];
  observation?: { values: GlanceValues; observedAt: string };
  failures: Partial<Record<DetailScope, string>>;
  failureErrors: Partial<Record<DetailScope, unknown>>;
  /** 本轮未完成但已保存可续读暂存的范围：不写错误、不替换旧值，下一批接续。 */
  stagedScopes: DetailScope[];
  /** 供应商阻塞已停止后续 HTTP 时的归一化错误；未尝试范围按此原因保留旧值并明示不可提交。 */
  blocked?: NormalizedError;
}

/** 按范围给出暂存句柄；参数变化时返回的句柄自带身份校验。 */
export type OpenScopeStaging = (scope: DetailScope, params: { fullName: string; defaultBranch: string | null; limit: number }) => ScopeStaging | undefined;

function sourceDelivered(outcome: ScopeFetchOutcome, name: ScopePartName): boolean {
  const part = outcome.parts?.[name];
  return part === undefined ? outcome.coverageComplete : part.ok && part.coverageComplete;
}

/** 结合来源级状态判定范围是否完整覆盖：任一来源失败或未交付都不能确认组合目标与指纹。 */
function scopeFullyCovered(outcome: ScopeFetchOutcome): boolean {
  if (!outcome.coverageComplete || outcome.fingerprint === undefined) return false;
  return Object.values(outcome.parts ?? {}).every((part): part is ScopePartResult => part !== undefined && part.ok && part.coverageComplete);
}

/**
 * 完整获取使用真实范围结果：概览失败必须保留旧概览；各范围独立记录失败。
 * 上下文变化、仓库删除与任务过期是整批放弃条件；限流/令牌失败只停止后续 HTTP，
 * 已取得的可信范围仍返回给调用方原子提交，未完成范围保留旧值与 dirty。
 */
export async function loadFullDetail(port: ScopeFetchPort, token: string, repository: Glance, defaultBranch: string | null, revision: number, now: () => string, writable: () => boolean, openStaging?: OpenScopeStaging, onObserved?: (observation: NonNullable<LoadedFullDetail['observation']>) => void): Promise<LoadedFullDetail> {
  const limit = 50;
  const request = (scope: DetailScope) => ({ scope, fullName: repository.fullName, defaultBranch, accessContextRevision: revision, observedAt: now(), cursor: null, limit });
  const failures: Partial<Record<DetailScope, string>> = {};
  const failureErrors: Partial<Record<DetailScope, unknown>> = {};
  const stagedScopes: DetailScope[] = [];
  const outcomes = new Map<DetailScope, ScopeFetchOutcome>();
  const failedOutcome = (scope: DetailScope): ScopeFetchOutcome => ({ scope, items: [], coverageComplete: false, hasMore: false, nextCursor: null, accessContextRevision: revision, observedAt: now() });
  const stagingFor = (scope: DetailScope) => openStaging?.(scope, { fullName: repository.fullName, defaultBranch, limit });
  let blocked: NormalizedError | undefined;
  let content: OverviewContent | undefined;

  const record = (scope: DetailScope, collected: CollectedScope): ScopeFetchOutcome => {
    outcomes.set(scope, collected.outcome);
    if (collected.blocked) {
      blocked ??= collected.blocked;
      failures[scope] = collected.blocked.message;
      failureErrors[scope] = new PortFailure(collected.blocked.kind, collected.blocked.message, collected.blocked.resetAt);
    } else if (collected.staged) {
      stagedScopes.push(scope);
    } else if (!collected.outcome.coverageComplete || collected.outcome.fingerprint === undefined) {
      failures[scope] = incompleteReason(scope, collected.outcome);
      const sourceError = collected.outcome.errors?.[0];
      if (sourceError) failureErrors[scope] = new PortFailure(sourceError.kind, sourceError.message, sourceError.resetAt);
    }
    return collected.outcome;
  };

  // 概览先行（提供默认分支与摘要），失败或阻塞都不再拖垮整批。
  try {
    const collected = await collectScope(port, token, request('overview'), writable, stagingFor('overview'));
    const outcome = record('overview', collected);
    const candidate = outcome.items[0] as OverviewContent | undefined;
    // 只有完整取得的概览才能作为摘要观察与默认分支来源；暂存/阻塞/缺失都不冒充。
    if (!collected.blocked && !collected.staged) {
      if (candidate?.values && candidate.metadata) { content = candidate; defaultBranch = candidate.metadata.defaultBranch ?? defaultBranch; }
      else if (failures.overview === undefined) failures.overview = '概览内容缺失，不能确认覆盖';
      // 摘要独立于后续内容范围，取得真实概览即通知；监听器失败不改变采集或提交算法。
      if (outcome.coverageComplete && content && writable()) {
        try { onObserved?.({ values: content.values, observedAt: outcome.observedAt }); } catch { /* 采样故障由接收者持久补偿 */ }
      }
    }
  } catch (error) {
    if (!writable()) throw error;
    if (isBlocking(error)) {
      blocked = { kind: error.kind, message: error.message, ...(error.resetAt ? { resetAt: error.resetAt } : {}) };
      failures.overview = error.message;
      failureErrors.overview = error;
    } else {
      failures.overview = error instanceof Error ? error.message : '概览请求失败';
      failureErrors.overview = error;
    }
    outcomes.set('overview', failedOutcome('overview'));
  }

  for (const scope of REMOTE_SCOPES) {
    if (scope === 'overview' || blocked) continue;
    try {
      record(scope, await collectScope(port, token, request(scope), writable, stagingFor(scope)));
    } catch (error) {
      if (!writable()) throw error; // 上下文变化/仓库删除/任务过期：整批放弃
      outcomes.set(scope, failedOutcome(scope));
      if (isBlocking(error)) {
        blocked = { kind: error.kind, message: error.message, ...(error.resetAt ? { resetAt: error.resetAt } : {}) };
        failures[scope] = error.message;
        failureErrors[scope] = error;
        break;
      }
      failures[scope] = error instanceof Error ? error.message : '范围请求失败';
      failureErrors[scope] = error;
    }
  }

  // 被供应商阻塞而未尝试的范围：保留旧值与 dirty，按阻塞原因明示不可提交。
  for (const scope of REMOTE_SCOPES) {
    if (outcomes.has(scope)) continue;
    outcomes.set(scope, failedOutcome(scope));
    if (blocked) {
      failures[scope] = blocked.message;
      failureErrors[scope] = new PortFailure(blocked.kind, blocked.message, blocked.resetAt);
    }
  }

  const overviewOutcome = outcomes.get('overview')!;
  const releaseItems = outcomes.get('releases')!.items as Array<(ReleaseItem | TagItem) & { kind: 'release' | 'tag' }>;
  const collaboration = outcomes.get('issuesAndPr')!.items as Array<DetailValues['issues'][number] & { kind: 'issue' | 'pull' }>;
  const builds = outcomes.get('builds')!.items as BuildItem[];
  const releases = releaseItems.filter(item => item.kind === 'release').map(({ kind: _kind, ...item }) => item) as ReleaseItem[];
  const tags = releaseItems.filter(item => item.kind === 'tag').map(({ kind: _kind, ...item }) => item) as TagItem[];
  const commits = outcomes.get('commits')!.items as CommitItem[];
  const issues = collaboration.filter(item => item.kind === 'issue').map(({ kind: _kind, ...item }) => item);
  const pullRequests = collaboration.filter(item => item.kind === 'pull').map(({ kind: _kind, ...item }) => item);
  const readmes = outcomes.get('readme')!.items as ReadmeDocument[];
  const tree = outcomes.get('tree')!.items as TreeEntry[];
  const values: DetailValues = {
    ...(content?.metadata ? { metadata: content.metadata as RepositoryMetadata } : {}),
    releases, tags, commits, issues, pullRequests,
    builds, build: builds[0] ?? emptyLocalBuild(),
    readmes, tree,
  };
  const columns = aggregateColumns({ overview: { ...repository, ...(content?.values ?? {}) }, releases, tags, commits, issues, pullRequests, builds, readme: readmes, tree });

  const pickColumns = (names: readonly ColumnName[]): Partial<Record<ColumnName, ColumnResult>> => {
    const picked: Partial<Record<ColumnName, ColumnResult>> = {};
    for (const name of names) { const column = columns[name]; if (column) picked[name] = column; }
    return picked;
  };
  const delivery = (outcome: ScopeFetchOutcome, write: { values: Partial<DetailValues>; names: readonly ColumnName[] }): ScopeDelivery => ({
    scope: outcome.scope,
    complete: scopeFullyCovered(outcome),
    ...(outcome.fingerprint !== undefined ? { fingerprint: outcome.fingerprint } : {}),
    values: write.values,
    columns: pickColumns(write.names),
  });

  const releasesOutcome = outcomes.get('releases')!;
  const issuesOutcome = outcomes.get('issuesAndPr')!;
  const overviewComplete = scopeFullyCovered(overviewOutcome);
  const commitsComplete = scopeFullyCovered(outcomes.get('commits')!);
  const buildsComplete = scopeFullyCovered(outcomes.get('builds')!);
  const readmeComplete = scopeFullyCovered(outcomes.get('readme')!);
  const treeComplete = scopeFullyCovered(outcomes.get('tree')!);
  const releasesDelivered = sourceDelivered(releasesOutcome, 'releases');
  const tagsDelivered = sourceDelivered(releasesOutcome, 'tags');
  const issuesDelivered = sourceDelivered(issuesOutcome, 'issues');
  const pullsDelivered = sourceDelivered(issuesOutcome, 'pullRequests');
  const deliveries: ScopeDelivery[] = [
    delivery(overviewOutcome, { values: overviewComplete && content?.metadata ? { metadata: content.metadata as RepositoryMetadata } : {}, names: overviewComplete ? SCOPE_COLUMNS.overview ?? [] : [] }),
    delivery(releasesOutcome, {
      values: { ...(releasesDelivered ? { releases } : {}), ...(tagsDelivered ? { tags } : {}) },
      names: [...(releasesDelivered ? ['releases'] as const : []), ...(tagsDelivered ? ['tags'] as const : [])],
    }),
    delivery(outcomes.get('commits')!, { values: commitsComplete ? { commits } : {}, names: commitsComplete ? ['commits'] : [] }),
    delivery(issuesOutcome, {
      values: { ...(issuesDelivered ? { issues } : {}), ...(pullsDelivered ? { pullRequests } : {}) },
      names: [...(issuesDelivered ? ['issues'] as const : []), ...(pullsDelivered ? ['pullRequests'] as const : [])],
    }),
    delivery(outcomes.get('builds')!, { values: buildsComplete ? { builds, build: values.build } : {}, names: buildsComplete ? ['builds'] : [] }),
    delivery(outcomes.get('readme')!, { values: readmeComplete ? { readmes } : {}, names: readmeComplete ? ['readme'] : [] }),
    delivery(outcomes.get('tree')!, { values: treeComplete ? { tree } : {}, names: treeComplete ? ['tree'] : [] }),
  ];

  const deliveredColumns = new Set<string>(deliveries.flatMap(delivery => Object.keys(delivery.columns)));
  // 暂存范围仍在续读：栏目标为加载中，既不当作失败也不冒充空成功。
  for (const scope of stagedScopes) for (const name of SCOPE_COLUMNS[scope] ?? []) {
    if (deliveredColumns.has(name)) continue;
    const column = columns[name];
    if (column) { column.status = 'loading'; column.value = null; column.error = null; }
  }
  // 失败范围的栏目：来源级成功的栏目保留真实内容，其余标记失败供展示层明示。
  for (const [scope, message] of Object.entries(failures)) for (const name of SCOPE_COLUMNS[scope as DetailScope] ?? []) {
    if (deliveredColumns.has(name)) continue;
    const column = columns[name];
    if (column) { column.status = 'failed'; column.error = { kind: 'unknown', message: message!, fullName: repository.fullName }; column.hasMore = outcomes.get(scope as DetailScope)?.hasMore; column.cursor = outcomes.get(scope as DetailScope)?.nextCursor;
      if (Array.isArray(column.value) && column.value.length === 0) column.value = null;
    }
  }
  return { values, columns, deliveries, failures, failureErrors, stagedScopes,
    ...(blocked ? { blocked } : {}),
    ...(overviewOutcome.coverageComplete && content ? { observation: { values: content.values, observedAt: overviewOutcome.observedAt } } : {}) };
}
