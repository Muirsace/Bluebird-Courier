import type { CommitItem, ReleaseItem } from '../../../shared/types';

/** 仓库元数据（轻量信息的前半：star / fork / open issues / 最近推送时间）。 */
export interface RepoMeta {
  fullName: string;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
}

/** 议题与合并请求：同一端点返回，按是否带 pull_request 标记拆分。 */
export interface IssueOrPullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed';
  authorName: string | null;
  updatedAt: string;
  hasPullRequest: boolean;
}

/** 最近一次构建（GitHub Actions run）的原始状态；null = 没有构建。 */
export interface BuildRun {
  workflowName: string | null;
  /** run status：queued / in_progress / completed … */
  status: string | null;
  /** run conclusion：success / failure / cancelled …，未完成为 null。 */
  conclusion: string | null;
  url: string | null;
  finishedAt: string | null;
}

/**
 * GitHub REST 适配器端口。方法粒度对应 Implementation Decisions 的 API 调用清单：
 * 轻量 = getRepositoryMeta + getLatestRelease（每仓库两次调用）；
 * 全量 = listReleases + listCommits + listIssues + getLatestBuild（构建取最近一次结论，无则空态）。
 *
 * HTTP 层错误抛 GitHubRequestError；网络失败抛 TypeError（与 fetch 一致）；
 * 请求超时抛 TimeoutError（同为 DOMException），两者都由错误归一映射为"网络失败"；
 * 其余意外错误原样抛出，由错误归一映射为"未知"。
 */
export interface GitHubPort {
  validateAccessToken(accessToken: string): Promise<void>;
  getRepositoryMeta(accessToken: string, fullName: string): Promise<RepoMeta>;
  getLatestRelease(accessToken: string, fullName: string): Promise<ReleaseItem | null>;
  listReleases(accessToken: string, fullName: string): Promise<ReleaseItem[]>;
  listCommits(accessToken: string, fullName: string): Promise<CommitItem[]>;
  listIssues(accessToken: string, fullName: string): Promise<IssueOrPullRequest[]>;
  getLatestBuild(accessToken: string, fullName: string): Promise<BuildRun | null>;
}

export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string> = {},
    message?: string,
  ) {
    super(message ?? `GitHub API ${status}`);
    this.name = 'GitHubRequestError';
  }
}
