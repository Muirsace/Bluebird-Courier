import type {
  BuildInfo as DomainBuildInfo,
  ColumnName,
  ColumnState,
  CommitItem,
  Detail as DomainDetail,
  EffectiveTheme,
  ErrorKind,
  FetchedGlance,
  Glance,
  GlanceValues,
  IssueItem,
  NormalizedError,
  PullRequestItem,
  ReadmeDocument,
  ReleaseItem,
  RepoInputResult,
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
  refreshGlance(): Promise<RefreshGlanceResult>;
  refreshRepository?(repositoryId: number, force?: boolean): Promise<DetailResult>;
  fetchDetail(repositoryId: number): Promise<DetailResult>;
  loadHistory?(repositoryId: number, kind: HistoryKind, cursor?: string): Promise<HistoryPage>;
  trend?(repositoryId: number): Promise<TrendResult>;
  openGitHubExternal(target: GitHubExternalTarget): Promise<OpenExternalResult>;
}

export type SettingsView = SettingsState;
export type BluebirdCourierBridge = BluebirdCourierFacade;
