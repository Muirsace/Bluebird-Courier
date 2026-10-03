import type { RepoMeta } from '../../../domain/ports';
import type { RepositoryMetadata } from '../../../domain/types';
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

function repositoryPath(fullName: string): string {
  const pieces = fullName.split('/');
  if (pieces.length !== 2 || pieces.some((piece) => !/^[A-Za-z0-9._-]+$/.test(piece) || piece === '.' || piece === '..')) {
    throw new TypeError('仓库标识无效');
  }
  return `/repos/${pieces.map(encodeURIComponent).join('/')}`;
}

/** GitHub 仓库元数据与外部状态协议适配。 */
export function createGitHubRepositoryAdapter(client: GitHubHttpClient) {
  return {
    getRepositoryMeta(accessToken: string, fullName: string): Promise<RepoMeta> {
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
        };
      });
    },
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
  };
}
