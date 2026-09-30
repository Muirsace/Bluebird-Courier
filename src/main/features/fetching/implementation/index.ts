import type { GitHubPort } from '../../../../domain/ports';
import type {
  BuildInfo,
  DetailValues,
  FetchedGlance,
  IssueItem,
  PullRequestItem,
} from '../../../../domain/types';
import type { FetchingFeature } from '../contract';

export interface FetchingDependencies {
  github: GitHubPort;
}

function emptyBuild(): BuildInfo {
  return {
    status: 'none',
    workflowName: null,
    url: null,
    finishedAt: null,
    resultDescription: null,
  };
}

export function createFetching({ github }: FetchingDependencies): FetchingFeature {
  const validateAccessToken = (token: string): Promise<void> => github.validateAccessToken(token);

  const fetchGlance = async (token: string, fullName: string): Promise<FetchedGlance> => {
    const meta = await github.getRepositoryMeta(token, fullName);
    const latestRelease = await github.getLatestRelease(token, fullName);
    return {
      fullName: meta.fullName,
      stars: meta.stars,
      forks: meta.forks,
      openIssues: meta.openIssues,
      pushedAt: meta.pushedAt,
      latestReleaseTag: latestRelease?.tagName ?? null,
    };
  };

  const fetchDetail = async (token: string, fullName: string): Promise<DetailValues> => {
    const releases = await github.listReleases(token, fullName);
    const commits = await github.listCommits(token, fullName);
    const issueResults = await github.listIssues(token, fullName);
    const latestBuild = await github.getLatestBuild(token, fullName);

    const issues: IssueItem[] = [];
    const pullRequests: PullRequestItem[] = [];
    for (const result of issueResults) {
      const { kind, ...item } = result;
      if (kind === 'pull') pullRequests.push(item);
      else issues.push(item);
    }

    return {
      releases,
      commits,
      issues,
      pullRequests,
      build: latestBuild ?? emptyBuild(),
    };
  };

  return { validateAccessToken, fetchGlance, fetchDetail };
}

export type { FetchingFeature } from '../contract';
