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
export interface PullRequestItem { number: number; title: string; body: string | null; state: 'open' | 'closed'; authorName: string | null; updatedAt: string; }

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
export interface RepositoryMetadata { description: string | null; homepage: string | null; license: string | null; defaultBranch: string | null; }

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
