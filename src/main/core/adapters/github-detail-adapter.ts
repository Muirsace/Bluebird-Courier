import type { BuildInfo, BuildItem, CommitItem, ReadmeDocument, ReleaseItem, TagItem, TreeEntry } from '../../../domain/types';
import type { GitHubHttpClient } from './github-http-client';
import type { IssueOrPullRequest } from '../../../domain/ports';

interface RawRelease { tag_name?: unknown; name?: unknown; published_at?: unknown }
interface RawCommit { sha?: unknown; commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } | null; committer?: { date?: unknown } | null } }
interface RawIssue { number?: unknown; title?: unknown; body?: unknown; state?: unknown; user?: { login?: unknown } | null; updated_at?: unknown; pull_request?: unknown }
interface RawWorkflowRun { name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown; updated_at?: unknown }

function repoPath(fullName: string): string {
  const pieces = fullName.split('/');
  if (pieces.length !== 2 || pieces.some((piece) => !/^[A-Za-z0-9._-]+$/.test(piece) || piece === '.' || piece === '..')) throw new TypeError('仓库标识无效');
  return `/repos/${pieces.map(encodeURIComponent).join('/')}`;
}

function arrayOf<T>(json: unknown): T[] {
  if (!Array.isArray(json)) throw new TypeError('GitHub 列表响应格式无效');
  return json as T[];
}

function toReleaseItem(release: RawRelease): ReleaseItem {
  if (typeof release.tag_name !== 'string') throw new TypeError('Release 响应格式无效');
  return {
    tagName: release.tag_name,
    title: typeof release.name === 'string' && release.name.length > 0 ? release.name : release.tag_name,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
  };
}

function toIssue(item: RawIssue): IssueOrPullRequest {
  if (!Number.isSafeInteger(item.number) || typeof item.title !== 'string' || typeof item.updated_at !== 'string') throw new TypeError('Issue 响应格式无效');
  const base = {
    number: item.number as number,
    title: item.title,
    body: typeof item.body === 'string' ? item.body : null,
    state: item.state === 'closed' ? 'closed' as const : 'open' as const,
    authorName: item.user && typeof item.user.login === 'string' ? item.user.login : null,
    updatedAt: item.updated_at,
  };
  return item.pull_request === undefined ? { ...base, kind: 'issue' } : { ...base, kind: 'pull' };
}

function buildStatus(run: RawWorkflowRun): BuildInfo['status'] {
  if (run.conclusion === null || run.conclusion === undefined) return 'pending';
  if (run.conclusion === 'success') return 'success';
  if (['failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled'].includes(String(run.conclusion))) return 'failure';
  return 'neutral';
}

export function toBuildInfo(run: RawWorkflowRun | null): BuildInfo {
  if (run === null) return { status: 'none', workflowName: null, url: null, finishedAt: null, resultDescription: null };
  return {
    status: buildStatus(run),
    workflowName: typeof run.name === 'string' ? run.name : null,
    url: typeof run.html_url === 'string' ? run.html_url : null,
    finishedAt: typeof run.updated_at === 'string' ? run.updated_at : null,
    resultDescription: typeof run.conclusion === 'string' ? run.conclusion : null,
  };
}

/** 详情栏目协议适配器，不做缓存、旧资料和栏目业务状态判断。 */
export function createGitHubDetailAdapter(client: GitHubHttpClient) {
  return {
    getLatestRelease(accessToken: string, fullName: string): Promise<ReleaseItem | null> {
      return client.request(accessToken, `${repoPath(fullName)}/releases/latest`, (json) => toReleaseItem(json as RawRelease), () => null);
    },
    listReleases(accessToken: string, fullName: string): Promise<ReleaseItem[]> {
      return client.request(accessToken, `${repoPath(fullName)}/releases?per_page=30`, (json) => arrayOf<RawRelease>(json).map(toReleaseItem));
    },
    listCommits(accessToken: string, fullName: string): Promise<CommitItem[]> {
      return client.request(accessToken, `${repoPath(fullName)}/commits?per_page=30`, (json) => arrayOf<RawCommit>(json).map((commit) => {
        if (typeof commit.sha !== 'string' || !commit.commit || typeof commit.commit.message !== 'string') throw new TypeError('Commit 响应格式无效');
        return {
          sha: commit.sha,
          message: commit.commit.message.split('\n')[0] ?? '',
          authorName: commit.commit.author && typeof commit.commit.author.name === 'string' ? commit.commit.author.name : null,
          committedAt: commit.commit.author && typeof commit.commit.author.date === 'string' ? commit.commit.author.date :
            (commit.commit.committer && typeof commit.commit.committer.date === 'string' ? commit.commit.committer.date : ''),
        };
      }));
    },
    listIssues(accessToken: string, fullName: string): Promise<IssueOrPullRequest[]> {
      return client.request(accessToken, `${repoPath(fullName)}/issues?state=all&per_page=50`, (json) => arrayOf<RawIssue>(json).map(toIssue));
    },
    async getLatestBuild(accessToken: string, fullName: string): Promise<BuildInfo | null> {
      const run = await client.request(accessToken, `${repoPath(fullName)}/actions/runs?per_page=1`, (json) => {
        if (typeof json !== 'object' || json === null) throw new TypeError('构建响应格式无效');
        const runs = (json as { workflow_runs?: unknown }).workflow_runs;
        if (!Array.isArray(runs)) return null;
        return (runs[0] as RawWorkflowRun | undefined) ?? null;
      });
      return toBuildInfo(run);
    },
    listTags(accessToken: string, fullName: string): Promise<TagItem[]> {
      return client.request(accessToken, `${repoPath(fullName)}/tags?per_page=30`, (json) => arrayOf<{ name?: unknown }>(json).flatMap((tag) => typeof tag.name === 'string' ? [{ name: tag.name }] : []));
    },
    getReadme(accessToken: string, fullName: string): Promise<{ content: string; encoding: string; path: string } | null> {
      return client.request(accessToken, `${repoPath(fullName)}/readme`, (json) => {
        if (typeof json !== 'object' || json === null) return null;
        const value = json as { content?: unknown; encoding?: unknown; path?: unknown };
        if (typeof value.content !== 'string') return null;
        return { content: value.content, encoding: typeof value.encoding === 'string' ? value.encoding : 'utf-8', path: typeof value.path === 'string' ? value.path : 'README.md' };
      }, () => null);
    },
    listLanguages(accessToken: string, fullName: string): Promise<Record<string, number>> {
      return client.request(accessToken, `${repoPath(fullName)}/languages`, (json) => {
        if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new TypeError('语言响应格式无效');
        const result: Record<string, number> = {};
        for (const [key, value] of Object.entries(json)) if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
        return result;
      });
    },
    getTree(accessToken: string, fullName: string, branch = 'HEAD'): Promise<Array<{ path: string; type: string; sha: string }>> {
      return client.request(accessToken, `${repoPath(fullName)}/git/trees/${encodeURIComponent(branch)}?recursive=1`, (json) => {
        const tree = typeof json === 'object' && json !== null ? (json as { tree?: unknown }).tree : undefined;
        return arrayOf<{ path?: unknown; type?: unknown; sha?: unknown }>(tree).flatMap((entry) => typeof entry.path === 'string' && typeof entry.type === 'string' && typeof entry.sha === 'string' ? [{ path: entry.path, type: entry.type, sha: entry.sha }] : []);
      });
    },
    listBuilds(accessToken: string, fullName: string): Promise<BuildItem[]> {
      return client.request(accessToken, `${repoPath(fullName)}/actions/runs?per_page=5`, (json) => {
        const runs = typeof json === 'object' && json !== null ? (json as { workflow_runs?: unknown }).workflow_runs : undefined;
        return arrayOf<RawWorkflowRun>(runs).map((run) => ({ ...toBuildInfo(run), id: null }));
      });
    },
    listReadmes(accessToken: string, fullName: string): Promise<ReadmeDocument[]> {
      return client.request(accessToken, `${repoPath(fullName)}/contents`, (json) => {
        const entries = arrayOf<{ name?: unknown; path?: unknown; type?: unknown }>(json);
        return entries
          .filter((entry) => entry.type === 'file' && typeof entry.name === 'string' && /^README(?:\.|$)/i.test(entry.name))
          .map((entry) => ({ language: typeof entry.name === 'string' && entry.name.includes('.') ? entry.name.split('.').pop() ?? 'unknown' : 'unknown', content: typeof entry.path === 'string' ? entry.path : '' }));
      });
    },
    listTree(accessToken: string, fullName: string): Promise<TreeEntry[]> {
      return client.request(accessToken, `${repoPath(fullName)}/git/trees/HEAD?recursive=1`, (json) => {
        const tree = typeof json === 'object' && json !== null ? (json as { tree?: unknown }).tree : undefined;
        return arrayOf<{ path?: unknown; type?: unknown; size?: unknown }>(tree).flatMap((entry) => {
          if (typeof entry.path !== 'string') return [];
          return [{ path: entry.path, kind: entry.type === 'tree' ? 'directory' as const : 'file' as const, size: typeof entry.size === 'number' ? entry.size : null }];
        });
      });
    },
    getCollaborationActivity(accessToken: string, fullName: string): Promise<string | null> {
      return client.request(accessToken, `${repoPath(fullName)}/issues?state=all&sort=updated&direction=desc&per_page=1`, (json) => {
        const first = arrayOf<RawIssue>(json)[0];
        return first && typeof first.updated_at === 'string' ? first.updated_at : null;
      });
    },
  };
}
