/**
 * 详情页数据协调：把「打开意图 / 强制命令 / 只读本地读取」三个入口、React Query 的 L1 展示缓存
 * 与后台任务的轻量状态轮询接在一起，供 DetailPage 消费（对应设计 4.5 / 4.6 / 12.1 / 12.2）。
 *
 * 数据流：
 *   每次实际导航 → 表达一次打开意图（fetchDetail）：主进程立即返回本地视图并按需安排后台任务；
 *   任务存在 → 700ms 只读 status 轮询（只读本地、绝不产生 GitHub 请求）；
 *   内容版本变化 → 只读 view 重读当前 Tab 的范围，其他范围的有效字段 / 状态 / 游标与窗口原样保留；
 *   用户翻页 → 用绑定版本与访问上下文的游标读下一页，只替换该范围当前窗口；
 *   用户重新抓取 / 错误重试 → 强制命令 refreshRepository(id, true)，失败保留旧内容与局部错误。
 *
 * L1 与 L2：展示快照存在 `['detail', id]` 这个 Query 缓存里，不活动 60 秒后回收；回收后再次进入
 * 先重新读取 L2（本地数据库），不把内存未命中当成远端详情不存在。
 *
 * 异步隔离：所有外部结果都必须过同一套校验——仓库身份、挂载生命周期、缓存重置世代、访问上下文
 * 与权威版本不得倒退；任一项不满足就整份丢弃，绝不写回 Query 或已卸载组件的本地状态。
 * Query 只作 L1 载体、不挂自动回填的 queryFn，全部写入都走这套校验，因此不存在绕过校验的路径。
 * 忙碌状态属于命令自己：强制命令的收尾只认自己那一次，不被只读读取作废，也不误解锁其他命令。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type {
  ColumnName,
  ColumnResult,
  Detail,
  DetailResult,
  DetailScope,
  Glance,
  LocalReadResult,
  NormalizedError,
  PaginationCursor,
  ScopeSyncState,
  TaskSnapshot,
} from '../../shared/types';
import { LOCAL_READ_DEFAULT_LIMIT, LOCAL_READ_MAX_LIMIT } from '../../shared/types';
import { getApi } from './api';

/** 详情页会展示的范围：README / 目录树尚无 Tab，因此不读其本地页、不持有其L1内容；README仍由主进程采集。 */
const DISPLAY_SCOPES: readonly DetailScope[] = ['overview', 'releases', 'commits', 'issuesAndPr', 'builds', 'trends'];

/** 范围到详情字段的唯一映射（与主进程的栏目投影一致）：只读回某范围时，其余字段沿用上一份。 */
const SCOPE_FIELDS: Record<DetailScope, readonly (keyof Detail)[]> = {
  overview: ['metadata'],
  releases: ['releases', 'tags'],
  commits: ['commits'],
  issuesAndPr: ['issues', 'pullRequests'],
  builds: ['build', 'builds'],
  readme: ['readmes'],
  tree: ['tree'],
  trends: ['trend'],
};

/** 栏目到范围的映射（与主进程一致）：只读回部分范围时，栏位状态也按范围取舍。 */
const COLUMN_SCOPE_NAMES: Record<ColumnName, DetailScope> = {
  overview: 'overview',
  releases: 'releases',
  tags: 'releases',
  commits: 'commits',
  issues: 'issuesAndPr',
  pullRequests: 'issuesAndPr',
  builds: 'builds',
  readme: 'readme',
  tree: 'tree',
};

/** 任务存在期间的本地状态轮询间隔（只读状态，不是 GitHub 轮询）。 */
const STATUS_POLL_MS = 700;
/** 非活动展示数据的有限保留时间：回收后再次进入先读 L2。 */
const DETAIL_GC_MS = 60_000;
/** 单次 IPC 的每范围条目上限：任何一次读取都不超过它，更多内容靠游标续读而不是扩大窗口。 */
const PAGE_LIMIT = LOCAL_READ_MAX_LIMIT;

const BRIDGE_FAILURE: NormalizedError = { kind: 'unknown', message: '抓取全量信息失败，请稍后重试' };

/**
 * 每个范围的有界分页窗口。L1 只持有当前这一页的内容；游标链记录到达各页的请求游标，
 * 游标由主进程绑定仓库、访问上下文与内容版本，换版后旧链一律失效、必须从首页重读。
 */
export interface ScopeWindow {
  trendWindow?: string;
  /** 趋势窗口按组合展示版本校验，详情范围仍按权威详情版本校验。 */
  viewVersion: number;
  /** 首页返回的实际预算；后退时沿用它，避免同页换成不同片段。 */
  firstPageLimit: number;
  /** 该窗口内容对应的权威详情版本。 */
  detailViewVersion: number;
  accessContextRevision: number;
  /** chain[0] 恒为 null（首页）；chain[k] 是第 k+1 页的请求游标。 */
  chain: PaginationCursor[];
  /** 当前页下标（0 起）。 */
  index: number;
}

/** 展示快照：页面需要的全部本地视图事实，存在 Query 缓存里。 */
export interface DetailViewSnapshot {
  trendWindow?: string;
  repositoryId: number;
  accessContextRevision: number;
  /** 组合展示版本：详情或趋势任一变化都会改变。 */
  viewVersion: number;
  /** 权威详情版本：展示确认与续读游标按它比对。 */
  detailViewVersion: number;
  detail: Detail | null;
  /** 已按页读取的范围窗口。 */
  windows: Partial<Record<DetailScope, ScopeWindow>>;
  /** 范围只交付了一部分或读取失败；旧内容可展示，但不能确认成最新完整范围。 */
  incomplete?: Partial<Record<DetailScope, boolean>>;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  syncState: Partial<Record<DetailScope, ScopeSyncState>>;
  task: TaskSnapshot | null;
  summaryFetchedAt: string | null;
  detailFetchedAt: string | null;
  error: NormalizedError | null;
}

export interface DetailViewOptions {
  repositoryId: number;
  /** 当前活动 Tab 需要读取的本地范围（含本地趋势视图与表头依赖的范围）。 */
  readScopes: readonly DetailScope[];
  /** 当前实际展示、可确认的远端范围；由页面按活动 Tab 给出（trends 是本地视图，不参与确认）。 */
  confirmScopes: readonly DetailScope[];
}

/** 单个范围的分页状态，供页面渲染上一页 / 下一页。 */
export interface ScopePaging {
  scope: DetailScope;
  /** 1 起的页码。 */
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export interface DetailView {
  snapshot: DetailViewSnapshot | null;
  detail: Detail | null;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  syncState: Partial<Record<DetailScope, ScopeSyncState>>;
  task: TaskSnapshot | null;
  /** 当前展示范围里本地还有下一页的范围。 */
  partial: Partial<Record<DetailScope, boolean>>;
  /** 已按页读取、可翻页的范围。 */
  paging: Partial<Record<DetailScope, ScopePaging>>;
  error: NormalizedError | null;
  summaryFetchedAt: string | null;
  detailFetchedAt: string | null;
  /** 初次没有可展示内容、打开意图仍在途：整页 Loading。 */
  loading: boolean;
  /** 强制同步或后台任务进行中：强制入口禁用。 */
  busy: boolean;
  forceRefresh(): void;
  /** 翻页：-1 = 上一页，1 = 下一页。 */
  goPage(scope: DetailScope, direction: -1 | 1): void;
}

function isRunning(task: TaskSnapshot | null | undefined): boolean {
  return task != null && (task.status === 'queued' || task.status === 'running');
}

function emptySnapshot(repositoryId: number, accessContextRevision = 0): DetailViewSnapshot {
  return {
    repositoryId,
    accessContextRevision,
    viewVersion: 0,
    detailViewVersion: 0,
    detail: null,
    windows: {},
    columns: {},
    syncState: {},
    task: null,
    summaryFetchedAt: null,
    detailFetchedAt: null,
    error: null,
  };
}

function readView(queryClient: QueryClient, key: readonly unknown[]): DetailViewSnapshot | undefined {
  return queryClient.getQueryData<DetailViewSnapshot>(key);
}

/** 打开 / 强制结果含全部展示范围：窗口一律从首页重建，游标链只记主进程给出的下一页。 */
function windowsFromFullResult(
  cursors: Partial<Record<DetailScope, PaginationCursor>> | undefined,
  detailViewVersion: number,
  accessContextRevision: number,
  viewVersion: number,
  trendWindow?: string,
): Partial<Record<DetailScope, ScopeWindow>> {
  const windows: Partial<Record<DetailScope, ScopeWindow>> = {};
  for (const scope of DISPLAY_SCOPES) {
    const next = cursors?.[scope] ?? null;
    windows[scope] = {
      ...(scope === 'trends' ? { trendWindow } : {}),
      viewVersion,
      firstPageLimit: LOCAL_READ_DEFAULT_LIMIT,
      detailViewVersion,
      accessContextRevision,
      chain: next === null ? [null] : [null, next],
      index: 0,
    };
  }
  return windows;
}

function hasNext(window: ScopeWindow | undefined): boolean {
  return window !== undefined && window.index + 1 < window.chain.length;
}

/** 读取结果写入窗口：把这些范围的游标链推进到目标页，并记下该窗口对应的版本与上下文。 */
function advanceWindows(
  base: Partial<Record<DetailScope, ScopeWindow>>,
  scopes: readonly DetailScope[],
  targets: Partial<Record<DetailScope, number>>,
  reset: ReadonlySet<DetailScope>,
  detailViewVersion: number,
  accessContextRevision: number,
  nextCursors: Partial<Record<DetailScope, PaginationCursor>> | undefined,
  viewVersion: number,
  pageLimit: number,
  trendWindow?: string,
): Partial<Record<DetailScope, ScopeWindow>> {
  const windows = { ...base };
  for (const scope of scopes) {
    const current = base[scope];
    const target = reset.has(scope) || current === undefined ? 0 : targets[scope] ?? current.index;
    const chain = current === undefined || reset.has(scope) ? [null] : current.chain.slice(0, target + 1);
    const next = nextCursors?.[scope] ?? null;
    if (next !== null && chain.length === target + 1) chain.push(next);
    windows[scope] = {
      ...(scope === 'trends' ? { trendWindow } : {}),
      viewVersion, detailViewVersion, accessContextRevision, chain, index: target,
      firstPageLimit: target === 0 ? pageLimit : current?.firstPageLimit ?? LOCAL_READ_DEFAULT_LIMIT,
    };
  }
  return windows;
}

function sameVersionsOrNewer(previous: DetailViewSnapshot | undefined, result: { viewVersion?: number; detailViewVersion?: number }): boolean {
  if (!previous) return true;
  if (result.detailViewVersion !== undefined && result.detailViewVersion < previous.detailViewVersion) return false;
  if (result.viewVersion !== undefined && result.viewVersion < previous.viewVersion) return false;
  return true;
}

/** 稳定序列化展示事实：忽略缺省字段，明确 null 和同毫秒的不同事实仍可区分。 */
function stableFact(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).filter(([, field]) => field !== undefined).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

/** 缺省字段保留已知值，明确 null 则删除旧事实；先后顺序由调用方的 Query/请求校验决定。 */
export function mergeSummary(previous: Glance | undefined, incoming: Glance): Glance {
  return { ...previous, ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined)) } as Glance;
}

/** 使用实际版本与变化账本；不把确认序号、任务运行拍数当作新的打开意图。 */
function openFact(glance: Glance | undefined, view: Pick<DetailViewSnapshot, 'accessContextRevision' | 'viewVersion' | 'detailViewVersion' | 'syncState'>): string {
  return stableFact([glance, view.accessContextRevision, view.viewVersion, view.detailViewVersion,
    Object.fromEntries(DISPLAY_SCOPES.map(scope => {
      const state = view.syncState[scope];
      return [scope, state && {
        detectedRevision: state.detectedRevision, syncedRevision: state.syncedRevision, importantRevision: state.importantRevision,
        observedFingerprint: state.observedFingerprint, syncedFingerprint: state.syncedFingerprint,
        cacheStatus: state.cacheStatus, freshness: state.freshness,
        dirtyReasons: state.dirtyReasons,
        lastCheckFailure: state.lastCheckFailure, lastSyncFailure: state.lastSyncFailure,
        lastCheckError: state.lastCheckError, lastSyncError: state.lastSyncError,
      }];
    })),
  ]);
}

const COLUMN_FIELDS: Partial<Record<ColumnName, readonly (keyof Detail)[]>> = {
  overview: ['metadata'], releases: ['releases'], tags: ['tags'], commits: ['commits'],
  issues: ['issues'], pullRequests: ['pullRequests'], builds: ['build', 'builds'],
};

/** 只采纳确实交付的栏目；坏游标会缺少该范围 columns，即使 detail 非空、cacheStatus valid。 */
function scopeDelivery(result: Pick<DetailResult, 'detail' | 'columns' | 'syncState' | 'error'>, scopes: readonly DetailScope[], legacy = false) {
  const fields = new Set<keyof Detail>();
  const complete: DetailScope[] = [];
  for (const scope of scopes) {
    if (!result.detail) continue;
    const state = result.syncState?.[scope];
    if (state && state.cacheStatus !== 'valid') continue;
    if (scope === 'trends') { fields.add('trend'); complete.push(scope); continue; }
    const names = (Object.keys(COLUMN_SCOPE_NAMES) as ColumnName[]).filter(name => COLUMN_SCOPE_NAMES[name] === scope);
    const delivered = names.filter(name => {
      const column = result.columns?.[name];
      return column?.status === 'success' || column?.status === 'empty';
    });
    for (const name of delivered) for (const field of COLUMN_FIELDS[name] ?? []) fields.add(field);
    // 概览可由旧库元数据证明交付；缺元信息的旧完整成功结果仍兼容，错误结果不走此回退。
    const fallback = (scope === 'overview' && result.detail.metadata != null && state?.cacheStatus === 'valid')
      || (legacy && result.columns === undefined && result.syncState === undefined && result.error === null);
    if (fallback) for (const field of SCOPE_FIELDS[scope]) fields.add(field);
    if (fallback || delivered.length === names.length) complete.push(scope);
  }
  return { fields, complete };
}

function mergeDelivered(base: Detail | null, incoming: Detail | null, fields: ReadonlySet<keyof Detail>): Detail | null {
  if (!incoming) return base;
  const merged: Detail = base ? { ...base, repository: mergeSummary(base.repository, incoming.repository) } : {
    repository: incoming.repository, releases: [], tags: [], commits: [], issues: [], pullRequests: [],
    builds: [], readmes: [], tree: [], trend: [], build: { status: 'none', conclusion: null, workflowName: null, url: null, finishedAt: null },
  };
  for (const field of fields) {
    const value = incoming[field];
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[field] = value;
  }
  return merged;
}

export function useDetailView({ repositoryId, readScopes, confirmScopes }: DetailViewOptions): DetailView {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['detail', repositoryId] as const, [repositoryId]);
  const queryHash = useMemo(() => JSON.stringify(queryKey), [queryKey]);

  const [opening, setOpening] = useState(true);
  const [forcing, setForcing] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  /** 缓存被外部重置的次数（驱动一次按新上下文的重读）。 */
  const [epoch, setEpoch] = useState(0);

  /** 挂载生命周期：卸载后任何迟到回包都不得写 Query 或本地状态。 */
  const lifeRef = useRef<{ live: boolean }>({ live: true });
  /** 展示缓存被外部重置 / 移除的次数：在途的旧上下文回包不得回填。 */
  const generationRef = useRef(0);
  /** 打开意图序号：只用于"整页 Loading"的收尾，重叠的打开互不取消。 */
  const openSeqRef = useRef(0);
  /** 强制命令序号：忙碌收尾只认自己的那一次，不被只读读取或更晚的命令作废。 */
  const forceSeqRef = useRef(0);
  /** 只读读取序号：按范围记账，保证同一范围只被最新一次读取写入。 */
  const readSeqRef = useRef(0);
  const scopeReadSeqRef = useRef<Partial<Record<DetailScope, number>>>({});
  const pageBusyRef = useRef(false);
  /** 当前活动 Tab 的读取范围（轮询回调读取它，不依赖闭包）。 */
  const readScopesRef = useRef(readScopes);
  readScopesRef.current = readScopes;
  /** 已表达过打开意图的清单事实签名：同一份清单事实只补一次打开，避免验证 / 同步回路。 */
  const openedFactRef = useRef<string | null>(null);
  const internalListWriteRef = useRef(false);
  const summaryRevisionRef = useRef(0);
  const listSeqRef = useRef(0);
  const probeSeqRef = useRef(0);
  /** 清单事实探针与任务轮询共用在途 status，任何时刻只发一个状态 IPC。 */
  const statusFlightRef = useRef<Promise<LocalReadResult> | null>(null);
  const confirmKeyRef = useRef<string | null>(null);

  // Query 只作 L1 载体：不自定义读取，全部写入都经 commit 的统一校验；queryFn 永不被调用。
  const query = useQuery({
    queryKey,
    networkMode: 'always',
    staleTime: Infinity,
    gcTime: DETAIL_GC_MS,
    enabled: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryFn: async () => readView(queryClient, queryKey) ?? emptySnapshot(repositoryId),
  });

  const snapshot = query.data ?? null;

  // 每次 setup 都创建新对象，effect 重放不能让旧 setup 的迟到回包重新变成 live。
  useEffect(() => {
    const life = { live: true };
    lifeRef.current = life;
    return () => { life.live = false; };
  }, []);

  const readStatus = useCallback(async (isCurrent: () => boolean): Promise<LocalReadResult | null> => {
    const life = lifeRef.current;
    const generation = generationRef.current;
    while (statusFlightRef.current) {
      try { await statusFlightRef.current; } catch { /* 在途失败后仍允许下一次真实读取。 */ }
      if (!life.live || generation !== generationRef.current || !isCurrent()) return null;
    }
    if (!life.live || generation !== generationRef.current || !isCurrent()) return null;
    const flight = getApi().readLocalDetail(repositoryId, { mode: 'status' });
    statusFlightRef.current = flight;
    try {
      const result = await flight;
      return life.live && generation === generationRef.current && isCurrent() ? result : null;
    }
    finally { if (statusFlightRef.current === flight) statusFlightRef.current = null; }
  }, [repositoryId]);

  /**
   * 统一提交入口：仓库身份、挂载生命周期、重置世代、访问上下文与版本倒退逐项校验，
   * 任一不满足就整份丢弃。返回是否真的写入。
   */
  const commit = useCallback((repositoryIdOfResult: number, patch: {
    accessContextRevision?: number;
    viewVersion?: number;
    detailViewVersion?: number;
    next: (previous: DetailViewSnapshot | undefined) => DetailViewSnapshot;
  }, gate: { generation: number; life: { live: boolean } }): boolean => {
    if (!gate.life.live) return false;
    if (gate.generation !== generationRef.current) return false;
    if (repositoryIdOfResult !== repositoryId) return false;
    const previous = readView(queryClient, queryKey);
    if (previous && patch.accessContextRevision !== undefined && patch.accessContextRevision < previous.accessContextRevision) return false;
    // 同访问上下文（或结果未声明上下文）时版本不得倒退：先到的更新版本不能被迟到的旧版本覆盖。
    if (previous
      && (patch.accessContextRevision === undefined || patch.accessContextRevision === previous.accessContextRevision)
      && !sameVersionsOrNewer(previous, patch)) return false;
    queryClient.setQueryData(queryKey, patch.next(previous));
    return true;
  }, [queryClient, queryKey, repositoryId]);

  /** 读取主进程的权威清单事实与顺序；手动提交也须通过生命周期、上下文与 Query 世代校验。 */
  const alignListSummary = useCallback(async (): Promise<void> => {
    const life = lifeRef.current;
    const generation = generationRef.current;
    const seq = ++listSeqRef.current;
    const listQuery = queryClient.getQueryCache().find({ queryKey: ['repositories'], exact: true });
    const count = listQuery?.state.dataUpdateCount;
    const previous = readView(queryClient, queryKey);
    if (!listQuery || !previous) return;
    const token = queryClient.getQueryData<{ accessContextRevision?: number; cleanupPending?: boolean }>(['accessTokenState']);
    try {
      const repositories = await getApi().listRepositories();
      const current = readView(queryClient, queryKey);
      const nextToken = queryClient.getQueryData<typeof token>(['accessTokenState']);
      if (!life.live || generation !== generationRef.current || seq !== listSeqRef.current
        || listQuery !== queryClient.getQueryCache().find({ queryKey: ['repositories'], exact: true })
        || count !== listQuery.state.dataUpdateCount || !current
        || current.accessContextRevision !== previous.accessContextRevision
        || current.viewVersion !== previous.viewVersion || current.detailViewVersion !== previous.detailViewVersion
        || nextToken?.accessContextRevision !== token?.accessContextRevision || nextToken?.cleanupPending) return;
      // 只沿用缺省可选字段；顺序完全采用主进程结果，不在 renderer 选择活动时间或重新排序。
      const existing = queryClient.getQueryData<Glance[]>(['repositories']);
      const authoritative = repositories.map(item => mergeSummary(
        item.id === repositoryId ? current.detail?.repository : existing?.find(entry => entry.id === item.id), item));
      internalListWriteRef.current = true;
      try { queryClient.setQueryData(['repositories'], authoritative); }
      finally { internalListWriteRef.current = false; }
      summaryRevisionRef.current += 1;
      const glance = authoritative.find(item => item.id === repositoryId);
      if (glance && current.detail) {
        commit(repositoryId, { next: base => ({ ...(base ?? current), detail: { ...current.detail!, repository: glance } }) }, { generation, life });
      }
      openedFactRef.current = openFact(glance, current);
    } catch {
      // 只读清单失败保留侧栏，下一次成功路径可再次协调。
    }
  }, [commit, queryClient, queryKey, repositoryId]);

  /** 打开 / 强制结果按栏目交付事实采纳，完整范围窗口回到首页，受损范围保留旧窗口。 */
  const commitFullResult = useCallback((result: DetailResult, gate: { generation: number; life: { live: boolean }; summaryRevision: number }): boolean => {
    const detail = result.detail;
    if (detail && detail.repository.id !== repositoryId) return false;
    const accessContextRevision = result.accessContextRevision;
    const detailViewVersion = result.detailViewVersion;
    const viewVersion = result.viewVersion;
    return commit(repositoryId, { accessContextRevision, viewVersion, detailViewVersion, next: (previous) => {
      const contextChanged = previous !== undefined && accessContextRevision !== undefined
        && accessContextRevision !== previous.accessContextRevision;
      const base = contextChanged ? undefined : previous;
      const revision = accessContextRevision ?? base?.accessContextRevision ?? 0;
      const version = detailViewVersion ?? base?.detailViewVersion ?? 0;
      const delivery = scopeDelivery(result, DISPLAY_SCOPES, true);
      let mergedDetail = mergeDelivered(base?.detail ?? null, detail, delivery.fields);
      const currentSummary = queryClient.getQueryData<Glance[]>(['repositories'])?.find(item => item.id === repositoryId);
      // 请求开始后已接收更新摘要事实：旧同毫秒响应不得复活已删除 tag 或已恢复的失败。
      if (mergedDetail && currentSummary && gate.summaryRevision !== summaryRevisionRef.current) mergedDetail = { ...mergedDetail, repository: mergeSummary(mergedDetail.repository, currentSummary) };
      const allWindows = windowsFromFullResult(result.cursors, version, revision, viewVersion ?? base?.viewVersion ?? 0, result.trendWindow ?? base?.trendWindow);
      const windows = { ...base?.windows };
      const incomplete = { ...base?.incomplete };
      const columns = { ...base?.columns, ...result.columns };
      for (const scope of DISPLAY_SCOPES) {
        if (!detail) continue;
        incomplete[scope] = !delivery.complete.includes(scope);
        if (delivery.complete.includes(scope)) windows[scope] = allWindows[scope];
      }
      return {
        repositoryId,
        accessContextRevision: revision,
        viewVersion: viewVersion ?? base?.viewVersion ?? 0,
        detailViewVersion: version,
        trendWindow: result.trendWindow ?? base?.trendWindow,
        detail: mergedDetail,
        windows,
        incomplete,
        columns,
        syncState: { ...base?.syncState, ...result.syncState },
        task: result.task !== undefined ? result.task : base?.task ?? null,
        summaryFetchedAt: result.summaryFetchedAt !== undefined ? result.summaryFetchedAt : base?.summaryFetchedAt ?? null,
        detailFetchedAt: result.detailFetchedAt !== undefined ? result.detailFetchedAt : base?.detailFetchedAt ?? null,
        error: result.error,
      };
    } }, gate);
  }, [commit, queryClient, repositoryId]);

  /**
   * 只读读取若干范围：每个范围按自己的窗口当前页（或指定页）取游标，单次 itemLimit 不超过上限。
   * 读回后只更新这些范围的字段、栏位、状态与窗口，其他范围原样保留。
   */
  const readScopesInto = useCallback(async (
    scopes: readonly DetailScope[],
    options: { reset?: readonly DetailScope[]; page?: { scope: DetailScope; index: number } } = {},
  ): Promise<void> => {
    if (scopes.length === 0) return;
    const life = lifeRef.current;
    const generation = generationRef.current;
    const seq = ++readSeqRef.current;
    const summaryRevision = summaryRevisionRef.current;
    // 缓存被清空（Token 更换后的重读）也可以从空基线重建；其余调用点都已确保有已展示内容。
    const previous = readView(queryClient, queryKey) ?? emptySnapshot(repositoryId);
    const reset = new Set(options.reset ?? []);
    const targets: Partial<Record<DetailScope, number>> = {};
    const cursors: Partial<Record<DetailScope, PaginationCursor>> = {};
    for (const scope of scopes) {
      const window = previous.windows[scope];
      const target = options.page?.scope === scope ? options.page.index : (reset.has(scope) || window === undefined ? 0 : window.index);
      targets[scope] = target;
      const cursor = target > 0 && !reset.has(scope) ? window?.chain[target] : null;
      if (cursor != null) cursors[scope] = cursor;
      scopeReadSeqRef.current[scope] = seq;
    }
    let result: LocalReadResult;
    const pageLimit = options.page?.index === 0
      ? previous.windows[options.page.scope]?.firstPageLimit ?? LOCAL_READ_DEFAULT_LIMIT
      : PAGE_LIMIT;
    try {
      result = await getApi().readLocalDetail(repositoryId, {
        mode: 'view',
        scopes: [...scopes],
        itemLimit: pageLimit,
        ...(Object.keys(cursors).length > 0 ? { cursors } : {}),
      });
    } catch {
      return; // 只读读取失败不改动已展示内容，保留上一份。
    }
    const owned = scopes.filter((scope) => scopeReadSeqRef.current[scope] === seq);
    const currentView = readView(queryClient, queryKey);
    if (result.repositoryId !== repositoryId || !life.live || generation !== generationRef.current || owned.length === 0
      || (currentView && result.accessContextRevision < currentView.accessContextRevision)
      || (currentView && result.accessContextRevision === currentView.accessContextRevision && !sameVersionsOrNewer(currentView, result))) return;
    if (Object.keys(cursors).length > 0
      && (result.accessContextRevision !== previous.accessContextRevision
        || result.detailViewVersion !== previous.detailViewVersion
        || (scopes.includes('trends') && (result.viewVersion !== previous.viewVersion || result.trendWindow !== previous.trendWindow)))) {
      // 带旧游标的回包可能仍带空范围对象，换版时重读首页，不能把它当新页推进。
      await readScopesInto(owned, { reset: owned });
      return;
    }
    // 只写入仍归本次读取所有的范围：更晚的读取已经接手的不再回写。
    const accessContextRevision = result.accessContextRevision;
    const detailViewVersion = result.detailViewVersion;
    const committed = commit(repositoryId, { accessContextRevision, viewVersion: result.viewVersion, detailViewVersion, next: (current) => {
      const base = current ?? previous;
      const contextChanged = accessContextRevision !== base.accessContextRevision;
      const origin = contextChanged ? undefined : base;
      const delivery = scopeDelivery(result, owned);
      // 趋势没有栏目回执；带游标却只有空投影和错误时无法证明交付，保守保留旧页。
      if (cursors.trends != null && result.error && !result.detail?.trend.length) {
        delivery.complete = delivery.complete.filter(scope => scope !== 'trends');
      }
      // 组合分页只有完整交付才能换页；首页可接收成功栏目，失败栏目沿用旧值并标记不完整。
      for (const scope of owned) {
        if (cursors[scope] != null && !delivery.complete.includes(scope)) {
          for (const field of SCOPE_FIELDS[scope]) delivery.fields.delete(field);
        }
      }
      let detail = mergeDelivered(origin?.detail ?? null, result.detail, delivery.fields);
      const currentSummary = queryClient.getQueryData<Glance[]>(['repositories'])?.find(item => item.id === repositoryId);
      if (detail && currentSummary && summaryRevision !== summaryRevisionRef.current) detail = { ...detail, repository: mergeSummary(detail.repository, currentSummary) };
      const columns: Partial<Record<ColumnName, ColumnResult>> = { ...origin?.columns };
      const syncState = { ...origin?.syncState };
      const incomplete = { ...origin?.incomplete };
      for (const name of Object.keys(result.columns) as ColumnName[]) {
        const column = result.columns[name];
        if (column !== undefined && owned.includes(COLUMN_SCOPE_NAMES[name])) columns[name] = column;
      }
      for (const scope of owned) {
        if (result.syncState[scope]) syncState[scope] = result.syncState[scope];
        incomplete[scope] = !delivery.complete.includes(scope);
      }
      return {
        repositoryId,
        accessContextRevision,
        viewVersion: contextChanged ? result.viewVersion : Math.max(origin?.viewVersion ?? 0, result.viewVersion),
        detailViewVersion,
        trendWindow: result.trendWindow ?? origin?.trendWindow,
        detail,
        windows: advanceWindows(origin?.windows ?? {}, delivery.complete, targets, reset, detailViewVersion, accessContextRevision, result.cursors, result.viewVersion, pageLimit, result.trendWindow ?? origin?.trendWindow),
        incomplete,
        columns,
        syncState,
        task: result.task,
        summaryFetchedAt: result.summaryFetchedAt,
        detailFetchedAt: result.detailFetchedAt,
        error: result.error,
      };
    } }, { generation, life });
    if (committed) await alignListSummary();
  }, [alignListSummary, commit, queryClient, queryKey, repositoryId]);

  /**
   * 打开意图：每次实际导航都表达一次（含 L1 仍 fresh 的重进），主进程据此立即返回本地视图
   * 并按需计划后台任务。
   *
   * 重叠的打开（例如导航打开与清单触发的打开）不互相取消：两份回包都走统一校验，版本更旧的那份
   * 自然被丢弃；这里只用一个打开序号管住"整页 Loading"的收尾，避免先到的那份提前解除忙碌。
   */
  const requestOpen = useCallback((requestedFact?: string): (() => void) => {
    const life = lifeRef.current;
    const generation = generationRef.current;
    const seq = ++openSeqRef.current;
    const summaryRevision = summaryRevisionRef.current;
    if (requestedFact !== undefined) openedFactRef.current = requestedFact;
    setOpening(true);
    void (async () => {
      let result: DetailResult;
      try {
        result = await getApi().fetchDetail(repositoryId);
      } catch {
        result = { detail: null, error: BRIDGE_FAILURE };
      }
      if (!life.live) return;
      if (seq === openSeqRef.current) setOpening(false);
      const committed = commitFullResult(result, { generation, life, summaryRevision });
      if (committed && result.detail !== null) {
        const current = readView(queryClient, queryKey)!;
        openedFactRef.current = openFact(current.detail?.repository, current);
        void alignListSummary();
      } else if (generation === generationRef.current && readView(queryClient, queryKey) === undefined) {
        void readScopesInto(readScopesRef.current);
      }
    })();
    return () => {};
  }, [alignListSummary, commitFullResult, queryClient, queryKey, readScopesInto, repositoryId]);

  useEffect(() => requestOpen(), [requestOpen]);

  /** 缓存被外部重置：在途回包已按世代作废，这里按新上下文重读当前 Tab 的范围。 */
  useEffect(() => {
    if (epoch === 0) return;
    void readScopesInto(readScopesRef.current, { reset: readScopesRef.current });
  }, [epoch, readScopesInto]);

  /** 切到别的 Tab：该 Tab 的范围若还停在旧版本 / 没有窗口，就地读一次（无 GitHub 请求）。 */
  const readScopesKey = readScopes.join(',');
  useEffect(() => {
    const current = readView(queryClient, queryKey);
    if (!current?.detail) return;
    const stale = readScopes.filter((scope) => {
      const window = current.windows[scope];
      return window === undefined
        || window.detailViewVersion !== current.detailViewVersion
        || window.accessContextRevision !== current.accessContextRevision
        || (scope === 'trends' && (window.viewVersion !== current.viewVersion || window.trendWindow !== current.trendWindow));
    });
    if (stale.length === 0) return;
    void readScopesInto(stale, { reset: stale });
  }, [readScopesKey, readScopes, readScopesInto, queryClient, queryKey]);

  // 展示缓存被外部重置 / 移除：给在途请求换代，旧上下文回包不得回填。
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    return cache.subscribe((event) => {
      if (JSON.stringify(event.query.queryKey) !== queryHash) return;
      if (event.type === 'removed') {
        generationRef.current += 1;
        return;
      }
      if (event.type !== 'updated' || event.action.type !== 'setState') return;
      generationRef.current += 1;
      setEpoch(generationRef.current);
    });
  }, [queryClient, queryHash]);

  /** 强制命令：独立命令序号；成功 / 失败 / 被作废都只释放自己的忙碌状态，数据提交另走统一校验。 */
  const forceRefresh = useCallback((): void => {
    const api = getApi();
    if (!api.refreshRepository) return;
    const life = lifeRef.current;
    const generation = generationRef.current;
    const command = ++forceSeqRef.current;
    const summaryRevision = summaryRevisionRef.current;
    setForcing(true);
    void (async () => {
      let result: DetailResult;
      try {
        result = await api.refreshRepository!(repositoryId, true);
      } catch {
        result = { detail: null, error: { kind: 'network', message: '重新抓取失败，请稍后重试' } };
      }
      if (life.live && command === forceSeqRef.current) setForcing(false);
      if (commitFullResult(result, { generation, life, summaryRevision }) && result.detail !== null) {
        const current = readView(queryClient, queryKey)!;
        openedFactRef.current = openFact(current.detail?.repository, current);
        void alignListSummary();
      }
    })();
    return undefined;
  }, [alignListSummary, commitFullResult, queryClient, queryKey, repositoryId]);

  /** 翻页：用目标页的游标读一次，只替换该范围当前窗口。 */
  const goPage = useCallback((scope: DetailScope, direction: -1 | 1): void => {
    const current = readView(queryClient, queryKey);
    const window = current?.windows[scope];
    if (!window || pageBusyRef.current) return;
    const target = window.index + direction;
    if (target < 0 || target >= window.chain.length) return;
    pageBusyRef.current = true;
    void readScopesInto([scope], { page: { scope, index: target } }).finally(() => { pageBusyRef.current = false; });
  }, [queryClient, queryKey, readScopesInto]);

  /**
   * 一拍轻量状态：相同内容版本只更新任务 / 范围状态与两个成功时间；
   * 出现新内容版本才重读当前 Tab 的范围，其他范围窗口原样保留。
   */
  const handleStatus = useCallback(async (status: LocalReadResult): Promise<void> => {
    if (status.repositoryId !== repositoryId) return;
    const life = lifeRef.current;
    const generation = generationRef.current;
    const previous = readView(queryClient, queryKey);
    if (!previous) return;
    if (status.accessContextRevision > previous.accessContextRevision) {
      // 访问上下文已变化：旧内容与旧游标全部作废，按新上下文重读当前 Tab。
      commit(repositoryId, {
        accessContextRevision: status.accessContextRevision,
        viewVersion: status.viewVersion,
        detailViewVersion: status.detailViewVersion,
        next: (current) => {
          const base = current ?? previous;
          return {
            ...base,
            accessContextRevision: status.accessContextRevision,
            viewVersion: status.viewVersion,
            detailViewVersion: status.detailViewVersion,
            detail: null,
            windows: {},
            incomplete: {},
            columns: {},
            task: status.task,
            error: null,
          };
        },
      }, { generation, life });
      await readScopesInto(readScopesRef.current, { reset: readScopesRef.current });
      return;
    }
    if (status.accessContextRevision < previous.accessContextRevision) return; // 迟到的旧上下文
    if (status.detailViewVersion < previous.detailViewVersion || status.viewVersion < previous.viewVersion) return;
    const trendWindow = status.trendWindow ?? previous.trendWindow;
    const versionChanged = status.viewVersion !== previous.viewVersion || status.detailViewVersion !== previous.detailViewVersion || trendWindow !== previous.trendWindow;
    const committed = commit(repositoryId, {
      accessContextRevision: status.accessContextRevision,
      viewVersion: Math.max(previous.viewVersion, status.viewVersion),
      detailViewVersion: Math.max(previous.detailViewVersion, status.detailViewVersion),
      next: (current) => {
        const base = current ?? previous;
        return {
          ...base,
          task: status.task,
          syncState: status.syncState,
          summaryFetchedAt: status.summaryFetchedAt,
          detailFetchedAt: status.detailFetchedAt,
          error: status.error,
          viewVersion: Math.max(base.viewVersion, status.viewVersion),
          detailViewVersion: Math.max(base.detailViewVersion, status.detailViewVersion),
          trendWindow,
        };
      },
    }, { generation, life });
    if (!committed || !versionChanged) return;
    // 版本推进：游标绑定内容版本，旧窗口一律作废并从首页重读当前 Tab 的范围。
    await readScopesInto(readScopesRef.current, { reset: readScopesRef.current });
  }, [commit, queryClient, queryKey, readScopesInto, repositoryId]);

  /** 真实 Query 成功事件即使保持同一条目也读取事实；自己的只读对齐写入不产生打开意图。 */
  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== 'repositories') return;
    if (event.type === 'removed' || (event.type === 'updated' && event.action.type === 'setState')) {
      generationRef.current += 1;
      probeSeqRef.current += 1;
      return;
    }
    if (event.type !== 'updated' || event.action.type !== 'success' || internalListWriteRef.current) return;
    summaryRevisionRef.current += 1;
    const seq = ++probeSeqRef.current;
    const glance = (event.query.state.data as Glance[] | undefined)?.find(item => item.id === repositoryId);
    if (!glance) return;
    const life = lifeRef.current;
    const generation = generationRef.current;
    void (async () => {
      try {
        const status = await readStatus(() => seq === probeSeqRef.current);
        if (!status) return;
        const previous = readView(queryClient, queryKey);
        if (!life.live || generation !== generationRef.current || seq !== probeSeqRef.current
          || status.repositoryId !== repositoryId || (previous && status.accessContextRevision !== previous.accessContextRevision)
          || !sameVersionsOrNewer(previous, status)) return;
        const fact = openFact(mergeSummary(previous?.detail?.repository, glance), status);
        if (openedFactRef.current !== fact) {
          requestOpen(fact);
        } else {
          await handleStatus(status);
        }
      } catch {
        // 状态读取失败不猜 freshness，也不反复自动打开。
      }
    })();
  }), [handleStatus, queryClient, queryKey, readStatus, repositoryId, requestOpen]);

  // 任务存在期间的轻量状态轮询：只读 status，非重叠；结束、切仓、离开、页面隐藏都会停。
  const task = snapshot?.task ?? null;
  const polling = isRunning(task) && !hidden;
  useEffect(() => {
    if (!polling) return;
    let live = true;
    let timer: number | null = null;
    let inFlight = false;
    const tick = async (): Promise<void> => {
      if (!live || inFlight) return;
      inFlight = true;
      try {
        const status = await readStatus(() => live);
        if (!live || !status) return;
        await handleStatus(status);
      } catch {
        // 单次状态读取失败不改动展示，下一拍继续。
      } finally {
        inFlight = false;
        if (live) timer = window.setTimeout(() => { void tick(); }, STATUS_POLL_MS);
      }
    };
    timer = window.setTimeout(() => { void tick(); }, STATUS_POLL_MS);
    return () => {
      live = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [polling, handleStatus, readStatus, repositoryId]);

  useEffect(() => {
    const onVisibility = (): void => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // 展示确认：render 之后按实际显示、且确实展示到该版本全量的范围确认，旧版本与截断范围都不确认。
  useEffect(() => {
    if (hidden || !snapshot?.detail) return;
    const scopes = confirmScopes.filter((scope) => {
      const window = snapshot.windows[scope];
      return window !== undefined
        && window.detailViewVersion === snapshot.detailViewVersion
        && window.accessContextRevision === snapshot.accessContextRevision
        && window.index === 0
        && !hasNext(window)
        && snapshot.incomplete?.[scope] !== true
        && snapshot.syncState[scope]?.cacheStatus === 'valid';
    });
    if (scopes.length === 0) return;
    const key = `${snapshot.detailViewVersion}|${snapshot.accessContextRevision}|${scopes.join(',')}`;
    if (confirmKeyRef.current === key) return;
    confirmKeyRef.current = key;
    void getApi().acknowledgeRepositoryViewed(repositoryId, {
      detailViewVersion: snapshot.detailViewVersion,
      accessContextRevision: snapshot.accessContextRevision,
      scopes,
    }).catch(() => {
      // 确认失败不冒充成功；下次可见内容更新或重新进入范围时允许重试。
      if (confirmKeyRef.current === key) confirmKeyRef.current = null;
    });
  }, [confirmScopes, hidden, repositoryId, snapshot]);

  const partial = useMemo(() => {
    const result: Partial<Record<DetailScope, boolean>> = {};
    for (const scope of readScopes) {
      const window = snapshot?.windows[scope];
      if (hasNext(window) || (window !== undefined && window.index > 0) || snapshot?.incomplete?.[scope]) result[scope] = true;
    }
    return result;
  }, [readScopes, snapshot]);

  const paging = useMemo(() => {
    const result: Partial<Record<DetailScope, ScopePaging>> = {};
    for (const scope of readScopes) {
      const window = snapshot?.windows[scope];
      if (window === undefined) continue;
      const next = hasNext(window);
      if (!next && window.index === 0) continue;
      result[scope] = { scope, page: window.index + 1, hasPrev: window.index > 0, hasNext: next };
    }
    return result;
  }, [readScopes, snapshot]);

  const busy = opening || forcing || isRunning(task);
  const loading = snapshot?.detail == null && snapshot?.error == null && (opening || snapshot === null);

  return {
    snapshot,
    detail: snapshot?.detail ?? null,
    columns: snapshot?.columns ?? {},
    syncState: snapshot?.syncState ?? {},
    task,
    partial,
    paging,
    error: snapshot?.error ?? null,
    summaryFetchedAt: snapshot?.summaryFetchedAt ?? null,
    detailFetchedAt: snapshot?.detailFetchedAt ?? null,
    loading,
    busy,
    forceRefresh,
    goPage,
  };
}
