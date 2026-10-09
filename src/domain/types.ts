// 领域层只保存平台无关的数据、状态与失败语义。

// 错误类别保持跨进程展示层的稳定集合；更细的来源通过 FailureSource 表达。
export type ErrorKind = 'access_token_invalid' | 'rate_limited' | 'not_found' | 'network' | 'unknown';
export type FailureSource = 'token' | 'rate_limit' | 'network' | 'repository' | 'detail' | 'column' | 'persistence' | 'input' | 'unknown';

export interface NormalizedError {
  kind: ErrorKind;
  message: string;
  resetAt?: string;
  fullName?: string;
  source?: FailureSource;
  occurredAt?: string;
  lastSucceededAt?: string | null;
  hasPreviousData?: boolean;
}

export type RepositoryStatus = 'active' | 'archived' | 'deleted' | 'renamed';
export type RepositoryId = number;
export type PaginationCursor = string | null;

export interface ActivityTimes {
  code: string | null;
  collaboration: string | null;
  latest: string | null;
}
export type ActivityTimestamp = string | null;

export interface Glance {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  addedAt: string;
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  pushedAt: string | null;
  latestReleaseTag: string | null;
  fetchedAt: string | null;
  latestTag?: string | null;
  collaborationAt?: string | null;
  activityAt?: string | null;
  /** 主进程聚合的活动类型；显示与悬停说明只依据该结果。 */
  activityKind?: ActivityKind | null;
  status?: RepositoryStatus;
  failure?: NormalizedError | null;
  lastSucceededAt?: string | null;
}

export interface GlanceValues {
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
  latestReleaseTag: string | null;
  latestTag?: string | null;
  collaborationAt?: string | null;
  status?: RepositoryStatus;
}

export type FetchedGlance = GlanceValues & { fullName: string };

export interface ReleaseItem { tagName: string; title: string; publishedAt: string | null; }
export interface TagItem { name: string; committedAt?: string | null; }
export interface CommitItem { sha: string; message: string; authorName: string | null; committedAt: string; }
export interface IssueItem { number: number; title: string; body: string | null; state: 'open' | 'closed'; authorName: string | null; updatedAt: string; }
export interface PullRequestItem { number: number; title: string; body: string | null; state: 'open' | 'closed'; authorName: string | null; updatedAt: string; draft?: boolean; mergedAt?: string | null; headBranch?: string | null; baseBranch?: string | null; }

export type BuildStatus = 'success' | 'failure' | 'pending' | 'neutral' | 'none';
export interface BuildInfo {
  status: BuildStatus;
  workflowName: string | null;
  url: string | null;
  finishedAt: string | null;
  /** 兼容旧适配器的中立结果描述；供应商原文应在 shared DTO 中使用 conclusion。 */
  resultDescription: string | null;
  id?: string | null;
}

export interface BuildItem extends BuildInfo { id: string | null; }
export interface ReadmeDocument { language: string; content: string; }
export interface TreeEntry { path: string; kind: 'file' | 'directory'; size?: number | null; }
/** 来自成功仓库元信息的资源能力；未知不能冒充已关闭。 */
export type ResourceAvailability = 'enabled' | 'disabled' | 'unknown';
export interface RepositoryCapabilities { issues: ResourceAvailability; pullRequests: ResourceAvailability; }
export interface RepositoryMetadata { description: string | null; homepage: string | null; license: string | null; defaultBranch: string | null; capabilities?: RepositoryCapabilities; }

export type ColumnName = 'overview' | 'releases' | 'tags' | 'commits' | 'issues' | 'pullRequests' | 'builds' | 'readme' | 'tree';
export type ColumnStatus = 'loading' | 'success' | 'empty' | 'forbidden' | 'failed' | 'unsupported';
export interface ColumnState<T = unknown> {
  status: ColumnStatus;
  value: T | null;
  error: NormalizedError | null;
  hasMore?: boolean;
  cursor?: string | null;
  updatedAt?: string | null;
}
export type ColumnResult<T = unknown> = ColumnState<T>;

export interface Snapshot {
  capturedAt: string;
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  latestReleaseTag: string | null;
  pushedAt: string | null;
  repositoryId?: number;
  fullName?: string;
  latestTag?: string | null;
  collaborationAt?: string | null;
}
export type SnapshotRecord = Snapshot;
export interface TrendPoint { capturedAt: string; stars: number | null; forks: number | null; }

export interface DetailValues {
  releases: ReleaseItem[];
  commits: CommitItem[];
  issues: IssueItem[];
  pullRequests: PullRequestItem[];
  build: BuildInfo;
  metadata?: RepositoryMetadata;
  tags?: TagItem[];
  builds?: BuildItem[];
  readmes?: ReadmeDocument[];
  tree?: TreeEntry[];
}

export type CacheSource = 'none' | 'fresh' | 'reused' | 'cache' | 'forced';
export type CacheDecision = CacheSource;
export type FailureState = 'preserve_previous' | 'empty';
export interface Detail {
  repository: Glance;
  releases: ReleaseItem[];
  commits: CommitItem[];
  issues: IssueItem[];
  pullRequests: PullRequestItem[];
  build: BuildInfo;
  trend: Snapshot[];
  metadata?: RepositoryMetadata;
  tags?: TagItem[];
  builds?: BuildItem[];
  readmes?: ReadmeDocument[];
  tree?: TreeEntry[];
  columns?: Partial<Record<ColumnName, ColumnState>>;
  cacheSource?: CacheSource;
  summaryFetchedAt?: string | null;
  detailFetchedAt?: string | null;
  stale?: boolean;
  failure?: NormalizedError | null;
}

export interface Page<T> { items: T[]; nextCursor: string | null; hasMore: boolean; }
export type HistoryPage<T> = Page<T>;
export interface SettingsState { preferences: Record<string, string>; accessTokenConfigured: boolean; }
export type ThemePreference = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';
export type RepoInputResult = { ok: true; owner: string; name: string } | { ok: false; message: string };

export type GitHubExternalTarget =
  | { kind: 'repository'; owner: string; name: string }
  | { kind: 'release'; owner: string; name: string; tagName: string }
  | { kind: 'commit'; owner: string; name: string; sha: string }
  | { kind: 'issue'; owner: string; name: string; number: number }
  | { kind: 'pull'; owner: string; name: string; number: number }
  | { kind: 'build'; owner: string; name: string; url: string };
export interface OpenExternalResult { ok: boolean; reason: 'invalid_target' | 'open_failed' | null; }
export interface ExternalLinkBridge { openGitHubExternal(target: GitHubExternalTarget): Promise<OpenExternalResult>; }

// —— 仓库同步：已检查信号、范围状态、变化、观察与任务 ——

/** 活动类型；同一时间多个来源时按固定优先级选择悬停说明。 */
export type ActivityKind = 'code' | 'release' | 'pull-request' | 'issue';

/** 归一化活动候选：适配器只保留源信息与检查结果，重要性由 domain/feature 判定。 */
export interface ActivityCandidate {
  kind: ActivityKind;
  at: string | null;
  /**
   * 是否重要（影响聚合、显示与圆点）；缺省表示尚未判定。
   * 适配器不设置该字段，由 domain/feature 按业务规则标记。
   */
  important?: boolean;
  /** 重要源事件时间；与原始探测更新时间 at 分开，避免丢失观察线索。 */
  importantAt?: string | null;
  /**
   * 源时间是否被直接读到：true = 成功读取源时间（发版时间 / 协作更新时间）；
   * false = 辅助线索（如 pushedAt 未经默认分支验证）或本次未读到。
   */
  verified: boolean;
  /** 协作来源的状态（仅 Issue / PR 候选提供），供重要性分类区分噪声。 */
  state?: 'open' | 'closed';
  /** 归一化记录身份和重要展示字段指纹；更新时间本身不纳入指纹。 */
  sourceId?: string;
  contentRevision?: string;
  createdAt?: string | null;
  closedAt?: string | null;
}

/** 主进程聚合后的统一活动结果；卡片显示、悬停说明与清单排序使用同一结果。 */
export interface RepoActivity {
  at: string | null;
  kind: ActivityKind | null;
}

/**
 * 已检查信号：known 表示成功确认（value 可为 null，即"确认没有"）；
 * unknown 表示未检查或检查失败。两者不能混为同一个 null。
 */
export type CheckedSignal<T> =
  | { state: 'known'; value: T | null; checkedAt: string }
  | { state: 'unknown'; error?: string };

/** 观察到的内容版本信号（已确认值）；未确认为 null 且由信号状态另行表达。 */
export interface ContentVersion {
  defaultBranch: string | null;
  headRevision: string | null;
  releaseRevision: string | null;
  tagRevision: string | null;
}

/** 同步记账范围；趋势是本地快照视图，不产生远端请求。 */
export type DetailScope = 'overview' | 'releases' | 'commits' | 'issuesAndPr' | 'builds' | 'readme' | 'tree' | 'trends';

/** 有界本地读取：每个范围的条目缺省值与上限（feature 与展示层共用同一契约）。 */
export const LOCAL_READ_DEFAULT_LIMIT = 30;
export const LOCAL_READ_MAX_LIMIT = 200;

export type CacheStatus = 'missing' | 'valid' | 'invalid';
export type Freshness = 'fresh' | 'stale' | 'unknown';
export type RequestStatus = 'idle' | 'queued' | 'running' | 'error';

/** 单个范围的持久化同步状态；缓存状态、新鲜度与请求状态各自独立。 */
export interface ScopeSyncState {
  cacheStatus: CacheStatus;
  freshness: Freshness;
  checkStatus: RequestStatus;
  syncStatus: RequestStatus;
  detectedRevision: number;
  syncedRevision: number;
  importantRevision: number;
  viewedRevision: number;
  dirtyReasons: string[];
  observedFingerprint?: string;
  syncedFingerprint?: string;
  lastCheckedAt?: string;
  lastSyncedAt?: string;
  lastCheckError?: string;
  lastCheckFailure?: NormalizedError;
  lastSyncError?: string;
  lastSyncFailure?: NormalizedError;
  /** 有界验证的持久续扫进度；不是成功同步或验证基线。 */
  verificationProgress?: string;
}

/** 单仓库同步汇总；重启后从持久化基线恢复，旧 running 不作为运行中任务。 */
export interface RepoSyncState {
  repoId: number;
  summaryFetchedAt?: string;
  detailFetchedAt?: string;
  scopes: Partial<Record<DetailScope, ScopeSyncState>>;
  lastImportantChangeAt?: string;
  lastViewedAt?: string;
  hasUnseenUpdates: boolean;
}

/** 一次观察与上次基线的差异；只描述变化与覆盖范围，不执行网络请求。 */
export interface RepoChangeSet {
  repoId: number;
  starsChanged: boolean;
  forksChanged: boolean;
  headChanged: boolean;
  releaseChanged: boolean;
  tagChanged: boolean;
  issuesChanged: boolean;
  buildsChanged: boolean;
  defaultBranchChanged: boolean;
  previousHeadRevision: string | null;
  currentHeadRevision: string | null;
  /** 受影响范围；仅指标变化为空数组。 */
  affectedScopes: DetailScope[];
  detectedAt: string;
}

/** 归一化观察：摘要值 + 已检查信号 + 活动候选；不含平台原始字段。 */
export interface RepositoryObservation {
  repoId: number;
  fullName: string;
  observedAt: string;
  accessContextRevision: number;
  values: GlanceValues;
  /** 单来源检查失败；摘要可成功，限流和认证失败仍须交给批次停止策略。 */
  errors?: NormalizedError[];
  signals: {
    defaultBranch: CheckedSignal<string>;
    headRevision: CheckedSignal<string>;
    releaseRevision: CheckedSignal<string>;
    tagRevision: CheckedSignal<string>;
  };
  activity: {
    /** 代码候选：pushedAt 为推送线索（verified=false），默认分支 HEAD 的验证结果见 signals。 */
    code: ActivityCandidate;
    /** 发版候选：发版实际发生时间（verified=true）。 */
    release: ActivityCandidate;
    /** 协作候选：区分 Issue / PR（verified=true）；失败或确认无活动时 at 为 null。 */
    collaboration: ActivityCandidate;
  };
}

/** 端口返回的观察不含仓库 ID，由所属 feature 补齐后再持久化。 */
export type SummaryObservation = Omit<RepositoryObservation, 'repoId'>;

/** 清单到详情的持久化交接单元；按 observationId 幂等应用，重放不重复递增序号。 */
export interface ObservationHandoff {
  observationId: string;
  repoId: number;
  detectedAt: string;
  accessContextRevision: number;
  changeSet: RepoChangeSet;
}

/** 任务在单个范围上的目标：目标序号与启动时的覆盖基线。 */
export interface TaskScopeTarget {
  targetRevision: number;
  /** 任务启动时该范围的已同步指纹；null 表示任务前无基线。 */
  baselineFingerprint: string | null;
  /** 启动时已知的源目标；字段缺省为未知，null表达可信的已知空值。 */
  sourceVersion?: Partial<ContentVersion>;
}

/** 同步任务上下文；写入前校验仓库存在、访问上下文一致且任务版本未被更新任务超越。 */
export interface TaskContext {
  taskId: string;
  repoId: number;
  kind: 'open' | 'check' | 'force' | 'scope';
  /** 各范围的目标序号与覆盖基线；成功后只确认实际覆盖到的范围与版本。 */
  targets: Partial<Record<DetailScope, TaskScopeTarget>>;
  accessContextRevision: number;
  taskVersion: number;
  startedAt: string;
}

/** 部分确认输入：列出本次实际覆盖到的范围及其目标版本。 */
export interface ScopeConfirmation {
  syncedAt: string;
  scopes: Array<{ scope: DetailScope; targetRevision: number }>;
}
