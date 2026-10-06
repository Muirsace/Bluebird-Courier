import type { RepoMeta } from '../../../domain/ports';
import type { CheckedSignal, ReleaseItem, RepositoryMetadata, SummaryObservation } from '../../../domain/types';
import type { GitHubHttpClient } from './github-http-client';

interface RawRepo {
  full_name: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string | null;
  archived?: boolean;
  disabled?: boolean;
  html_url?: string;
  updated_at?: string;
  description?: string | null;
  homepage?: string | null;
  license?: { spdx_id?: string | null } | null;
  default_branch?: string | null;
}

interface RawRef { object?: { sha?: unknown } | null }
interface RawRelease { tag_name?: unknown; name?: unknown; published_at?: unknown }
interface RawTag { name?: unknown; commit?: { sha?: unknown } | null }
interface RawIssue { updated_at?: unknown; state?: unknown; pull_request?: unknown }

function repositoryPath(fullName: string): string {
  const pieces = fullName.split('/');
  if (pieces.length !== 2 || pieces.some((piece) => !/^[A-Za-z0-9._-]+$/.test(piece) || piece === '.' || piece === '..')) {
    throw new TypeError('仓库标识无效');
  }
  return `/repos/${pieces.map(encodeURIComponent).join('/')}`;
}

function encodedBranch(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

function releaseFingerprint(release: { tagName: string; title: string; publishedAt: string | null }): string {
  // 覆盖页面关心的编辑字段：同一 Release 被编辑（标题 / 时间变化）也会产生新指纹。
  return JSON.stringify([release.tagName, release.title, release.publishedAt]);
}

/** 单信号失败隔离：失败时记为 unknown，不拖垮整次观察，也不冒充"确认不存在"。 */
async function checked<T>(work: () => Promise<T>, checkedAt: string): Promise<CheckedSignal<T>> {
  try {
    return { state: 'known', value: await work(), checkedAt };
  } catch (error) {
    return { state: 'unknown', error: error instanceof Error ? error.message : '检查失败' };
  }
}

/** GitHub 仓库元数据与外部状态协议适配。 */
export function createGitHubRepositoryAdapter(client: GitHubHttpClient) {
  function fetchRepositoryMeta(accessToken: string, fullName: string): Promise<RepoMeta> {
    return client.request(accessToken, repositoryPath(fullName), (json) => {
      if (typeof json !== 'object' || json === null) throw new TypeError('仓库响应格式无效');
      const repo = json as Partial<RawRepo>;
      if (typeof repo.full_name !== 'string' || !Number.isFinite(repo.stargazers_count) ||
          !Number.isFinite(repo.forks_count) || !Number.isFinite(repo.open_issues_count)) {
        throw new TypeError('仓库响应缺少必要字段');
      }
      return {
        fullName: repo.full_name,
        stars: repo.stargazers_count as number,
        forks: repo.forks_count as number,
        openIssues: repo.open_issues_count as number,
        pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null,
        defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
        status: repo.archived === true ? 'archived' : repo.disabled === true ? 'deleted' : 'active',
      };
    });
  }

  function fetchRelease(accessToken: string, fullName: string): Promise<{ tagName: string; title: string; publishedAt: string | null } | null> {
    return client.request(accessToken, `${repositoryPath(fullName)}/releases/latest`, (json) => {
      const release = json as RawRelease;
      if (typeof release.tag_name !== 'string') throw new TypeError('Release 响应格式无效');
      return {
        tagName: release.tag_name,
        title: typeof release.name === 'string' && release.name.length > 0 ? release.name : release.tag_name,
        publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      };
    }, () => null);
  }

  function fetchLatestTag(accessToken: string, fullName: string): Promise<{ name: string; commitSha: string | null } | null> {
    return client.request(accessToken, `${repositoryPath(fullName)}/tags?per_page=1`, (json) => {
      if (!Array.isArray(json)) throw new TypeError('Tag 响应格式无效');
      const first = json[0] as RawTag | undefined;
      if (!first || typeof first.name !== 'string') return null;
      return { name: first.name, commitSha: first.commit && typeof first.commit.sha === 'string' ? first.commit.sha : null };
    });
  }

  function fetchHeadRevision(accessToken: string, fullName: string, branch: string): Promise<string> {
    return client.request(accessToken, `${repositoryPath(fullName)}/git/ref/heads/${encodedBranch(branch)}`, (json) => {
      const sha = (json as RawRef).object?.sha;
      if (typeof sha !== 'string') throw new TypeError('默认分支引用格式无效');
      return sha;
    });
  }

  function fetchCollaborationProbe(accessToken: string, fullName: string): Promise<{ at: string; state: 'open' | 'closed'; pullRequest: boolean } | null> {
    return client.request(accessToken, `${repositoryPath(fullName)}/issues?state=all&sort=updated&direction=desc&per_page=1`, (json) => {
      if (!Array.isArray(json)) throw new TypeError('Issue 响应格式无效');
      const first = json[0] as RawIssue | undefined;
      if (!first || typeof first.updated_at !== 'string') return null; // 成功确认没有协作活动
      return { at: first.updated_at, state: first.state === 'closed' ? 'closed' : 'open', pullRequest: first.pull_request !== undefined };
    });
  }

  return {
    getRepositoryMeta: fetchRepositoryMeta,
    getRepositoryStatus(accessToken: string, fullName: string): Promise<{ archived: boolean; disabled: boolean; updatedAt: string | null; url: string | null }> {
      return client.request(accessToken, repositoryPath(fullName), (json) => {
        const repo = json as Partial<RawRepo>;
        return {
          archived: repo.archived === true,
          disabled: repo.disabled === true,
          updatedAt: typeof repo.updated_at === 'string' ? repo.updated_at : null,
          url: typeof repo.html_url === 'string' ? repo.html_url : null,
        };
      });
    },
    getMetadata(accessToken: string, fullName: string): Promise<RepositoryMetadata> {
      return client.request(accessToken, repositoryPath(fullName), (json) => {
        const repo = json as Partial<RawRepo>;
        return {
          description: typeof repo.description === 'string' ? repo.description : null,
          homepage: typeof repo.homepage === 'string' ? repo.homepage : null,
          license: repo.license && typeof repo.license.spdx_id === 'string' ? repo.license.spdx_id : null,
          defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
        };
      });
    },

    /**
     * 轻量观察：一次仓库元数据 + 三类信号探测（默认分支 HEAD / Release / Tag）+ 协作活动线索。
     * 摘要本身失败（仓库不存在 / 令牌失效 / 网络失败）时抛出，由调用方保留旧摘要；
     * 单个信号失败只把该信号记为 unknown，其余信号照常返回。
     * 访问上下文版本由调用链传入并原样回显，adapter 不自行猜测。
     */
    async observeSummary(accessToken: string, fullName: string, observedAt: string, accessContextRevision: number): Promise<SummaryObservation> {
      const meta = await fetchRepositoryMeta(accessToken, fullName);
      const defaultBranch = meta.defaultBranch ?? null;
      const [headRevision, release, tag] = await Promise.all([
        checked<string>(() => {
          if (defaultBranch === null) throw new Error('默认分支未知');
          return fetchHeadRevision(accessToken, fullName, defaultBranch);
        }, observedAt),
        checked<{ tagName: string; title: string; publishedAt: string | null } | null>(() => fetchRelease(accessToken, fullName), observedAt),
        checked<{ name: string; commitSha: string | null } | null>(() => fetchLatestTag(accessToken, fullName), observedAt),
      ]);
      const collaboration = await checked<{ at: string; state: 'open' | 'closed'; pullRequest: boolean } | null>(() => fetchCollaborationProbe(accessToken, fullName), observedAt);

      const releaseValue = release.state === 'known' ? release.value : null;
      const tagValue = tag.state === 'known' ? tag.value : null;
      const collaborationValue = collaboration.state === 'known' ? collaboration.value : null;
      const releaseRevision: CheckedSignal<string> = release.state === 'known'
        ? { state: 'known', value: releaseValue === null ? null : releaseFingerprint(releaseValue), checkedAt: observedAt }
        : release;
      const tagRevision: CheckedSignal<string> = tag.state === 'known'
        ? { state: 'known', value: tagValue === null ? null : JSON.stringify([tagValue.name, tagValue.commitSha]), checkedAt: observedAt }
        : tag;

      return {
        fullName: meta.fullName,
        observedAt,
        accessContextRevision,
        values: {
          stars: meta.stars,
          forks: meta.forks,
          openIssues: meta.openIssues,
          pushedAt: meta.pushedAt,
          latestReleaseTag: releaseValue?.tagName ?? tagValue?.name ?? null,
          latestTag: tagValue?.name ?? null,
          collaborationAt: collaborationValue?.at ?? null,
          status: meta.status ?? 'active',
        },
        signals: {
          defaultBranch: { state: 'known', value: defaultBranch, checkedAt: observedAt },
          headRevision,
          releaseRevision,
          tagRevision,
        },
        activity: {
          // 代码候选：pushedAt 只是推送线索；默认分支 HEAD 的检查结果在 signals.headRevision
          code: { kind: 'code', at: meta.pushedAt, verified: false },
          // 发版候选：发版实际发生时间，直接读到
          release: { kind: 'release', at: releaseValue?.publishedAt ?? null, verified: true },
          // 协作候选：区分 Issue / PR 并保留状态；失败或确认无活动时 at 为 null（失败的保留策略在调用方）
          collaboration: collaborationValue === null
            ? { kind: 'issue', at: null, verified: false }
            : { kind: collaborationValue.pullRequest ? 'pull-request' : 'issue', at: collaborationValue.at, verified: true, state: collaborationValue.state },
        },
      };
    },
  };
}

export { releaseFingerprint, encodedBranch };
