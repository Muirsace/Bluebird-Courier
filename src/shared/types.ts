import type {
  BuildInfo as DomainBuildInfo,
  ColumnName,
  ColumnState,
  CommitItem,
  Detail as DomainDetail,
  DetailScope,
  EffectiveTheme,
  ErrorKind,
  FetchedGlance,
  Glance,
  GlanceValues,
  IssueItem,
  NormalizedError,
  PaginationCursor,
  PullRequestItem,
  ReadmeDocument,
  ReleaseItem,
  RepoInputResult,
  RequestStatus,
  ScopeSyncState,
  SettingsState,
  Snapshot,
  TagItem,
  ThemePreference,
  TreeEntry,
} from '../domain/types';

export type {
  BuildStatus, CommitItem, EffectiveTheme, ErrorKind, FetchedGlance, Glance, GlanceValues,
  IssueItem, NormalizedError, PullRequestItem, ReadmeDocument, ReleaseItem, RepoInputResult,
  SettingsState, Snapshot, TagItem, ThemePreference, TreeEntry, ColumnName, ColumnState,
  RepositoryId, PaginationCursor, ActivityTimestamp, CacheDecision, FailureState,
  ActivityCandidate, ActivityKind, RepoActivity, CacheStatus, CheckedSignal, ContentVersion,
  DetailScope, Freshness, RequestStatus, ScopeSyncState, RepoSyncState, RepoChangeSet,
  RepositoryObservation, SummaryObservation, ObservationHandoff, TaskContext, ScopeConfirmation,
} from '../domain/types';

export const THEME_PREFERENCE_KEY = 'theme';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export type BuildInfo = Omit<DomainBuildInfo, 'resultDescription'> & { conclusion: string | null };
export type Detail = Omit<DomainDetail, 'build'> & { build: BuildInfo };
export type CacheSource = 'none' | 'fresh' | 'reused' | 'cache' | 'forced';
export type RepositoryStatus = 'active' | 'archived' | 'deleted' | 'renamed';
export type FailureSource = 'token' | 'rate_limit' | 'network' | 'repository' | 'detail' | 'column' | 'persistence' | 'input' | 'unknown';

export interface AccessTokenState { configured: boolean; }
export interface AccessTokenResult { ok: boolean; error: NormalizedError | null; }
export type TokenChangeState = 'idle' | 'awaiting_confirmation' | 'verifying' | 'failed' | 'completed';
export interface TokenOperationResult { ok: boolean; state: TokenChangeState; error: NormalizedError | null; }

export interface AddRepositoryResult {
  ok: boolean;
  repository: Glance | null;
  error: NormalizedError | null;
  state?: 'pending' | 'ready' | 'failed';
}
export interface RefreshRepositoryResult { repository: Glance; error: NormalizedError | null; }
export type RefreshStopReason = 'access_token_invalid' | 'rate_limited' | 'completed' | null;
export interface RefreshGlanceResult {
  repositories: Glance[];
  errors: NormalizedError[];
  stopped?: boolean;
  stopReason?: RefreshStopReason;
  nextCursor?: number | null;
  remaining?: number;
  skipped?: boolean;
}

export interface ColumnResult<T = unknown> {
  status: 'loading' | 'success' | 'empty' | 'forbidden' | 'failed' | 'unsupported';
  value: T | null;
  error: NormalizedError | null;
  hasMore?: boolean;
  cursor?: string | null;
  updatedAt?: string | null;
}
export interface DetailResult {
  detail: Detail | null;
  error: NormalizedError | null;
  cached?: boolean;
  stale?: boolean;
  source?: CacheSource;
  columns?: Partial<Record<ColumnName, ColumnResult>>;
  /** 组合展示版本：详情或趋势任一变化都会改变，供页面比对是否重读（保持既有语义）。 */
  viewVersion?: number;
  /** 权威详情视图版本：展示确认的 detailViewVersion 与此比对（不含趋势版本）。 */
  detailViewVersion?: number;
  /** 读取时的访问上下文版本；展示确认按此校验，跨上下文确认必须忽略。 */
  accessContextRevision?: number;
  /** 有界读取被截断时，各范围可继续读取的游标。 */
  cursors?: Partial<Record<DetailScope, PaginationCursor>>;
  /** 有界读取是否被截断；成功返回详情时必须提供该事实。 */
  truncated?: boolean;
  /** 最近一次真实摘要检查时间（ISO 字符串）；失败或未检查为 null。 */
  summaryFetchedAt?: string | null;
  /** 最近一次完整详情成功提交时间（ISO 字符串）；构建独立更新与缓存读不改变它。 */
  detailFetchedAt?: string | null;
  /** 范围级同步状态（打开用例返回；与 detail 可以同时成立）。 */
  syncState?: Partial<Record<DetailScope, ScopeSyncState>>;
  /** 打开后存在的后台任务快照；无任务为 null。 */
  task?: TaskSnapshot | null;
}

/** 跨进程任务快照：只含状态与版本，不携带详情 payload。 */
export interface TaskSnapshot {
  taskId: string;
  kind: 'open' | 'check' | 'force' | 'scope';
  status: RequestStatus;
  targetScopes: readonly DetailScope[];
  /** 各范围的目标序号；范围状态与确认按此记账。 */
  targetRevisions: Partial<Record<DetailScope, number>>;
  startedAt: string;
}

/** 有界本地读取请求；缺省范围 = 全部已缓存范围。 */
export interface LocalReadRequest {
  /** 'status' 只返回同步状态与版本，不解析详情 payload；缺省 'view'。 */
  mode?: 'view' | 'status';
  scopes?: readonly DetailScope[];
  /** 每个范围的最大条目数；缺省 30，上限 200。 */
  itemLimit?: number;
  /** 各范围的续读游标（范围分页）；缺省从头读取。 */
  cursors?: Partial<Record<DetailScope, PaginationCursor>>;
}
export { LOCAL_READ_DEFAULT_LIMIT, LOCAL_READ_MAX_LIMIT } from '../domain/types';

/** 只读本地读取结果：无网络副作用，不启动抓取。 */
export interface LocalReadResult {
  repositoryId: number;
  /** 组合展示版本：详情或趋势任一变化都会改变（保持既有语义）。 */
  viewVersion: number;
  /** 权威详情视图版本；status 与 view 读取统一填入，展示确认的 detailViewVersion 与此比对。 */
  detailViewVersion: number;
  /** 读取时的访问上下文版本；展示确认按此校验，跨上下文确认必须忽略。 */
  accessContextRevision: number;
  detail: Detail | null;
  /** 栏目状态元信息（不含 value）；status 读取同样提供，不携带完整栏目 payload。 */
  columns: Partial<Record<ColumnName, ColumnResult>>;
  syncState: Partial<Record<DetailScope, ScopeSyncState>>;
  task: TaskSnapshot | null;
  /** 各范围的续读游标；null 表示该范围没有更多。 */
  cursors?: Partial<Record<DetailScope, PaginationCursor>>;
  /** 有界读取被截断时为 true（可继续用 cursors 或更大的 itemLimit）。 */
  truncated: boolean;
  /** 最近一次真实摘要检查时间（ISO 字符串）；失败或未检查为 null。 */
  summaryFetchedAt: string | null;
  /** 最近一次完整详情成功提交时间（ISO 字符串）；构建独立更新与缓存读不改变它。 */
  detailFetchedAt: string | null;
  error: NormalizedError | null;
}

/** 展示确认输入：renderer 上报实际展示到的权威详情版本、范围与访问上下文。 */
export interface DisplayAcknowledgment {
  detailViewVersion: number;
  accessContextRevision: number;
  scopes: readonly DetailScope[];
}

export interface AcknowledgeResult {
  ok: boolean;
  /** 确认后仍未查看的重要版本（没有则 0）；是"仍未查看"的剩余量，不是本次确认的版本。 */
  seenRevision: number;
}

export interface HistoryPage<T = unknown> { items: T[]; nextCursor: string | null; hasMore: boolean; }
export type HistoryKind = 'commits' | 'issues' | 'pullRequests';
export interface TrendPoint { capturedAt: string; stars: number | null; forks: number | null; }
export interface TrendResult { repositoryId: number; points: TrendPoint[]; }

export type GitHubExternalTarget =
  | { kind: 'repository'; owner: string; name: string }
  | { kind: 'release'; owner: string; name: string; tagName: string }
  | { kind: 'commit'; owner: string; name: string; sha: string }
  | { kind: 'issue'; owner: string; name: string; number: number }
  | { kind: 'pull'; owner: string; name: string; number: number }
  | { kind: 'build'; owner: string; name: string; url: string };
export interface OpenExternalResult { ok: boolean; reason: 'invalid_target' | 'open_failed' | null; }

/** 主进程门面向渲染进程公开的四个业务能力。 */
export interface BluebirdCourierFacade {
  accessTokenState(): Promise<AccessTokenState>;
  validateAccessToken(accessToken: string): Promise<AccessTokenResult>;
  saveAccessToken(accessToken: string): Promise<AccessTokenResult>;
  beginTokenReplacement?(): Promise<TokenOperationResult>;
  confirmTokenReplacement?(accessToken: string): Promise<TokenOperationResult>;
  cancelTokenReplacement?(): Promise<TokenOperationResult>;
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: Record<string, string>): Promise<SettingsView>;
  listRepositories(): Promise<Glance[]>;
  addRepository(input: string): Promise<AddRepositoryResult>;
  inspectRepositoryInput(input: string): Promise<RepoInputResult>;
  removeRepository(repositoryId: number): Promise<void>;
  refreshGlance(origin?: 'startup' | 'manual'): Promise<RefreshGlanceResult>;
  /** 强制同步命令：renderer 的「重新抓取」复用该入口（force=true）。 */
  refreshRepository?(repositoryId: number, force?: boolean): Promise<DetailResult>;
  /** 打开用例：返回本地视图并按需安排后台任务；调用者不等待后台完整抓取。 */
  fetchDetail(repositoryId: number): Promise<DetailResult>;
  /** 只读本地视图与任务状态：无网络副作用，不启动抓取、不发 GitHub 请求。 */
  readLocalDetail(repositoryId: number, request?: LocalReadRequest): Promise<LocalReadResult>;
  /** 展示确认：上报实际展示到的权威详情版本与范围；无网络副作用，无 Token 也可确认。 */
  acknowledgeRepositoryViewed(repositoryId: number, acknowledgment: DisplayAcknowledgment): Promise<AcknowledgeResult>;
  loadHistory?(repositoryId: number, kind: HistoryKind, cursor?: string): Promise<HistoryPage>;
  trend?(repositoryId: number): Promise<TrendResult>;
}

export type SettingsView = SettingsState;
/** 用例门面之外的受限平台外观命令。 */
export interface ThemeAppearanceBridge {
  setThemePreference(preference: ThemePreference): Promise<void>;
}
/** 平台外链出口由 IPC 层注入的处理器承接（组合根接线），不属业务门面实现。 */
export interface ShellLinkBridge {
  openGitHubExternal(target: GitHubExternalTarget): Promise<OpenExternalResult>;
}

export type BluebirdCourierBridge = BluebirdCourierFacade & ThemeAppearanceBridge & ShellLinkBridge;
