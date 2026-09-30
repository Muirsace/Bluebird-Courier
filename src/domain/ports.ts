import type {
  BuildInfo,
  CommitItem,
  ErrorKind,
  IssueItem,
  PullRequestItem,
  ReleaseItem,
} from './types';

/** Repository metadata returned by a GitHub adapter. */
export interface RepoMeta {
  fullName: string;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
}

/** One item from GitHub's combined issues endpoint. */
export type IssueOrPullRequest =
  | (IssueItem & { kind: 'issue' })
  | (PullRequestItem & { kind: 'pull' });

/**
 * Port failures are the only provider failures visible to feature code.
 * Adapters translate HTTP, network, and timeout details into this shape.
 */
export class PortFailure extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly resetAt?: string,
  ) {
    super(message);
    this.name = 'PortFailure';
  }
}

export interface Logger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

/** GitHub capability port consumed by features. */
export interface GitHubPort {
  validateAccessToken(accessToken: string): Promise<void>;
  getRepositoryMeta(accessToken: string, fullName: string): Promise<RepoMeta>;
  getLatestRelease(accessToken: string, fullName: string): Promise<ReleaseItem | null>;
  listReleases(accessToken: string, fullName: string): Promise<ReleaseItem[]>;
  listCommits(accessToken: string, fullName: string): Promise<CommitItem[]>;
  listIssues(accessToken: string, fullName: string): Promise<IssueOrPullRequest[]>;
  getLatestBuild(accessToken: string, fullName: string): Promise<BuildInfo | null>;
}
