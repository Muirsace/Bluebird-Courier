/** 渲染层交互测试的公共装置：桩 window.bluebirdCourier + react-query 容器 + DOM 查询与事件辅助。 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { vi } from 'vitest';
import type {
  AddRepositoryResult, AccessTokenResult, ColumnName, ColumnResult, Detail, DetailResult, DetailScope,
  DisplayAcknowledgment, Glance, GitHubExternalTarget, BluebirdCourierBridge, LocalReadRequest,
  LocalReadResult, OpenExternalResult, PaginationCursor, ScopeSyncState, Snapshot, TaskSnapshot,
  CommitItem, IssueItem, PullRequestItem, ReleaseItem, NormalizedError,
} from '../../src/shared/types';
import { LOCAL_READ_DEFAULT_LIMIT, LOCAL_READ_MAX_LIMIT } from '../../src/shared/types';
import { App } from '../../src/renderer/pages/App';
import { ThemeProvider } from '../../src/renderer/lib/theme';

// react 18.3 的 act 需要这个环境标志，否则会在控制台告警
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------- 假系统主题：happy-dom 的 matchMedia 恒为浅色，这里换成可控的 ----------

let systemTheme: 'light' | 'dark' = 'light';
let reducedMotion = false;
let viewportWidth = 768;
const desktopListeners = new Set<() => void>();
const mediaListeners = new Set<() => void>();
const reducedMotionListeners = new Set<() => void>();

function installMatchMedia(): void {
  // 按查询串分别回答：主题读 prefers-color-scheme，动画降级读 prefers-reduced-motion。
  const matchMedia = (query: string): MediaQueryList => {
    const listeners = query === '(min-width: 900px)' ? desktopListeners : query.includes('prefers-reduced-motion') ? reducedMotionListeners : mediaListeners;
    const matchesNow = (): boolean => {
      if (query === '(min-width: 900px)') return viewportWidth >= 900;
      if (query.includes('prefers-reduced-motion')) return reducedMotion;
      if (query.includes('prefers-color-scheme')) return systemTheme === 'dark';
      return false;
    };
    const list = {
      media: query,
      get matches() {
        return matchesNow();
      },
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
      addListener: (listener: () => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: () => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => true,
    };
    return list as unknown as MediaQueryList;
  };
  window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
}

export function setViewportWidth(width: number): void {
  viewportWidth = width;
  for (const listener of desktopListeners) listener();
}

/** 模拟 Windows 切深色 / 浅色：改系统值并通知监听者，等价于 prefers-color-scheme 变化。 */
export function setSystemTheme(theme: 'light' | 'dark'): void {
  systemTheme = theme;
  for (const listener of mediaListeners) listener();
}

export function resetSystemTheme(): void {
  systemTheme = 'light';
  mediaListeners.clear();
}

/** 模拟系统"减少动态效果"开关（下一次挂载生效）。 */
export function setReducedMotion(reduce: boolean): void {
  reducedMotion = reduce;
  for (const listener of reducedMotionListeners) listener();
}

export function resetReducedMotion(): void {
  setReducedMotion(false);
}

// ---------- 桩门面 ----------

/**
 * 桥接调用计数：打开意图、强制命令、只读读取（分模式）与展示确认分别计数，
 * 让断言能区分"表达了打开意图"、"真的下了强制命令"和"只是读了本地状态"。
 */
export interface StubCalls {
  accessTokenState: number;
  saveAccessToken: number;
  validateAccessToken: number;
  getSettings: number;
  updateSettings: number;
  listRepositories: number;
  refreshGlance: number;
  /** 打开意图（fetchDetail）：每次实际导航各一次，不等待后台网络。 */
  fetchDetail: number;
  /** 强制命令（refreshRepository）：用户重新抓取与错误重试才走这里。 */
  refreshRepository: number;
  /** 只读本地读取总数，以及按模式拆分（status 只读轻量状态；view 读有界内容）。 */
  readLocalDetail: number;
  readLocalStatus: number;
  readLocalView: number;
  acknowledgeRepositoryViewed: number;
  addRepository: number;
  inspectRepositoryInput: number;
  removeRepository: number;
  openGitHubExternal: number;
}

/** 桩里的本地视图事实：版本、访问上下文、任务快照、两个成功时间与内容。 */
export interface StubLocalState {
  /** 本地 L2 没有可展示内容（离线未抓过 / 换上下文后已清理）。 */
  localEmpty: boolean;
  viewVersion: number;
  detailViewVersion: number;
  accessContextRevision: number;
  task: TaskSnapshot | null;
  /** null = 沿用当前 Summary 的 fetchedAt（真实摘要检查时间）。 */
  summaryFetchedAt: string | null;
  /** null = 尚未完整同步（首次部分成功或旧库未知）。 */
  detailFetchedAt: string | null;
  /** 详情内容夹具（完整列表；读取时按范围与游标做有界切片）。 */
  detailPatch: Partial<Detail>;
  /** 权威范围账本夹具：可模拟 Glance 未变但 HEAD/defaultBranch 已推进的重要序号。 */
  scopeState?: Partial<Record<DetailScope, Partial<ScopeSyncState>>>;
}

export interface StubReadRequest {
  repositoryId: number;
  mode: 'view' | 'status';
  scopes?: readonly DetailScope[];
  itemLimit?: number;
  cursors?: Partial<Record<DetailScope, PaginationCursor>>;
}

export interface StubHandle {
  api: BluebirdCourierBridge;
  calls: StubCalls;
  /** 桩里当前的偏好项（updateSettings 成功后同步）。 */
  readonly preferences: Record<string, string>;
  /** 收到过的 updateSettings 补丁，按顺序。 */
  settingsPatches: Array<Record<string, string>>;
  /** 收到过的外链目标，按顺序（断言"点了哪条外链"）。 */
  externalTargets: GitHubExternalTarget[];
  /** 收到过的新增仓库原始输入。 */
  addInputs: string[];
  /** 本地视图当前事实（只读快照）。 */
  readonly local: Readonly<StubLocalState>;
  /** 更新本地视图事实：版本推进、上下文更换、任务快照、时间与内容都从这里驱动。 */
  setLocal(patch: Partial<StubLocalState>): void;
  /** 主进程后台任务快照：非空期间页面应做只读状态轮询。 */
  setTask(task: TaskSnapshot | null): void;
  /** 收到过的强制命令（force 标志一并记录，不能伪装成打开意图）。 */
  refreshRequests: Array<{ repositoryId: number; force: boolean | undefined }>;
  /** 收到过的只读读取请求（用于核对范围、上限与模式）。 */
  readRequests: StubReadRequest[];
  /** 收到过的展示确认。 */
  acknowledgments: Array<DisplayAcknowledgment & { repositoryId: number }>;
  /** 下次 listRepositories 返回的清单（删除成功后用它模拟清单缩小）。 */
  setRepositories(repositories: Glance[]): void;
  /** 让下一次 listRepositories 挂起，返回放行函数。 */
  holdNextList(): () => void;
  /** 让下一次 refreshGlance 挂起，返回放行函数。 */
  holdNextRefresh(): () => void;
  /** 让下一次 removeRepository 挂起，返回放行函数。 */
  holdNextRemove(): () => void;
  /** 让下一次 addRepository 挂起，返回放行函数。 */
  holdNextAdd(): () => void;
  /** 让下一次 openGitHubExternal 挂起，返回放行函数。 */
  holdNextExternalLink(): () => void;
  /** 让下一次打开意图（fetchDetail）挂起，返回放行函数。 */
  holdNextOpen(): () => void;
  /** 让下一次强制命令（refreshRepository）挂起，返回放行函数。 */
  holdNextForce(): () => void;
  /** 让下一次只读 status 读取挂起，返回放行函数。 */
  holdNextStatus(): () => void;
  /** 让下一次只读 view 读取挂起，返回放行函数。 */
  holdNextView(): () => void;
  /**
   * 指定下一次打开意图的返回（一次性，之后回到默认行为）。
   * 用它可以改变返回内容而不绕过调用计数——直接覆盖 api 方法会让计数失真。
   */
  nextOpenResult(result: DetailResult): void;
  /** 指定下一次强制命令的返回（一次性，之后回到默认行为）。 */
  nextForceResult(result: DetailResult): void;
}

export interface StubOptions {
  repositories?: Glance[];
  /** 第 N 次调用起 reject（1 起算）；0 = 不失败。 */
  listFailFrom?: number;
  refreshGlanceFails?: boolean;
  removeFails?: boolean;
  addResult?: AddRepositoryResult;
  /** getSettings 初始返回的偏好项（如 { theme: 'light' }）。 */
  preferences?: Record<string, string>;
  /** updateSettings 抛错：用于验证主题保存失败的处理。 */
  settingsSaveFails?: boolean;
  /** saveAccessToken 的返回（默认成功）。 */
  saveTokenResult?: AccessTokenResult;
  /** validateAccessToken 的返回（默认成功）。 */
  validateTokenResult?: AccessTokenResult;
  /** 覆盖全量信息的各分区（trend / releases / commits / issues / pullRequests / build）。 */
  detail?: Partial<Detail>;
  /** openGitHubExternal 的返回（默认成功）。 */
  openExternalResult?: OpenExternalResult;
  /** 打开意图返回失败 envelope（本地无可展示缓存且首次获取失败）。 */
  detailFails?: boolean;
  /** 强制命令返回失败 envelope：旧内容保留、错误局部呈现。 */
  forceFails?: boolean;
  /** 初始本地视图事实（版本 / 上下文 / 任务 / 时间 / 截断）。 */
  local?: Partial<StubLocalState>;
}

export function makeGlance(id: number, fullName: string): Glance {
  const [owner = '', name = ''] = fullName.split('/');
  return {
    id,
    owner,
    name,
    fullName,
    addedAt: '2026-09-20T00:00:00.000Z',
    stars: 1000 + id,
    forks: 100 + id,
    openIssues: 12,
    pushedAt: '2026-09-26T00:00:00.000Z',
    latestReleaseTag: `v1.0.${id}`,
    fetchedAt: '2026-09-27T00:00:00.000Z',
    // 主进程聚合的活动结果：卡片与详情表头的「最近活动」只格式化它。
    activityAt: '2026-09-26T00:00:00.000Z',
    activityKind: 'code',
  };
}

export function makeDetail(repository: Glance, overrides: Partial<Detail> = {}): Detail {
  return {
    repository,
    releases: [],
    commits: [],
    issues: [],
    pullRequests: [],
    build: { status: 'none', conclusion: null, workflowName: null, url: null, finishedAt: null },
    // 空趋势：概览只渲染「随使用积累」提示，不拉 chart.js 画布
    trend: [],
    ...overrides,
  };
}

/** 主进程后台任务快照（只含状态与版本，不携带详情 payload）。 */
export function makeTask(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'task-1',
    kind: 'open',
    status: 'running',
    targetScopes: ['overview'],
    targetRevisions: {},
    startedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

/** 一条历史快照；不传的指标记空。 */
export function makeSnapshot(
  capturedAt: string,
  stars: number | null = null,
  forks: number | null = null,
): Snapshot {
  return { capturedAt, stars, forks, openIssues: null, latestReleaseTag: null, pushedAt: null };
}

/** 相对"今天本地 0 点"往前 daysAgo 天的 ISO 时间戳；测试里把系统时间定在正午，边界就不会压在数据点上。 */
export function daysAgoIso(daysAgo: number, hour = 0): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

// —— 长列表夹具：有界分页要用真实条数与顺序验证"最后一条到底能不能读到" ——

/** n 条提交（编号从 1 起，按 1..n 顺序保存，最后一条最旧）。 */
export function makeCommits(count: number, prefix = 'c'): CommitItem[] {
  return Array.from({ length: count }, (_, index) => ({
    sha: `${prefix}-${index + 1}`,
    message: `${prefix} 提交 ${index + 1}`,
    authorName: 'dev',
    committedAt: daysAgoIso(0),
  }));
}

/** n 个议题。 */
export function makeIssues(count: number, prefix = 'i'): IssueItem[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `${prefix} 议题 ${index + 1}`,
    body: null,
    state: 'open',
    authorName: 'dev',
    updatedAt: daysAgoIso(0),
  }));
}

/** n 个合并请求。 */
export function makePulls(count: number, prefix = 'p'): PullRequestItem[] {
  return Array.from({ length: count }, (_, index) => ({
    number: 1000 + index + 1,
    title: `${prefix} 合并请求 ${index + 1}`,
    body: null,
    state: 'open',
    authorName: 'dev',
    updatedAt: daysAgoIso(0),
  }));
}

/** n 条发版。 */
export function makeReleases(count: number, prefix = 'v'): ReleaseItem[] {
  return Array.from({ length: count }, (_, index) => ({
    tagName: `${prefix}${index + 1}`,
    title: `${prefix} 发版 ${index + 1}`,
    publishedAt: daysAgoIso(0),
  }));
}

/** 桩里"主进程默认读取"覆盖的范围：全部已缓存范围（含 README / 目录树）。 */
const ALL_SCOPES: readonly DetailScope[] = ['overview', 'releases', 'commits', 'issuesAndPr', 'builds', 'readme', 'tree', 'trends'];

/** 范围里参与分页的列表字段（按此顺序共用同一个条目预算，与主进程一致）。 */
const SCOPE_LISTS: Record<DetailScope, readonly (keyof Detail)[]> = {
  overview: [],
  releases: ['releases', 'tags'],
  commits: ['commits'],
  issuesAndPr: ['issues', 'pullRequests'],
  builds: ['builds'],
  readme: ['readmes'],
  tree: ['tree'],
  trends: ['trend'],
};

/** 栏目到范围的映射（与主进程一致）：只读回部分范围时，栏位状态也按范围取舍。 */
const COLUMN_SCOPE: Record<ColumnName, DetailScope> = {
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

/**
 * 桩的续读游标与主进程同一形状：绑定仓库、访问上下文、内容版本（含完整同步时间）与范围。
 * 渲染层原样透传，桩据此校验；换版 / 换上下文后旧游标一律失效。
 */
function stubCursor(state: StubLocalState, repositoryId: number, scope: DetailScope, offset: number): PaginationCursor {
  return JSON.stringify({
    repositoryId,
    accessContextRevision: state.accessContextRevision,
    detailViewVersion: state.detailViewVersion,
    fetchedAt: state.detailFetchedAt,
    scope,
    offset,
  });
}

/** 解析并校验游标：null = 该范围新格式失效（陈旧版本 / 上下文 / 损坏）。 */
function stubCursorOffset(cursor: PaginationCursor | undefined, state: StubLocalState, repositoryId: number, scope: DetailScope): number | null {
  if (cursor == null) return 0;
  try {
    const value = JSON.parse(cursor) as Record<string, unknown>;
    return value.repositoryId === repositoryId
      && value.accessContextRevision === state.accessContextRevision
      && value.detailViewVersion === state.detailViewVersion
      && value.fetchedAt === state.detailFetchedAt
      && value.scope === scope
      && typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0
      ? value.offset
      : null;
  } catch {
    return null;
  }
}

export interface StubPage {
  detail: Detail | null;
  cursors: Partial<Record<DetailScope, PaginationCursor>>;
  truncated: boolean;
  error: NormalizedError | null;
}

export function createStub(options: StubOptions = {}): StubHandle {
  let repositories = options.repositories ?? [makeGlance(1, 'octocat/Hello-World')];
  let preferences: Record<string, string> = { ...options.preferences };
  const settingsPatches: Array<Record<string, string>> = [];
  let listGate: Promise<void> | null = null;
  let gate: Promise<void> | null = null;
  let removeGate: Promise<void> | null = null;
  let addGate: Promise<void> | null = null;
  let externalGate: Promise<void> | null = null;
  let openGate: Promise<void> | null = null;
  let forceGate: Promise<void> | null = null;
  let statusGate: Promise<void> | null = null;
  let viewGate: Promise<void> | null = null;
  let nextOpen: DetailResult | null = null;
  let nextForce: DetailResult | null = null;
  const local: StubLocalState = {
    localEmpty: false,
    viewVersion: 1,
    detailViewVersion: 1,
    accessContextRevision: 1,
    task: null,
    summaryFetchedAt: null,
    detailFetchedAt: null,
    // README / 目录树默认非空：用来验证展示层不持有未展示的范围。
    detailPatch: { readmes: [{ language: 'TypeScript', content: '# Hello-World' }], tree: [{ path: 'src', kind: 'directory' }], ...options.detail },
    ...options.local,
  };
  const calls: StubCalls = {
    accessTokenState: 0,
    saveAccessToken: 0,
    validateAccessToken: 0,
    getSettings: 0,
    updateSettings: 0,
    listRepositories: 0,
    refreshGlance: 0,
    fetchDetail: 0,
    refreshRepository: 0,
    readLocalDetail: 0,
    readLocalStatus: 0,
    readLocalView: 0,
    acknowledgeRepositoryViewed: 0,
    addRepository: 0,
    inspectRepositoryInput: 0,
    removeRepository: 0,
    openGitHubExternal: 0,
  };
  const externalTargets: GitHubExternalTarget[] = [];
  const addInputs: string[] = [];
  const refreshRequests: StubHandle['refreshRequests'] = [];
  const readRequests: StubReadRequest[] = [];
  const acknowledgments: StubHandle['acknowledgments'] = [];

  function findRepository(repositoryId: number): Glance | null {
    return repositories.find((item) => item.id === repositoryId) ?? null;
  }

  /** 本地保存的完整详情（未按范围投影）。 */
  function storedDetail(repository: Glance): Detail {
    return makeDetail(repository, { releases: [], commits: [], issues: [], pullRequests: [], trend: [], ...local.detailPatch });
  }

  /**
   * 单范围的一页：该范围的列表字段按顺序共用一个条目预算，从 offset 起取 limit 条。
   * 与主进程 readLocalScopePage 的行为一致（issues 先于 pullRequests、releases 先于 tags）。
   */
  function pageScope(full: Detail, scope: DetailScope, offset: number, limit: number): { values: Partial<Detail>; count: number; hasMore: boolean } {
    const values: Partial<Detail> = {};
    if (scope === 'overview') return { values: { metadata: full.metadata }, count: 0, hasMore: false };
    if (scope === 'builds') values.build = full.build;
    const keys = SCOPE_LISTS[scope];
    const combined: unknown[] = keys.flatMap((key) => ((full[key] as unknown[] | undefined) ?? []));
    const page = combined.slice(offset, offset + limit);
    // 按各列表在合并序列里的实际位置切片：跨栏目的一页要落在正确的字段上。
    let fieldStart = 0;
    for (const key of keys) {
      const source = (full[key] as unknown[] | undefined) ?? [];
      const from = Math.max(0, offset - fieldStart);
      const to = Math.min(source.length, offset + page.length - fieldStart);
      (values as Record<string, unknown>)[key] = source.slice(from, Math.max(from, to));
      fieldStart += source.length;
    }
    return { values, count: page.length, hasMore: combined.length > offset + page.length };
  }

  /**
   * 按范围与游标做真实有界切片：只返回请求范围的内容，各自带绑定版本的下一页游标。
   * 游标失效（换版 / 换上下文 / 损坏）时该范围不带内容，并按主进程的方式给出错误。
   */
  function sliceScopes(repository: Glance, scopes: readonly DetailScope[], cursors: Partial<Record<DetailScope, PaginationCursor>> | undefined, limit: number): StubPage {
    if (local.localEmpty) return { detail: null, cursors: {}, truncated: false, error: null };
    const full = storedDetail(repository);
    const projected = makeDetail(repository);
    const nextCursors: Partial<Record<DetailScope, PaginationCursor>> = {};
    let truncated = false;
    let error: NormalizedError | null = null;
    for (const scope of scopes) {
      const offset = stubCursorOffset(cursors?.[scope], local, repository.id, scope);
      if (offset === null) {
        error ??= { kind: 'unknown', message: `${scope} 本地续读游标已失效，请重新读取该范围` };
        continue;
      }
      const page = pageScope(full, scope, offset, limit);
      Object.assign(projected, page.values);
      if (page.hasMore) {
        truncated = true;
        nextCursors[scope] = stubCursor(local, repository.id, scope, offset + page.count);
      }
    }
    return { detail: projected, cursors: nextCursors, truncated, error };
  }

  function summaryFetchedAt(repository: Glance | null): string | null {
    return local.summaryFetchedAt ?? repository?.fetchedAt ?? null;
  }

  function syncState(): Partial<Record<DetailScope, ScopeSyncState>> {
    const state: Partial<Record<DetailScope, ScopeSyncState>> = {};
    for (const scope of ALL_SCOPES) {
      state[scope] = {
        cacheStatus: local.localEmpty ? 'missing' : 'valid',
        freshness: 'unknown',
        checkStatus: 'idle',
        syncStatus: 'idle',
        detectedRevision: 0,
        syncedRevision: 0,
        importantRevision: 0,
        viewedRevision: 0,
        dirtyReasons: [],
        ...local.scopeState?.[scope],
      };
    }
    return state;
  }

  function columns(): Partial<Record<ColumnName, ColumnResult>> {
    const columns: Partial<Record<ColumnName, ColumnResult>> = {};
    for (const name of ['overview', 'releases', 'tags', 'commits', 'issues', 'pullRequests', 'builds'] as const) {
      columns[name] = { status: local.localEmpty ? 'loading' : 'success', value: null, error: null };
    }
    return columns;
  }

  /** 只返回请求范围的栏位状态：与主进程按选中范围收口栏位的行为一致。 */
  function columnsFor(scopes: readonly DetailScope[]): Partial<Record<ColumnName, ColumnResult>> {
    const all = columns();
    const selected: Partial<Record<ColumnName, ColumnResult>> = {};
    for (const name of Object.keys(all) as ColumnName[]) {
      if (scopes.includes(COLUMN_SCOPE[name])) selected[name] = all[name];
    }
    return selected;
  }

  /** 打开 / 强制命令的结果：本地视图 + 范围状态 + 任务快照 + 两个成功时间。 */
  function detailResultFromLocal(repositoryId: number, force: boolean): DetailResult {
    const repository = findRepository(repositoryId);
    if (!repository) return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
    // 打开 / 强制与主进程一样按缺省上限读取首页，其余条目靠返回的游标续读。
    const page = sliceScopes(repository, ALL_SCOPES, undefined, LOCAL_READ_DEFAULT_LIMIT);
    return {
      detail: page.detail,
      error: page.error,
      cached: !force && page.detail !== null,
      columns: columns(),
      viewVersion: local.viewVersion,
      detailViewVersion: local.detailViewVersion,
      accessContextRevision: local.accessContextRevision,
      cursors: page.cursors,
      truncated: page.truncated,
      summaryFetchedAt: summaryFetchedAt(repository),
      detailFetchedAt: local.detailFetchedAt,
      syncState: syncState(),
      task: local.task,
    };
  }

  const api: BluebirdCourierBridge = {
    async accessTokenState() {
      calls.accessTokenState += 1;
      return { configured: true };
    },
    async validateAccessToken() {
      calls.validateAccessToken += 1;
      return options.validateTokenResult ?? { ok: true, error: null };
    },
    async saveAccessToken() {
      calls.saveAccessToken += 1;
      return options.saveTokenResult ?? { ok: true, error: null };
    },
    async getSettings() {
      calls.getSettings += 1;
      return { preferences: { ...preferences }, accessTokenConfigured: true };
    },
    async updateSettings(patch) {
      calls.updateSettings += 1;
      settingsPatches.push({ ...patch });
      if (options.settingsSaveFails) throw new Error('stub: updateSettings 失败');
      preferences = { ...preferences, ...patch };
      return { preferences: { ...preferences }, accessTokenConfigured: true };
    },
    async setThemePreference() {},
    async listRepositories() {
      calls.listRepositories += 1;
      // 调用时捕获清单；延迟期间的主进程变化不能伪装成这份旧回包里的新事实。
      const result = repositories;
      if (listGate) await listGate;
      if (options.listFailFrom && calls.listRepositories >= options.listFailFrom) {
        throw new Error('stub: listRepositories 失败');
      }
      return result;
    },
    async addRepository(fullName) {
      calls.addRepository += 1;
      addInputs.push(fullName);
      if (addGate) await addGate;
      if (options.addResult) return options.addResult;
      const nextId = Math.max(0, ...repositories.map((item) => item.id)) + 1;
      const repository = makeGlance(nextId, fullName);
      repositories = [repository, ...repositories];
      return { ok: true, repository, error: null };
    },
    async inspectRepositoryInput(input) {
      calls.inspectRepositoryInput += 1;
      const match = input.trim().match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)\/?$/i);
      return match
        ? { ok: true, owner: match[1]!, name: match[2]! }
        : { ok: false, message: '请输入 GitHub 仓库地址' };
    },
    async removeRepository() {
      calls.removeRepository += 1;
      if (removeGate) await removeGate;
      if (options.removeFails) throw new Error('stub: removeRepository 失败');
    },
    async refreshGlance() {
      calls.refreshGlance += 1;
      if (gate) await gate;
      if (options.refreshGlanceFails) throw new Error('stub: refreshGlance 失败');
      return { repositories, errors: [] };
    },
    async fetchDetail(repositoryId) {
      calls.fetchDetail += 1;
      // 回包在调用时就算好，再走（可挂起的）桥接延迟：迟到的回包带的是当时的内容与上下文。
      let result: DetailResult;
      if (nextOpen) {
        result = nextOpen;
        nextOpen = null;
      } else {
        const repository = findRepository(repositoryId);
        if (!repository) result = { detail: null, error: null };
        else if (options.detailFails) result = { detail: null, error: { kind: 'unknown', message: '抓取全量信息失败，请稍后重试' } };
        else {
          if (local.localEmpty) {
            // 没有可展示缓存：本次打开等待必要的首次获取，成功即提交内容与完整成功时间。
            local.localEmpty = false;
            local.detailFetchedAt = local.detailFetchedAt ?? new Date().toISOString();
          }
          result = detailResultFromLocal(repositoryId, false);
        }
      }
      if (openGate) await openGate;
      return result;
    },
    async refreshRepository(repositoryId, force) {
      calls.refreshRepository += 1;
      refreshRequests.push({ repositoryId, force });
      let result: DetailResult;
      if (nextForce) {
        result = nextForce;
        nextForce = null;
      } else {
        const repository = findRepository(repositoryId);
        if (!repository) result = { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
        else if (options.forceFails) result = { detail: null, error: { kind: 'network', message: '网络请求失败' } };
        else {
          local.localEmpty = false;
          // 强制成功 = 完整同步提交：完整详情时间推进到本次成功。
          local.detailFetchedAt = new Date().toISOString();
          result = detailResultFromLocal(repositoryId, true);
        }
      }
      if (forceGate) await forceGate;
      return result;
    },
    async readLocalDetail(repositoryId: number, request?: LocalReadRequest): Promise<LocalReadResult> {
      const mode = request?.mode === 'status' ? 'status' : 'view';
      calls.readLocalDetail += 1;
      if (mode === 'status') calls.readLocalStatus += 1;
      else calls.readLocalView += 1;
      readRequests.push({ repositoryId, mode, scopes: request?.scopes, itemLimit: request?.itemLimit, cursors: request?.cursors });
      const repository = findRepository(repositoryId);
      const scopes = request?.scopes ?? ALL_SCOPES;
      // 单次 IPC 的每范围条目上限与主进程一致：超过上限一律收口，不静默放大窗口。
      const limit = Math.min(request?.itemLimit ?? LOCAL_READ_DEFAULT_LIMIT, LOCAL_READ_MAX_LIMIT);
      const page: StubPage = mode === 'status' || repository === null
        ? { detail: null, cursors: {}, truncated: false, error: null }
        : sliceScopes(repository, scopes, request?.cursors, limit);
      const result: LocalReadResult = {
        repositoryId,
        viewVersion: local.viewVersion,
        detailViewVersion: local.detailViewVersion,
        accessContextRevision: local.accessContextRevision,
        detail: page.detail,
        columns: mode === 'status' ? columns() : columnsFor(scopes.filter(scope =>
          repository !== null && stubCursorOffset(request?.cursors?.[scope], local, repositoryId, scope) !== null)),
        syncState: syncState(),
        task: local.task,
        cursors: page.cursors,
        truncated: page.truncated,
        summaryFetchedAt: summaryFetchedAt(repository),
        detailFetchedAt: local.detailFetchedAt,
        error: page.error,
      };
      if (mode === 'status' && statusGate) await statusGate;
      if (mode === 'view' && viewGate) await viewGate;
      return result;
    },
    async acknowledgeRepositoryViewed(repositoryId, acknowledgment) {
      calls.acknowledgeRepositoryViewed += 1;
      acknowledgments.push({ repositoryId, ...acknowledgment });
      return { ok: true, seenRevision: 0 };
    },
    async openGitHubExternal(target) {
      calls.openGitHubExternal += 1;
      externalTargets.push(target);
      if (externalGate) await externalGate;
      return options.openExternalResult ?? { ok: true, reason: null };
    },
  };

  function hold(set: (value: Promise<void> | null) => void): () => void {
    let release = (): void => {};
    set(new Promise<void>((resolve) => {
      release = () => {
        set(null);
        resolve();
      };
    }));
    return release;
  }

  return {
    api,
    calls,
    get preferences() {
      return { ...preferences };
    },
    get local() {
      return local;
    },
    setLocal(patch) {
      Object.assign(local, patch);
    },
    setTask(task) {
      local.task = task;
    },
    settingsPatches,
    externalTargets,
    addInputs,
    refreshRequests,
    readRequests,
    acknowledgments,
    setRepositories(next) {
      repositories = next;
    },
    holdNextList() {
      return hold((value) => { listGate = value; });
    },
    holdNextRefresh() {
      return hold((value) => { gate = value; });
    },
    holdNextRemove() {
      return hold((value) => { removeGate = value; });
    },
    holdNextAdd() {
      return hold((value) => { addGate = value; });
    },
    holdNextExternalLink() {
      return hold((value) => { externalGate = value; });
    },
    holdNextOpen() {
      return hold((value) => { openGate = value; });
    },
    holdNextForce() {
      return hold((value) => { forceGate = value; });
    },
    holdNextStatus() {
      return hold((value) => { statusGate = value; });
    },
    holdNextView() {
      return hold((value) => { viewGate = value; });
    },
    nextOpenResult(result) {
      nextOpen = result;
    },
    nextForceResult(result) {
      nextForce = result;
    },
  };
}

export interface RenderResult {
  container: HTMLElement;
  queryClient: QueryClient;
  unmount: () => Promise<void>;
}

export async function renderApp(stub: StubHandle): Promise<RenderResult> {
  return renderNode(stub, <App />);
}

/** 在同样的 Provider 组合里渲染任意节点（测试自定义探针时用）。 */
export async function renderNode(stub: StubHandle, node: ReactNode): Promise<RenderResult> {
  window.bluebirdCourier = stub.api;
  installMatchMedia();
  const container = document.createElement('div');
  document.body.append(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 60_000 } },
  });
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MotionConfig reducedMotion="user">{node}</MotionConfig>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    queryClient,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 让挂起的 promise 链与渲染跑完；happy-dom 下一条 query 链要跨几轮宏任务才收敛。 */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      // 装了假计时器时只推进"当前已排队的 0ms 任务"，不放过真实时间，动画窗口才可控
      if (vi.isFakeTimers()) {
        vi.advanceTimersByTime(0);
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('要点击的元素不存在');
  await act(async () => {
    (element as HTMLElement).click();
  });
}

/** Desktop 常驻输入；Narrow 通过原新增入口展开。 */
export async function openAddInput(): Promise<HTMLInputElement> {
  const input = document.querySelector<HTMLInputElement>('#add-repository-input');
  if (!input) throw new Error('未找到添加仓库输入框');
  if (input.disabled) await click(buttonByLabel('新增仓库'));
  return input;
}

export function refreshAllButton(): HTMLButtonElement | null {
  return buttonByLabel('检查更新') ?? buttonByText('检查更新') ?? buttonByText('检查中…');
}

export async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

export async function pointerDownOutside(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('无法取得 input value setter');
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** 主区域（进详情）按钮。 */
export function repoOpenButton(fullName: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="查看 ${fullName} 详情"]`);
}

/** 仓库卡片的外层槽位（承载进出场状态与位置）。 */
export function repoSlot(fullName: string): HTMLElement | null {
  return repoOpenButton(fullName)?.closest<HTMLElement>('li') ?? null;
}

/** 卡片当前的动画阶段：idle / entering / exiting（卡片已不在 DOM 时返回 null）。 */
export function repoMotion(fullName: string): string | null {
  return repoMotionForSlot(repoSlot(fullName));
}

/** Observe interaction eligibility and rendered opacity, without the removed CSS phase attribute. */
export function repoMotionForSlot(slot: HTMLElement | null | undefined): string | null {
  if (!slot) return null;
  if (slot.hasAttribute('inert')) return 'exiting';
  return Number(slot.style.opacity || 1) < 1 ? 'entering' : 'idle';
}

/**
 * 推进 Motion 帧与 CSS animationend 的兜底计时器。
 * 虚拟时间逐帧推进并清空微任务，保留动画开始 / 完成的真实生命周期。
 */
export async function settleMotion(ms = 500): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  });
  await settle();
}

/**
 * 等仓库操作浮层的关闭动画播完。happy-dom 不跑 CSS 动画、也不派发 animationend，
 * 所以这里等的就是组件里那条兜底计时器（关闭 120ms + 余量），到点后外壳才卸载。
 */
export async function settleOverlayClose(): Promise<void> {
  await settleMotion(400);
}

/** 详情首次抓取的揭示容器；`data-reveal` 就是 loading / revealing / ready 三个阶段。 */
export function detailReveal(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.detail-reveal');
}

export function revealPhase(): string | null {
  return detailReveal()?.dataset.reveal ?? null;
}

/** Loading 卡：抓取中在文档流里（visible），数据到达后原地淡出（exiting）。 */
export function loadingSlot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.detail-loading-slot');
}

/** 表头四条指标里正在交叉淡化的"旧值"层（只在揭示窗口内存在）。 */
export function factSwaps(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.detail-fact-from')];
}

/** `···` 操作入口。 */
export function repoActionsButton(fullName: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${fullName} 的仓库操作"]`);
}

/** Exercise the real entry point in each shell, without fabricating a desktop button. */
export async function openRepositoryActions(fullName: string): Promise<void> {
  const button = repoActionsButton(fullName);
  if (button) { await click(button); return; }
  const row = repoOpenButton(fullName);
  if (!row) throw new Error('未找到仓库行');
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 260, clientY: 120 }));
  });
}

/**
 * 只取"当前生效"的那个节点：菜单 → 确认换内容时，旧菜单会带着 aria-hidden + inert
 * 留在 out 层继续淡出，它不是用户此刻看到 / 能操作的菜单。
 * 所有浮层查询都按这条过滤，断言才对应真实的界面状态。
 */
function liveQuery<T extends HTMLElement>(selector: string): T | null {
  return (
    [...document.querySelectorAll<T>(selector)].find(
      (element) => element.closest('[aria-hidden="true"]') === null,
    ) ?? null
  );
}

export function menu(): HTMLElement | null {
  return liveQuery<HTMLElement>('[role="menu"]');
}

export function menuItem(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) =>
        item.closest('[aria-hidden="true"]') === null && (item.textContent?.includes(text) ?? false),
    ) ?? null
  );
}

export function dialog(): HTMLElement | null {
  return liveQuery<HTMLElement>('[role="dialog"]');
}

export function buttonByText(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

/** 按 aria-label 取按钮：外链控件的无障碍名是这轮的主要断言对象。 */
export function buttonByLabel(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === label,
    ) ?? null
  );
}

export function alertTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="alert"]')].map(
    (element) => element.textContent ?? '',
  );
}

/** 清单里的仓库卡片（监控清单用 ul/li 承载）。 */
export function repoRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('main ul > li')];
}

export function bodyText(): string {
  return document.body.textContent ?? '';
}

/** 当前生效主题（由 ThemeProvider 写在 <html> 上）。 */
export function appliedTheme(): string | null {
  return document.documentElement.dataset.theme ?? null;
}

/** 顶部导航按钮（按文案取）。 */
export function navButton(text: string): HTMLButtonElement | null {
  if (text === '设置') {
    const desktop = document.querySelector<HTMLButtonElement>('.desktop-sidebar-brand button[aria-label="设置"]');
    if (desktop) return desktop;
  }
  return (
    [...document.querySelectorAll<HTMLButtonElement>('header nav button')].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

/** 分段控件里的按钮（按文案取）。 */
export function segmentedButton(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

/** 详情页二级 Tab（按文案取）。 */
export function tab(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

/** 进入某个仓库的详情页（点仓库卡片主区域）。 */
export async function openRepo(fullName: string): Promise<void> {
  await settle();
  await click(repoOpenButton(fullName));
  await settle();
}

export interface ChartStubConfig {
  labels: string[];
  datasets: Array<{ label: string; data: Array<number | null>; color: string }>;
  legendDisplay: boolean | null;
  xDisplay: boolean | null;
  yDisplay: boolean | null;
  ariaLabel: string | null;
}

/** 读 tests/renderer/chart-stub.tsx 摊在 DOM 上的 Chart.js 配置（happy-dom 拿不到 2d context）。 */
export function chartConfigs(): ChartStubConfig[] {
  return [...document.querySelectorAll<HTMLElement>('[data-chart]')].map(
    (element) => JSON.parse(element.dataset.chart ?? '{}') as ChartStubConfig,
  );
}

/** 某个指标的趋势卡（stars / forks）。 */
export function trendCard(metric: 'stars' | 'forks'): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-metric="${metric}"]`);
}

/** 某个容器里的列表行（默认整篇）。 */
export function listRows(container: ParentNode = document): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('ul > li')];
}

/** 按标题取一个 Section（用于把断言限定在某个区块里）。 */
export function sectionByTitle(title: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('section')].find(
      (section) => section.querySelector('h2')?.textContent?.trim() === title,
    ) ?? null
  );
}
