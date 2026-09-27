import type { CommitItem, ReleaseItem } from '../../../shared/types';
import {
  GitHubRequestError,
  type BuildRun,
  type GitHubPort,
  type IssueOrPullRequest,
  type RepoMeta,
} from './port';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'octo-monitor';

/** 单次请求上限：连接挂起时必须中止，否则整个抓取批次都不再 settle。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** GitHub REST 的原始应答（只声明用到的字段）。 */
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
  run_started_at?: string | null;
}

function toReleaseItem(release: RawRelease): ReleaseItem {
  return {
    tagName: release.tag_name,
    title: release.name ?? release.tag_name,
    publishedAt: release.published_at,
  };
}

/**
 * GitHub REST 适配器（生产实现）。
 * 请求一律带访问令牌与固定 API 版本号；单次请求有超时，超时以 TimeoutError 中止。
 * HTTP 错误抛 GitHubRequestError，网络层失败原样抛 TypeError（错误归一映射为"网络失败"）。
 */
export function createHttpGitHub(fetchImpl: typeof fetch = fetch, timeoutMs = REQUEST_TIMEOUT_MS): GitHubPort {
  async function request<T>(accessToken: string, path: string, map: (json: unknown) => T): Promise<T> {
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
      throw new GitHubRequestError(response.status, headers);
    }
    return map(await response.json());
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

    async getLatestRelease(accessToken: string, fullName: string): Promise<ReleaseItem | null> {
      try {
        return await request(accessToken, `/repos/${fullName}/releases/latest`, (json) =>
          toReleaseItem(json as RawRelease),
        );
      } catch (error) {
        // 无发版的仓库该端点返回 404 —— 缺省值记空，不视为错误
        if (error instanceof GitHubRequestError && error.status === 404) return null;
        throw error;
      }
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
      // 同一端点返回议题与合并请求，按是否带 pull_request 标记拆分
      return request(accessToken, `/repos/${fullName}/issues?state=all&per_page=50`, (json) =>
        (json as RawIssue[]).map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state === 'closed' ? 'closed' : 'open',
          authorName: issue.user?.login ?? null,
          updatedAt: issue.updated_at,
          hasPullRequest: issue.pull_request !== undefined,
        })),
      );
    },

    async getLatestBuild(accessToken: string, fullName: string): Promise<BuildRun | null> {
      const run = await request(accessToken, `/repos/${fullName}/actions/runs?per_page=1`, (json) => {
        const runs = (json as { workflow_runs: RawWorkflowRun[] }).workflow_runs;
        return runs[0] ?? null;
      });
      if (run === null) return null; // 没有构建
      return {
        workflowName: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
        finishedAt: run.updated_at,
      };
    },
  };
}
