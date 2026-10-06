import type {
  BuildInfo,
  BuildItem,
  CommitItem,
  ContentVersion,
  DetailScope,
  ErrorKind,
  Glance,
  GlanceValues,
  IssueItem,
  PaginationCursor,
  PullRequestItem,
  ReadmeDocument,
  ReleaseItem,
  RepositoryMetadata,
  Snapshot,
  SummaryObservation,
  TagItem,
  TreeEntry,
} from './types';

export interface RepoMeta {
  fullName: string;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
  /** 默认分支名；缺失为 null（后续 HEAD 信号记为 unknown）。 */
  defaultBranch?: string | null;
  latestReleaseTag?: string | null;
  latestTag?: string | null;
  collaborationAt?: string | null;
  status?: 'active' | 'archived' | 'deleted' | 'renamed';
}

export type IssueOrPullRequest =
  | (IssueItem & { kind: 'issue' })
  | (PullRequestItem & { kind: 'pull' });

/** 适配器把平台错误收敛为领域可识别的失败。 */
export class PortFailure extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly resetAt?: string) {
    super(message);
    this.name = 'PortFailure';
  }
}

export interface Logger { info(message: string): void; error(message: string, error?: unknown): void; }
export interface Clock { now(): Date; }
export interface Transaction { commit(): Promise<void> | void; rollback(): Promise<void> | void; }
export interface TransactionManager { transaction<T>(work: (tx: Transaction) => Promise<T> | T): Promise<T>; }

export interface TokenStore {
  read(): Promise<string | null> | string | null;
  save(token: string): Promise<void> | void;
  clear(): Promise<void> | void;
  isConfigured?(): Promise<boolean> | boolean;
}

export interface RepositoryListStore {
  list(): Promise<Glance[]> | Glance[];
  findById(id: number): Promise<Glance | null> | Glance | null;
  save(repository: Glance): Promise<void> | void;
  remove(id: number): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface DetailStore {
  read(repositoryId: number): Promise<unknown> | unknown;
  save(repositoryId: number, value: unknown): Promise<void> | void;
  remove(repositoryId: number): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface SnapshotStore {
  upsert(repositoryId: number, snapshot: Snapshot): Promise<void> | void;
  list(repositoryId: number): Promise<Snapshot[]> | Snapshot[];
  remove(repositoryId: number): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface GitHubPort {
  validateAccessToken(accessToken: string): Promise<void>;
  getRepositoryMeta(accessToken: string, fullName: string): Promise<RepoMeta>;
  getLatestRelease(accessToken: string, fullName: string): Promise<ReleaseItem | null>;
  listReleases(accessToken: string, fullName: string): Promise<ReleaseItem[]>;
  getLatestTag?(accessToken: string, fullName: string): Promise<TagItem | null>;
  /** 标签适配器可返回旧版字符串列表或新版标签值；feature 在边界归一化。 */
  listTags?(accessToken: string, fullName: string): Promise<unknown>;
  listTagItems?(accessToken: string, fullName: string, cursor?: string): Promise<{ items: TagItem[]; nextCursor: string | null }>;
  listCommits(accessToken: string, fullName: string): Promise<CommitItem[]>;
  listIssues(accessToken: string, fullName: string): Promise<IssueOrPullRequest[]>;
  listReleasesPage?(accessToken: string, fullName: string, cursor?: string): Promise<{ items: ReleaseItem[]; nextCursor: string | null }>;
  listTagsPage?(accessToken: string, fullName: string, cursor?: string): Promise<{ items: TagItem[]; nextCursor: string | null }>;
  listCommitsPage?(accessToken: string, fullName: string, cursor?: string): Promise<{ items: CommitItem[]; nextCursor: string | null }>;
  listIssuesPage?(accessToken: string, fullName: string, cursor?: string): Promise<{ items: IssueOrPullRequest[]; nextCursor: string | null }>;
  getLatestBuild(accessToken: string, fullName: string): Promise<BuildInfo | null>;
  listBuilds?(accessToken: string, fullName: string): Promise<BuildItem[]>;
  getMetadata?(accessToken: string, fullName: string): Promise<RepositoryMetadata>;
  listReadmes?(accessToken: string, fullName: string): Promise<ReadmeDocument[]>;
  listTree?(accessToken: string, fullName: string): Promise<TreeEntry[]>;
  getCollaborationActivity?(accessToken: string, fullName: string): Promise<string | null>;
}

/** 轻量摘要写入所需的最小端口，便于 feature 替换持久化实现。 */
export interface GlancePort { fetch(accessToken: string, fullName: string): Promise<GlanceValues & { fullName?: string }>; }
/** 详情抓取端口。 */
export interface DetailPort { fetch(accessToken: string, fullName: string): Promise<unknown>; }
/** 摘要快照端口。 */
export interface SnapshotPort { record(repositoryId: number, snapshot: Snapshot): Promise<void> | void; trend(repositoryId: number): Promise<Snapshot[]> | Snapshot[]; }

// —— 仓库同步端口：归一化观察、范围验证与范围抓取（实现于后续步骤） ——

/** 详情 feature 需要的仓库窄引用；不暴露清单存储。 */
export interface RepositoryRef {
  id: number;
  fullName: string;
  defaultBranch: string | null;
}

export interface RepositoryRefPort {
  findById(repositoryId: number): RepositoryRef | null;
}

/**
 * 轻量摘要观察端口：归一化摘要值、内容信号与活动候选。
 * 观察时间与访问上下文版本均由调用链明确提供（adapter 不读时钟、不猜上下文）。
 */
export interface SummaryObservationPort {
  observeSummary(accessToken: string, fullName: string, observedAt: string, accessContextRevision: number): Promise<SummaryObservation>;
}

export interface ScopeVerifyRequest {
  fullName: string;
  scope: DetailScope;
  defaultBranch: string | null;
  /** 调用链明确提供的访问上下文版本；adapter 只回显，不自行猜测或固定为 0。 */
  accessContextRevision: number;
  /** 检查模式：probe 走更新时间增量探测（含重叠窗口），reread 重读页面对应范围。 */
  mode: 'probe' | 'reread';
  /** 本次检查允许读取的最大页数（feature 预算）；达到上限仍未完成时 checkComplete=false。 */
  maxPages: number;
  /** 检查开始时间；由调用链传入（adapter 不读时钟）。 */
  checkedAt: string;
  /** 上次成功同步的指纹；null 表示没有可用基线，只能按完整检查判定。 */
  baselineFingerprint: string | null;
}

/** 范围验证结果：checkComplete=false 表示检查区间未完成，不得宣布无变化。 */
export interface ScopeVerification {
  scope: DetailScope;
  checkedAt: string;
  /** 检查区间是否完整；预算耗尽、失败、分页未完成或基线不可比时为 false。 */
  checkComplete: boolean;
  changed: boolean;
  fingerprint?: string;
  version?: ContentVersion;
  accessContextRevision: number;
}

export interface ScopeFetchRequest {
  fullName: string;
  scope: DetailScope;
  defaultBranch: string | null;
  cursor: PaginationCursor;
  /** 单次调用最多返回的条目数（有界读取由调用方给上限）。 */
  limit: number;
  /** 调用链明确提供的访问上下文版本；adapter 只回显，不自行猜测。 */
  accessContextRevision: number;
  /** 本次抓取的观察时间；由调用链传入（adapter 不读时钟）。 */
  observedAt: string;
}

/**
 * 有界范围抓取结果。
 * hasMore 表示还有更早的历史分页可继续读取（展示增量）；
 * coverageComplete 表示目标范围是否被完整覆盖（可推进同步基线）。
 * 两者是不同的事实：历史还有更多不代表本次覆盖完整，反之亦然。
 */
export interface ScopeFetchOutcome<T = unknown> {
  scope: DetailScope;
  items: T[];
  /** 是否还有更早的历史分页可继续读取。 */
  hasMore: boolean;
  nextCursor: PaginationCursor;
  /** 目标范围是否完整覆盖；未完成时不得推进同步基线，也不能宣布区间已验证。 */
  coverageComplete: boolean;
  observedAt: string;
  version?: ContentVersion;
  accessContextRevision: number;
}

/** overview 范围的归一化内容：摘要值与元数据；不含平台原始字段。 */
export interface OverviewContent {
  values: GlanceValues;
  metadata: RepositoryMetadata | null;
}

export interface ScopeVerificationPort {
  verifyScopes(accessToken: string, request: ScopeVerifyRequest): Promise<ScopeVerification>;
}

export interface ScopeFetchPort {
  fetchScope(accessToken: string, request: ScopeFetchRequest): Promise<ScopeFetchOutcome>;
}
