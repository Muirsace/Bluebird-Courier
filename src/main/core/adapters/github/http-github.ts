import type { BuildInfo, CommitItem, ReleaseItem } from '../../../../domain/types';
import {
  PortFailure,
  type GitHubPort,
  type IssueOrPullRequest,
  type RepoMeta,
} from '../../../../domain/ports';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'octo-monitor';
const REQUEST_TIMEOUT_MS = 10_000;

interface RawRepo {
  full_name: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string | null;
}

interface RawRelease {
  tag_name: string;
  name: string | null;
  published_at: string | null;
}

interface RawCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string | null; date: string | null } | null;
    committer: { name: string | null; date: string | null } | null;
  };
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  updated_at: string;
  pull_request?: unknown;
}

interface RawWorkflowRun {
  name: string | null;
  status: string | null;
  conclusion: string | null;
  html_url: string | null;
  updated_at: string | null;
}

/** HTTP details stay inside this adapter and never cross the domain seam. */
class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string>,
  ) {
    super(`GitHub API ${status}`);
    this.name = 'GitHubHttpError';
  }
}

function toReleaseItem(release: RawRelease): ReleaseItem {
  return {
    tagName: release.tag_name,
    title: release.name ?? release.tag_name,
    publishedAt: release.published_at,
  };
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : headers[key];
}

function resetAt(headers: Record<string, string>): string | undefined {
  const reset = header(headers, 'x-ratelimit-reset');
  if (reset !== undefined && /^\d+$/.test(reset)) return new Date(Number(reset) * 1000).toISOString();
  const retryAfter = header(headers, 'retry-after');
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter)) {
    return new Date(Date.now() + Number(retryAfter) * 1000).toISOString();
  }
  return undefined;
}

function isRateLimited(error: GitHubHttpError): boolean {
  if (error.status === 429) return true;
  if (error.status !== 403) return false;
  return header(error.headers, 'x-ratelimit-remaining') === '0' || header(error.headers, 'retry-after') !== undefined;
}

function isAbortFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function toPortFailure(error: unknown): PortFailure {
  if (error instanceof PortFailure) return error;
  if (error instanceof GitHubHttpError) {
    if (error.status === 401) return new PortFailure('access_token_invalid', '访问令牌无效，请到设置页更换令牌');
    if (isRateLimited(error)) {
      return new PortFailure('rate_limited', '抓取被 GitHub 限流，配额恢复前暂不可用', resetAt(error.headers));
    }
    if (error.status === 403 || error.status === 404) return new PortFailure('not_found', '仓库不存在或无权访问');
    return new PortFailure('unknown', `抓取失败（HTTP ${error.status}）`);
  }
  if (isAbortFailure(error)) return new PortFailure('network', '网络请求超时，请检查网络后重试');
  if (error instanceof TypeError) return new PortFailure('network', '网络失败，请检查网络后重试');
  return new PortFailure('unknown', '发生未知错误');
}

function buildStatus(run: RawWorkflowRun): BuildInfo['status'] {
  if (run.conclusion === null) return 'pending';
  if (run.conclusion === 'success') return 'success';
  if (
    run.conclusion === 'failure' ||
    run.conclusion === 'timed_out' ||
    run.conclusion === 'action_required' ||
    run.conclusion === 'startup_failure'
  ) {
    return 'failure';
  }
  return 'neutral';
}

function toBuildInfo(run: RawWorkflowRun | null): BuildInfo {
  if (run === null) {
    return {
      status: 'none',
      workflowName: null,
      url: null,
      finishedAt: null,
      resultDescription: null,
    };
  }
  return {
    status: buildStatus(run),
    workflowName: run.name,
    url: run.html_url,
    finishedAt: run.updated_at,
    resultDescription: run.conclusion,
  };
}

/** Production GitHub REST adapter. Protocol failures become PortFailure. */
export function createHttpGitHub(fetchImpl: typeof fetch = fetch, timeoutMs = REQUEST_TIMEOUT_MS): GitHubPort {
  async function request<T>(
    accessToken: string,
    path: string,
    map: (json: unknown) => T,
    onNotFound?: () => T,
  ): Promise<T> {
    try {
      const response = await fetchImpl(`${API_BASE}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
        },
      });
      if (!response.ok) {
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        if (response.status === 404 && onNotFound !== undefined) return onNotFound();
        throw new GitHubHttpError(response.status, headers);
      }
      return map(await response.json());
    } catch (error) {
      throw toPortFailure(error);
    }
  }

  return {
    validateAccessToken(accessToken: string): Promise<void> {
      return request(accessToken, '/user', () => undefined);
    },

    getRepositoryMeta(accessToken: string, fullName: string): Promise<RepoMeta> {
      return request(accessToken, `/repos/${fullName}`, (json) => {
        const repo = json as RawRepo;
        return {
          fullName: repo.full_name,
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          openIssues: repo.open_issues_count,
          pushedAt: repo.pushed_at,
        };
      });
    },

    getLatestRelease(accessToken: string, fullName: string): Promise<ReleaseItem | null> {
      return request(
        accessToken,
        `/repos/${fullName}/releases/latest`,
        (json) => toReleaseItem(json as RawRelease),
        () => null,
      );
    },

    listReleases(accessToken: string, fullName: string): Promise<ReleaseItem[]> {
      return request(accessToken, `/repos/${fullName}/releases?per_page=30`, (json) =>
        (json as RawRelease[]).map(toReleaseItem),
      );
    },

    listCommits(accessToken: string, fullName: string): Promise<CommitItem[]> {
      return request(accessToken, `/repos/${fullName}/commits?per_page=30`, (json) =>
        (json as RawCommit[]).map((commit) => ({
          sha: commit.sha,
          message: commit.commit.message.split('\n')[0] ?? '',
          authorName: commit.commit.author?.name ?? null,
          committedAt: commit.commit.author?.date ?? commit.commit.committer?.date ?? '',
        })),
      );
    },

    listIssues(accessToken: string, fullName: string): Promise<IssueOrPullRequest[]> {
      return request(accessToken, `/repos/${fullName}/issues?state=all&per_page=50`, (json) =>
        (json as RawIssue[]).map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? null,
          state: issue.state === 'closed' ? 'closed' : 'open',
          authorName: issue.user?.login ?? null,
          updatedAt: issue.updated_at,
          kind: issue.pull_request === undefined ? 'issue' : 'pull',
        })),
      );
    },

    async getLatestBuild(accessToken: string, fullName: string): Promise<BuildInfo | null> {
      const run = await request(accessToken, `/repos/${fullName}/actions/runs?per_page=1`, (json) => {
        const runs = (json as { workflow_runs?: RawWorkflowRun[] }).workflow_runs;
        return runs?.[0] ?? null;
      });
      return run === null ? null : toBuildInfo(run);
    },
  };
}

export { toBuildInfo };
