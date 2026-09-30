/**
 * Domain vocabulary shared by the use cases and their adapters.
 *
 * The domain has no platform or transport dependencies.  Values in this file
 * are deliberately neutral: protocol field names (for example GitHub's
 * `conclusion`) are translated before they cross into the domain.
 */

// ---------- Errors ----------

/** Normalized error classes exposed by the application. */
export type ErrorKind = 'access_token_invalid' | 'rate_limited' | 'not_found' | 'network' | 'unknown';

export interface NormalizedError {
  kind: ErrorKind;
  message: string;
  /** Quota recovery time (UTC ISO 8601), present for rate-limited failures. */
  resetAt?: string;
  /** Repository context for batch operations. */
  fullName?: string;
}

// ---------- Repository and detail values ----------

/** Lightweight repository information shown in the watch list. */
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
}

/** Values returned by a lightweight metadata fetch before persistence. */
export interface GlanceValues {
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
  latestReleaseTag: string | null;
}

/** Lightweight fetch values together with GitHub's canonical repository name. */
export type FetchedGlance = GlanceValues & { fullName: string };

export interface ReleaseItem {
  tagName: string;
  title: string;
  publishedAt: string | null;
}

export interface CommitItem {
  sha: string;
  message: string;
  authorName: string | null;
  committedAt: string;
}

export interface IssueItem {
  number: number;
  title: string;
  /** GitHub issue body in plain text/Markdown, or null when the issue has no body. */
  body: string | null;
  state: 'open' | 'closed';
  authorName: string | null;
  updatedAt: string;
}

export interface PullRequestItem {
  number: number;
  title: string;
  /** GitHub pull request body in plain text/Markdown, or null when the PR has no body. */
  body: string | null;
  state: 'open' | 'closed';
  authorName: string | null;
  updatedAt: string;
}

/** Build states understood by the product. */
export type BuildStatus = 'success' | 'failure' | 'pending' | 'neutral' | 'none';

/**
 * Protocol-neutral build information.  Adapters retain a provider's original
 * conclusion only as a descriptive result; callers use `status` for behavior.
 */
export interface BuildInfo {
  status: BuildStatus;
  workflowName: string | null;
  url: string | null;
  finishedAt: string | null;
  resultDescription: string | null;
}

export interface Snapshot {
  capturedAt: string;
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  latestReleaseTag: string | null;
  pushedAt: string | null;
}

export interface DetailValues {
  releases: ReleaseItem[];
  commits: CommitItem[];
  issues: IssueItem[];
  pullRequests: PullRequestItem[];
  build: BuildInfo;
}

export interface Detail {
  repository: Glance;
  releases: ReleaseItem[];
  commits: CommitItem[];
  issues: IssueItem[];
  pullRequests: PullRequestItem[];
  build: BuildInfo;
  trend: Snapshot[];
}

// ---------- Settings and input rules ----------

export interface SettingsState {
  preferences: Record<string, string>;
  accessTokenConfigured: boolean;
}

export type ThemePreference = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

export type RepoInputResult =
  | { ok: true; owner: string; name: string }
  | { ok: false; message: string };

// ---------- Desktop integration ----------

export type GitHubExternalTarget =
  | { kind: 'repository'; owner: string; name: string }
  | { kind: 'release'; owner: string; name: string; tagName: string }
  | { kind: 'commit'; owner: string; name: string; sha: string }
  | { kind: 'issue'; owner: string; name: string; number: number }
  | { kind: 'pull'; owner: string; name: string; number: number }
  | { kind: 'build'; owner: string; name: string; url: string };

export interface OpenExternalResult {
  ok: boolean;
  reason: 'invalid_target' | 'open_failed' | null;
}

export interface ExternalLinkBridge {
  openGitHubExternal(target: GitHubExternalTarget): Promise<OpenExternalResult>;
}
