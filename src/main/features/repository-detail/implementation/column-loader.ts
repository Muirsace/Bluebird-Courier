import type { GitHubPort, IssueOrPullRequest } from '../../../../domain/ports';
import type { BuildInfo, BuildItem, CommitItem, IssueItem, PullRequestItem, ReadmeDocument, ReleaseItem, RepositoryMetadata, TagItem, TreeEntry } from '../../../../domain/types';

export interface LoadedDetailColumns {
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

function itemsOf<T>(page: T[] | { items: T[]; nextCursor: string | null }): T[] {
  return Array.isArray(page) ? page : page.items;
}

function emptyBuild(): BuildInfo {
  return { status: 'none', workflowName: null, url: null, finishedAt: null, resultDescription: null };
}

export async function loadDetailColumns(github: GitHubPort, token: string, fullName: string): Promise<LoadedDetailColumns> {
  const [releasePage, commitPage, issuePage, latestBuild, metadata, tagsPage, builds, readmes, tree] = await Promise.all([
    github.listReleases(token, fullName),
    github.listCommits(token, fullName),
    github.listIssues(token, fullName),
    github.getLatestBuild(token, fullName),
    github.getMetadata ? github.getMetadata(token, fullName) : Promise.resolve(undefined),
    github.listTags ? github.listTags(token, fullName) : Promise.resolve(undefined),
    github.listBuilds ? github.listBuilds(token, fullName) : Promise.resolve(undefined),
    github.listReadmes ? github.listReadmes(token, fullName) : Promise.resolve(undefined),
    github.listTree ? github.listTree(token, fullName) : Promise.resolve(undefined),
  ]);
  const releases = itemsOf(releasePage);
  const commits = itemsOf(commitPage);
  const issueResults = itemsOf(issuePage);
  const rawTags = tagsPage as string[] | { items: TagItem[]; nextCursor: string | null } | undefined;
  const tags = rawTags === undefined ? undefined : (Array.isArray(rawTags) ? rawTags : rawTags.items).map((tag) => typeof tag === 'string' ? { name: tag, committedAt: null } : tag);
  const issues: IssueItem[] = [];
  const pullRequests: PullRequestItem[] = [];
  for (const result of issueResults as IssueOrPullRequest[]) {
    const { kind, ...item } = result;
    (kind === 'pull' ? pullRequests : issues).push(item);
  }
  return { releases, commits, issues, pullRequests, build: latestBuild ?? emptyBuild(), metadata, tags, builds, readmes, tree };
}
