import { PortFailure } from '../../../domain/ports';
import type {
  IssueOrPullRequest,
  OverviewContent,
  ScopeFetchOutcome,
  ScopeFetchRequest,
  ScopeVerification,
  ScopeVerifyRequest,
} from '../../../domain/ports';
import type {
  BuildInfo,
  BuildItem,
  CommitItem,
  ContentVersion,
  GlanceValues,
  PullRequestItem,
  ReadmeDocument,
  ReleaseItem,
  RepositoryMetadata,
  TagItem,
  TreeEntry,
} from '../../../domain/types';
import type { GitHubHttpClient } from './github-http-client';
import { encodedBranch, releaseFingerprint } from './github-repository-adapter';

interface RawRelease { tag_name?: unknown; name?: unknown; published_at?: unknown }
interface RawCommit { sha?: unknown; commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } | null; committer?: { date?: unknown } | null } }
interface RawIssue { number?: unknown; title?: unknown; body?: unknown; state?: unknown; user?: { login?: unknown } | null; updated_at?: unknown; pull_request?: unknown }
interface RawPull { number?: unknown; title?: unknown; body?: unknown; state?: unknown; user?: { login?: unknown } | null; updated_at?: unknown; draft?: unknown; merged_at?: unknown; head?: { ref?: unknown } | null; base?: { ref?: unknown } | null }
interface RawWorkflowRun { id?: unknown; run_attempt?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown; updated_at?: unknown }
interface RawRepo { full_name?: unknown; stargazers_count?: unknown; forks_count?: unknown; open_issues_count?: unknown; pushed_at?: unknown; default_branch?: unknown; description?: unknown; homepage?: unknown; license?: { spdx_id?: unknown } | null }

const PAGE_SIZE = 100;
/** 平台单页上限：调用方给的 limit 超过它时必须按平台值读取，否则会误判"没有更多"。 */
const PLATFORM_PAGE_LIMIT = 100;
/** 增量探测的重叠窗口：避免同秒边界与查询期间的写入被跳过（设计 10.2）。 */
const PROBE_OVERLAP_MS = 60_000;

function effectiveLimit(limit: number): number {
  const rounded = Number.isFinite(limit) ? Math.floor(limit) : PLATFORM_PAGE_LIMIT;
  return Math.min(Math.max(1, rounded), PLATFORM_PAGE_LIMIT);
}

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

function toPull(item: RawPull): PullRequestItem & { kind: 'pull' } {
  const issue = toIssue(item);
  return { ...issue, kind: 'pull' };
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

function mapCommits(json: unknown): CommitItem[] {
  return arrayOf<RawCommit>(json).map((commit) => {
    if (typeof commit.sha !== 'string' || !commit.commit || typeof commit.commit.message !== 'string') throw new TypeError('Commit 响应格式无效');
    return {
      sha: commit.sha,
      message: commit.commit.message.split('\n')[0] ?? '',
      authorName: commit.commit.author && typeof commit.commit.author.name === 'string' ? commit.commit.author.name : null,
      committedAt: commit.commit.author && typeof commit.commit.author.date === 'string' ? commit.commit.author.date :
        (commit.commit.committer && typeof commit.commit.committer.date === 'string' ? commit.commit.committer.date : ''),
    };
  });
}

interface ReadmeEntry { name: string; path: string; sha: string | null }

function readmeEntries(json: unknown): ReadmeEntry[] {
  const entries = arrayOf<{ name?: unknown; path?: unknown; type?: unknown; sha?: unknown }>(json);
  return entries
    .filter((entry) => entry.type === 'file' && typeof entry.name === 'string' && /^README(?:\.|$)/i.test(entry.name))
    .map((entry) => ({ name: entry.name as string, path: typeof entry.path === 'string' ? entry.path : '', sha: typeof entry.sha === 'string' ? entry.sha : null }));
}

function toReadmeDocument(entry: ReadmeEntry): ReadmeDocument {
  return { language: entry.name.includes('.') ? entry.name.split('.').pop() ?? 'unknown' : 'unknown', content: entry.path };
}

function mapReadmes(json: unknown): ReadmeDocument[] {
  return readmeEntries(json).map(toReadmeDocument);
}

/** readme 范围的单一摘要定义：采集与验证共用，路径与内容 sha 排序后比较。 */
function readmeScopeDigest(entries: ReadmeEntry[]): string {
  return JSON.stringify([entries.map((entry) => [entry.path, entry.sha]).sort()]);
}

function mapTree(json: unknown): TreeEntry[] {
  const tree = typeof json === 'object' && json !== null ? (json as { tree?: unknown }).tree : undefined;
  return arrayOf<{ path?: unknown; type?: unknown; size?: unknown }>(tree).flatMap((entry) => {
    if (typeof entry.path !== 'string') return [];
    return [{ path: entry.path, kind: entry.type === 'tree' ? 'directory' as const : 'file' as const, size: typeof entry.size === 'number' ? entry.size : null }];
  });
}

function mapRuns(json: unknown): RawWorkflowRun[] {
  const runs = typeof json === 'object' && json !== null ? (json as { workflow_runs?: unknown }).workflow_runs : undefined;
  return arrayOf<RawWorkflowRun>(runs);
}

/** 构建指纹元组：id、重跑次数、状态、结果；任一变化都算变化（含结束与重跑）。 */
function runTuple(run: RawWorkflowRun): [string, number, string, string | null] {
  return [
    String(run.id ?? ''),
    Number.isSafeInteger(run.run_attempt) ? run.run_attempt as number : 1,
    typeof run.status === 'string' ? run.status : 'unknown',
    typeof run.conclusion === 'string' ? run.conclusion : null,
  ];
}

function parseFingerprint(fingerprint: string | null): Record<string, unknown> | null {
  if (fingerprint === null) return null;
  try {
    const value = JSON.parse(fingerprint) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function parseCursor(cursor: string | null): Record<string, unknown> {
  if (cursor === null) return {};
  try {
    const value = JSON.parse(cursor) as unknown;
    // 单列表输出数字字符串，Issue/PR 双源输出对象，两种游标均须可续读。
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return { page: value };
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function pageOf(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 详情栏目协议适配器，不做缓存、旧资料和栏目业务状态判断。 */
export function createGitHubDetailAdapter(client: GitHubHttpClient) {
  function fetchIssuesRaw(accessToken: string, fullName: string, query: string): Promise<RawIssue[]> {
    return client.request(accessToken, `${repoPath(fullName)}/issues?${query}`, (json) => arrayOf<RawIssue>(json));
  }

  function fetchPullsRaw(accessToken: string, fullName: string, query: string): Promise<RawPull[]> {
    return client.request(accessToken, `${repoPath(fullName)}/pulls?${query}`, (json) => arrayOf<RawPull>(json));
  }

  function fetchRunsPage(accessToken: string, fullName: string, perPage: number, page: number): Promise<RawWorkflowRun[]> {
    return client.request(accessToken, `${repoPath(fullName)}/actions/runs?per_page=${perPage}&page=${page}`, mapRuns);
  }

  function fetchRun(accessToken: string, fullName: string, runId: string): Promise<RawWorkflowRun> {
    return client.request(accessToken, `${repoPath(fullName)}/actions/runs/${encodeURIComponent(runId)}`, (json) => {
      if (typeof json !== 'object' || json === null) throw new TypeError('构建响应格式无效');
      return json as RawWorkflowRun;
    });
  }

  function fetchHeadSha(accessToken: string, fullName: string, branch: string): Promise<string> {
    return client.request(accessToken, `${repoPath(fullName)}/git/ref/heads/${encodedBranch(branch)}`, (json) => {
      const sha = (json as { object?: { sha?: unknown } | null }).object?.sha;
      if (typeof sha !== 'string') throw new TypeError('默认分支引用格式无效');
      return sha;
    });
  }

  function fetchReleaseRaw(accessToken: string, fullName: string): Promise<ReleaseItem | null> {
    return client.request(accessToken, `${repoPath(fullName)}/releases/latest`, (json) => toReleaseItem(json as RawRelease), () => null);
  }

  function fetchTagRaw(accessToken: string, fullName: string): Promise<{ name: string; commitSha: string | null } | null> {
    return client.request(accessToken, `${repoPath(fullName)}/tags?per_page=1`, (json) => {
      if (!Array.isArray(json)) throw new TypeError('Tag 响应格式无效');
      const first = json[0] as { name?: unknown; commit?: { sha?: unknown } | null } | undefined;
      if (!first || typeof first.name !== 'string') return null;
      return { name: first.name, commitSha: first.commit && typeof first.commit.sha === 'string' ? first.commit.sha : null };
    });
  }

  function fetchTagsPage(accessToken: string, fullName: string, perPage: number, page: number): Promise<Array<{ name: string; commitSha: string | null }>> {
    return client.request(accessToken, `${repoPath(fullName)}/tags?per_page=${perPage}&page=${page}`, (json) => {
      if (!Array.isArray(json)) throw new TypeError('Tag 响应格式无效');
      return json.flatMap((tag) => {
        const value = tag as { name?: unknown; commit?: { sha?: unknown } | null };
        return typeof value.name === 'string'
          ? [{ name: value.name, commitSha: value.commit && typeof value.commit.sha === 'string' ? value.commit.sha : null }]
          : [];
      });
    });
  }

  function fetchTreeSha(accessToken: string, fullName: string, branch: string): Promise<string> {
    return client.request(accessToken, `${repoPath(fullName)}/git/trees/${encodedBranch(branch)}`, (json) => {
      const sha = (json as { sha?: unknown }).sha;
      if (typeof sha !== 'string') throw new TypeError('树响应格式无效');
      return sha;
    });
  }

  function tagFingerprint(tag: { name: string; commitSha: string | null } | null): string | null {
    return tag === null ? null : JSON.stringify([tag.name, tag.commitSha]);
  }

  function incompleteVerification(request: ScopeVerifyRequest): ScopeVerification {
    return { scope: request.scope, checkedAt: request.checkedAt, checkComplete: false, changed: false, accessContextRevision: request.accessContextRevision };
  }

  function verification(request: ScopeVerifyRequest, changed: boolean, fingerprint?: string, version?: ContentVersion): ScopeVerification {
    return { scope: request.scope, checkedAt: request.checkedAt, checkComplete: true, changed, fingerprint, version, accessContextRevision: request.accessContextRevision };
  }

  /** 单点信号范围（overview / releases / commits / readme / tree）：重读源信号并与基线摘要比较。 */
  async function verifySignalScope(accessToken: string, request: ScopeVerifyRequest): Promise<ScopeVerification> {
    const base = parseFingerprint(request.baselineFingerprint);
    const prior = typeof base?.d === 'string' ? base.d : null;
    const fingerprintOf = (digest: string): string => JSON.stringify({ v: 1, d: digest });
    try {
      let digest: string;
      let version: ContentVersion;
      if (request.scope === 'overview') {
        const [repo, release, tag, head] = await Promise.all([
          client.request(accessToken, repoPath(request.fullName), (json) => json as RawRepo),
          fetchReleaseRaw(accessToken, request.fullName),
          fetchTagRaw(accessToken, request.fullName),
          request.defaultBranch === null ? Promise.reject(new PortFailure('unknown', '默认分支未知')) : fetchHeadSha(accessToken, request.fullName, request.defaultBranch),
        ]);
        const repoKey = JSON.stringify([repo.full_name, repo.stargazers_count, repo.forks_count, repo.open_issues_count, repo.pushed_at, repo.default_branch]);
        digest = JSON.stringify([repoKey, releaseFingerprint(release ?? { tagName: '', title: '', publishedAt: null }), tagFingerprint(tag), head]);
        version = {
          defaultBranch: request.defaultBranch,
          headRevision: head,
          releaseRevision: release === null ? null : releaseFingerprint(release),
          tagRevision: tagFingerprint(tag),
        };
      } else if (request.scope === 'releases') {
        const [release, tag] = await Promise.all([fetchReleaseRaw(accessToken, request.fullName), fetchTagRaw(accessToken, request.fullName)]);
        digest = JSON.stringify([release === null ? null : releaseFingerprint(release), tagFingerprint(tag)]);
        version = { defaultBranch: request.defaultBranch, headRevision: null, releaseRevision: release === null ? null : releaseFingerprint(release), tagRevision: tagFingerprint(tag) };
      } else if (request.scope === 'readme') {
        if (request.defaultBranch === null) return incompleteVerification(request);
        const entries = await client.request(accessToken, `${repoPath(request.fullName)}/contents?ref=${encodeURIComponent(request.defaultBranch)}`, readmeEntries);
        digest = readmeScopeDigest(entries); // 内容摘要：README 条目与内容 sha
        version = { defaultBranch: request.defaultBranch, headRevision: null, releaseRevision: null, tagRevision: null };
      } else {
        if (request.defaultBranch === null) return incompleteVerification(request);
        if (request.scope === 'tree') {
          const sha = await fetchTreeSha(accessToken, request.fullName, request.defaultBranch);
          digest = JSON.stringify([sha]); // 树根 sha 覆盖整棵树
        } else {
          const head = await fetchHeadSha(accessToken, request.fullName, request.defaultBranch);
          digest = JSON.stringify([head]);
        }
        version = { defaultBranch: request.defaultBranch, headRevision: null, releaseRevision: null, tagRevision: null };
      }
      const fingerprint = fingerprintOf(digest);
      if (prior === null) {
        // 采集初始基线：提供可持久化指纹，但 checkComplete=false，不冒充"已验证旧内容无变化"
        return { ...incompleteVerification(request), fingerprint, version };
      }
      return verification(request, prior !== digest, fingerprint, version);
    } catch {
      return incompleteVerification(request); // 失败不得宣布"已确认无变化"
    }
  }

  /**
   * Issue / PR 列表验证。
   * probe：按更新时间增量探测（带重叠窗口）；probe 只走 Issues 端点（其返回包含 PR 的更新时间）。
   * reread：重读页面对应范围（Issues + Pulls 两个来源），摘要含 PR 专有展示字段（草稿 / 合并 / 分支）。
   */
  async function verifyIssuesAndPr(accessToken: string, request: ScopeVerifyRequest): Promise<ScopeVerification> {
    const base = parseFingerprint(request.baselineFingerprint);
    if (request.mode === 'probe') {
      const upTo = typeof base?.upTo === 'string' ? base.upTo : null;
      const win = Array.isArray(base?.win) ? base.win as Array<[unknown, unknown]> : null;
      if (upTo === null || win === null) return incompleteVerification(request);
      const since = new Date(Date.parse(upTo) - PROBE_OVERLAP_MS).toISOString();
      const known = new Map(win.map(([number, updatedAt]) => [String(number), String(updatedAt)]));
      const seen: RawIssue[] = [];
      let complete = false;
      for (let page = 1; page <= request.maxPages; page += 1) {
        const batch = await fetchIssuesRaw(accessToken, request.fullName, `state=all&sort=updated&direction=desc&per_page=${PAGE_SIZE}&since=${encodeURIComponent(since)}&page=${page}`);
        seen.push(...batch);
        // 已读到的变化不依赖整个区间扫完；但未完成分页仍不能推进检查游标。
        const changed = batch.some((item) => {
          const updatedAt = typeof item.updated_at === 'string' ? item.updated_at : '';
          return updatedAt > upTo || known.get(String(item.number)) !== updatedAt;
        });
        if (changed) return { ...verification(request, true), checkComplete: batch.length < PAGE_SIZE };
        if (batch.length < PAGE_SIZE) { complete = true; break; }
      }
      if (!complete) return incompleteVerification(request); // 预算耗尽且可能还有更多页
      // 未发现变化：推进游标（无结果时用检查开始时间），保留可比的 reread 摘要
      let newUpTo = request.checkedAt;
      for (const item of seen) if (typeof item.updated_at === 'string' && item.updated_at > newUpTo) newUpTo = item.updated_at;
      const newWin = seen
        .filter((item) => Number.isSafeInteger(item.number) && typeof item.updated_at === 'string')
        .filter((item) => Date.parse(item.updated_at as string) >= Date.parse(newUpTo) - PROBE_OVERLAP_MS)
        .map((item) => [item.number as number, item.updated_at as string]);
      const keptReread = typeof base?.reread === 'object' && base.reread !== null ? { reread: base.reread } : {};
      return verification(request, false, JSON.stringify({ v: 1, upTo: newUpTo, win: newWin, ...keptReread }));
    }

    // reread：窗口 = 前 maxPages 页；基线以相同预算建立才可比较，否则本次读取用于采集初始基线
    const prior = typeof base?.reread === 'object' && base.reread !== null ? base.reread as { pages?: unknown; digest?: unknown } : null;
    const comparable = prior !== null && pageOf(prior.pages, -1) === request.maxPages && typeof prior.digest === 'string';
    const issueTuples: unknown[][] = [];
    const pullTuples: unknown[][] = [];
    let issuesDone = false;
    let pullsDone = false;
    try {
      for (let page = 1; page <= request.maxPages && !(issuesDone && pullsDone); page += 1) {
        if (!issuesDone) {
          const batch = await fetchIssuesRaw(accessToken, request.fullName, `state=all&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`);
          for (const item of batch) issueTuples.push([item.number, item.state, item.title, item.updated_at]);
          if (batch.length < PAGE_SIZE) issuesDone = true;
        }
        if (!pullsDone) {
          const batch = await fetchPullsRaw(accessToken, request.fullName, `state=all&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`);
          for (const item of batch) {
            pullTuples.push([item.number, item.state, item.title, item.updated_at, item.draft === true, item.merged_at ?? null, item.head?.ref ?? null, item.base?.ref ?? null]);
          }
          if (batch.length < PAGE_SIZE) pullsDone = true;
        }
      }
    } catch {
      return incompleteVerification(request);
    }
    const digest = JSON.stringify([issueTuples, pullTuples]);
    let newUpTo = request.checkedAt;
    for (const tuple of issueTuples) {
      const updatedAt = tuple[3];
      if (typeof updatedAt === 'string' && updatedAt > newUpTo) newUpTo = updatedAt;
    }
    const newWin = issueTuples
      .filter((tuple) => typeof tuple[3] === 'string' && Date.parse(tuple[3]) >= Date.parse(newUpTo) - PROBE_OVERLAP_MS)
      .map((tuple) => [tuple[0], tuple[3]]);
    const fingerprint = JSON.stringify({ v: 1, upTo: newUpTo, win: newWin, reread: { pages: request.maxPages, digest } });
    if (!comparable) {
      // 采集初始基线：指纹可用，但 checkComplete=false，不冒充"已验证旧内容无变化"
      return { ...incompleteVerification(request), fingerprint };
    }
    if (digest !== prior.digest) return verification(request, true); // 窗口内成员、字段或 PR 专有字段发生变化
    return verification(request, false, fingerprint);
  }

  /**
   * 构建验证：重读近期运行 + 逐个重读已知未完成运行。
   * 结束、重跑（attempt 变化）、状态或结果变化都会改变元组；HEAD 不变不影响该检查。
   * 无基线时读取一次并产出可持久化基线（checkComplete=false，不冒充"已验证无变化"）。
   */
  async function verifyBuilds(accessToken: string, request: ScopeVerifyRequest): Promise<ScopeVerification> {
    const base = parseFingerprint(request.baselineFingerprint);
    const recentBaseline = Array.isArray(base?.recent) ? base.recent as unknown[][] : null;
    const trackedBaseline = Array.isArray(base?.tracked) ? base.tracked as unknown[][] : null;

    const recentRuns = await fetchRunsPage(accessToken, request.fullName, 30, 1);
    const recentTuples = recentRuns.map(runTuple);

    if (recentBaseline === null || trackedBaseline === null) {
      const tracked = recentTuples.filter((tuple) => tuple[2] !== 'completed');
      return { ...incompleteVerification(request), fingerprint: JSON.stringify({ v: 1, recent: recentTuples, tracked }) };
    }

    // 近期窗口按运行 ID 逐条比较：窗口大小不同也能发现新增运行、结束与重跑
    const baselineById = new Map(recentBaseline.map((tuple) => [String(tuple[0]), tuple]));
    const changedByRecent = recentTuples.some((tuple) => {
      const previous = baselineById.get(String(tuple[0]));
      return previous === undefined || !sameJson(previous, tuple);
    });

    const budget = Math.max(0, request.maxPages - 1); // 近期页占 1
    // 兼容已经包含重复运行的旧指纹，每个运行只占一次追踪预算。
    const uniqueTracked = [...new Map(trackedBaseline.map((tuple) => [String(tuple[0]), tuple])).values()];
    const toRead = uniqueTracked.slice(0, budget);
    const unread = uniqueTracked.length - toRead.length;
    const currentTracked: unknown[][] = [];
    let readError = false;
    let changedByTracked = false;
    for (const tuple of toRead) {
      try {
        const run = await fetchRun(accessToken, request.fullName, String(tuple[0]));
        const current = runTuple(run);
        if (!sameJson(current, tuple)) changedByTracked = true; // 变化证据不能冒充所有运行已检查
        if (current[2] !== 'completed') currentTracked.push(current as unknown[]);
      } catch {
        readError = true;
      }
    }
    const changed = changedByRecent || changedByTracked;
    if (unread > 0 || readError) return { ...incompleteVerification(request), changed };
    if (changed) return verification(request, true);

    const freshTracked = recentTuples.filter((tuple) => tuple[2] !== 'completed');
    const tracked = [...new Map([...freshTracked, ...currentTracked].map((tuple) => [String(tuple[0]), tuple])).values()];
    return verification(request, false, JSON.stringify({ v: 1, recent: recentTuples, tracked }));
  }

  return {
    getLatestRelease(accessToken: string, fullName: string): Promise<ReleaseItem | null> {
      return client.request(accessToken, `${repoPath(fullName)}/releases/latest`, (json) => toReleaseItem(json as RawRelease), () => null);
    },
    listReleases(accessToken: string, fullName: string): Promise<ReleaseItem[]> {
      return client.request(accessToken, `${repoPath(fullName)}/releases?per_page=30`, (json) => arrayOf<RawRelease>(json).map(toReleaseItem));
    },
    listCommits(accessToken: string, fullName: string): Promise<CommitItem[]> {
      return client.request(accessToken, `${repoPath(fullName)}/commits?per_page=30`, mapCommits);
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
        return mapRuns(json).map((run) => ({ ...toBuildInfo(run), id: null }));
      });
    },
    listReadmes(accessToken: string, fullName: string): Promise<ReadmeDocument[]> {
      return client.request(accessToken, `${repoPath(fullName)}/contents`, mapReadmes);
    },
    listTree(accessToken: string, fullName: string): Promise<TreeEntry[]> {
      return client.request(accessToken, `${repoPath(fullName)}/git/trees/HEAD?recursive=1`, mapTree);
    },
    getCollaborationActivity(accessToken: string, fullName: string): Promise<string | null> {
      return client.request(accessToken, `${repoPath(fullName)}/issues?state=all&sort=updated&direction=desc&per_page=1`, (json) => {
        const first = arrayOf<RawIssue>(json)[0];
        return first && typeof first.updated_at === 'string' ? first.updated_at : null;
      });
    },

    // —— 范围验证与范围抓取（步骤 4） ——

    async verifyScopes(accessToken: string, request: ScopeVerifyRequest): Promise<ScopeVerification> {
      switch (request.scope) {
        case 'issuesAndPr': return verifyIssuesAndPr(accessToken, request);
        case 'builds': return verifyBuilds(accessToken, request);
        case 'overview':
        case 'releases':
        case 'commits':
        case 'readme':
        case 'tree':
          return verifySignalScope(accessToken, request);
        case 'trends':
          throw new PortFailure('unknown', '趋势为本地快照范围，不请求 GitHub');
      }
    },

    async fetchScope(accessToken: string, request: ScopeFetchRequest): Promise<ScopeFetchOutcome> {
      const { fullName, scope, limit, accessContextRevision, observedAt } = request;
      const cursor = parseCursor(request.cursor);
      const perPage = effectiveLimit(limit);
      switch (scope) {
        case 'issuesAndPr': {
          const versioned = cursor.v === 2;
          const issuePage = versioned && cursor.i === null ? null : pageOf(cursor.i);
          const pullPage = versioned && cursor.p === null ? null : pageOf(cursor.p);
          const offset = pageOf(cursor.off, 0);
          let issues: RawIssue[] = [];
          let issuesError: unknown = null;
          if (issuePage !== null) {
            try { issues = await fetchIssuesRaw(accessToken, fullName, `state=all&sort=updated&direction=desc&per_page=${perPage}&page=${issuePage}`); } catch (error) { issuesError = error; }
          }
          let pulls: RawPull[] = [];
          let pullsError: unknown = null;
          if (pullPage !== null) {
            try { pulls = await fetchPullsRaw(accessToken, fullName, `state=all&sort=updated&direction=desc&per_page=${perPage}&page=${pullPage}`); } catch (error) { pullsError = error; }
          }
          const attempted = (issuePage !== null ? 1 : 0) + (pullPage !== null ? 1 : 0);
          const succeeded = (issuePage !== null && issuesError === null ? 1 : 0) + (pullPage !== null && pullsError === null ? 1 : 0);
          if (attempted > 0 && succeeded === 0) throw issuesError ?? pullsError;

          const merged = new Map<number, IssueOrPullRequest>();
          for (const item of issues) if (Number.isSafeInteger(item.number)) merged.set(item.number as number, toIssue(item));
          for (const item of pulls) if (Number.isSafeInteger(item.number)) merged.set(item.number as number, toPull(item));
          const ordered = [...merged.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

          // 有界输出：单次最多 limit 条；窗口内剩余用 off 续读，不跳过任何条目
          const windowItems = ordered.slice(offset, offset + Math.max(1, limit));
          const consumed = offset + windowItems.length;
          const windowRemaining = consumed < ordered.length;
          const issuesMore = issuePage !== null && issuesError === null && issues.length === perPage;
          const pullsMore = pullPage !== null && pullsError === null && pulls.length === perPage;
          const nextIssues = issuePage === null ? null : issuesError !== null ? issuePage : issuesMore ? issuePage + 1 : null;
          const nextPulls = pullPage === null ? null : pullsError !== null ? pullPage : pullsMore ? pullPage + 1 : null;
          const nextCursor = windowRemaining
            ? JSON.stringify({ v: 2, i: issuePage, p: pullPage, off: consumed })
            : nextIssues !== null || nextPulls !== null
              ? JSON.stringify({ v: 2, i: nextIssues, p: nextPulls, off: 0 })
              : null;
          const partial = issuesError !== null || pullsError !== null;

          // 采集基线：只在窗口起点、两个来源都成功时提供（feature 原样保存，不代表"已验证无变化"）
          let fingerprint: string | undefined;
          if (issuePage === 1 && pullPage === 1 && !partial) {
            let upTo = observedAt;
            for (const item of ordered) if (item.updatedAt > upTo) upTo = item.updatedAt;
            const win = ordered.filter((item) => Date.parse(item.updatedAt) >= Date.parse(upTo) - PROBE_OVERLAP_MS).map((item) => [item.number, item.updatedAt]);
            fingerprint = JSON.stringify({ v: 1, upTo, win });
          }

          return {
            scope, items: windowItems,
            hasMore: windowRemaining || issuesMore || pullsMore || partial,
            nextCursor,
            coverageComplete: !partial && !windowRemaining,
            observedAt, accessContextRevision, fingerprint,
            parts: {
              issues: {
                ok: issuesError === null,
                hasMore: issuesMore,
                nextCursor: issuesError !== null ? String(issuePage) : issuesMore ? String(issuePage! + 1) : null,
              },
              pullRequests: {
                ok: pullsError === null,
                hasMore: pullsMore,
                nextCursor: pullsError !== null ? String(pullPage) : pullsMore ? String(pullPage! + 1) : null,
              },
            },
          };
        }
        case 'builds': {
          const page = pageOf(cursor.p);
          const runs = await fetchRunsPage(accessToken, fullName, perPage, page);
          const items: BuildItem[] = runs.map((run) => ({ ...toBuildInfo(run), id: typeof run.id === 'number' || typeof run.id === 'string' ? String(run.id) : null }));
          const tuples = runs.map(runTuple);
          const hasMore = runs.length === perPage;
          return {
            scope, items, hasMore,
            nextCursor: hasMore ? JSON.stringify({ v: 2, p: page + 1 }) : null,
            coverageComplete: true, observedAt, accessContextRevision,
            // 首页采集即基线：保留 attempt / status / conclusion 源字段，feature 原样保存
            fingerprint: page === 1 ? JSON.stringify({ v: 1, recent: tuples, tracked: tuples.filter((tuple) => tuple[2] !== 'completed') }) : undefined,
          };
        }
        case 'commits': {
          const branch = request.defaultBranch ?? null;
          // 查询身份随游标保存：分支变化视为新查询，从第一页重新开始
          const identityMatches = cursor.v !== 2 || (typeof cursor.b === 'string' || cursor.b === null) && cursor.b === branch;
          const page = identityMatches ? pageOf(cursor.p, pageOf(cursor.page)) : 1;
          const items = await client.request(accessToken, `${repoPath(fullName)}/commits?per_page=${perPage}&page=${page}${branch ? `&sha=${encodeURIComponent(branch)}` : ''}`, mapCommits);
          const hasMore = items.length === perPage;
          return {
            scope, items, hasMore,
            nextCursor: hasMore ? JSON.stringify({ v: 2, p: page + 1, b: branch }) : null,
            coverageComplete: true, observedAt, accessContextRevision,
            version: page === 1 ? { defaultBranch: branch, headRevision: items[0]?.sha ?? null, releaseRevision: null, tagRevision: null } : undefined,
            fingerprint: page === 1 ? JSON.stringify({ v: 1, d: JSON.stringify([items[0]?.sha ?? null]) }) : undefined,
          };
        }
        case 'releases': {
          const versioned = cursor.v === 2;
          const releasePage = versioned && cursor.r === null ? null : pageOf(cursor.r);
          const tagPage = versioned && cursor.t === null ? null : pageOf(cursor.t);
          let releases: ReleaseItem[] = [];
          let releasesError: unknown = null;
          if (releasePage !== null) {
            try { releases = await client.request(accessToken, `${repoPath(fullName)}/releases?per_page=${perPage}&page=${releasePage}`, (json) => arrayOf<RawRelease>(json).map(toReleaseItem)); } catch (error) { releasesError = error; }
          }
          let tags: Array<{ name: string; commitSha: string | null }> = [];
          let tagsError: unknown = null;
          if (tagPage !== null) {
            try { tags = await fetchTagsPage(accessToken, fullName, perPage, tagPage); } catch (error) { tagsError = error; }
          }
          const attempted = (releasePage !== null ? 1 : 0) + (tagPage !== null ? 1 : 0);
          const succeeded = (releasePage !== null && releasesError === null ? 1 : 0) + (tagPage !== null && tagsError === null ? 1 : 0);
          if (attempted > 0 && succeeded === 0) throw releasesError ?? tagsError;

          // 两个栏目可区分：Release 与 Tag 各自带 kind 标记
          const items = [
            ...releases.map((release) => ({ kind: 'release' as const, ...release })),
            ...tags.map((tag) => ({ kind: 'tag' as const, name: tag.name, committedAt: null as string | null })),
          ];
          const releasesMore = releasePage !== null && releasesError === null && releases.length === perPage;
          const tagsMore = tagPage !== null && tagsError === null && tags.length === perPage;
          const nextReleasePage = releasePage === null ? null : releasesError !== null ? releasePage : releasesMore ? releasePage + 1 : null;
          const nextTagPage = tagPage === null ? null : tagsError !== null ? tagPage : tagsMore ? tagPage + 1 : null;
          const fresh = releasePage === 1 && tagPage === 1;
          const partial = releasesError !== null || tagsError !== null;
          const releaseFp = releases[0] ? releaseFingerprint(releases[0]) : null;
          const tagFp = tags[0] ? JSON.stringify([tags[0].name, tags[0].commitSha]) : null;
          return {
            scope, items,
            hasMore: releasesMore || tagsMore || partial,
            nextCursor: nextReleasePage !== null || nextTagPage !== null
              ? JSON.stringify({ v: 2, r: nextReleasePage, t: nextTagPage })
              : null,
            coverageComplete: !partial, observedAt, accessContextRevision,
            version: fresh
              ? { defaultBranch: request.defaultBranch, headRevision: null, releaseRevision: releaseFp, tagRevision: tagFp }
              : undefined,
            fingerprint: fresh && !partial ? JSON.stringify({ v: 1, d: JSON.stringify([releaseFp, tagFp]) }) : undefined,
            parts: {
              releases: { ok: releasesError === null, hasMore: releasesMore, nextCursor: nextReleasePage !== null && releasesError !== null ? String(nextReleasePage) : releasesMore ? String(releasePage! + 1) : null, fingerprint: fresh && releasesError === null ? releaseFp ?? undefined : undefined },
              tags: { ok: tagsError === null, hasMore: tagsMore, nextCursor: nextTagPage !== null && tagsError !== null ? String(nextTagPage) : tagsMore ? String(tagPage! + 1) : null, fingerprint: fresh && tagsError === null ? tagFp ?? undefined : undefined },
            },
          };
        }
        case 'readme': {
          const branchQuery = request.defaultBranch ? `?ref=${encodeURIComponent(request.defaultBranch)}` : '';
          const entries = await client.request(accessToken, `${repoPath(fullName)}/contents${branchQuery}`, readmeEntries);
          const offset = pageOf(cursor.off, 0);
          const items = entries.slice(offset, offset + perPage).map(toReadmeDocument);
          const consumed = offset + items.length;
          const hasMore = consumed < entries.length;
          return {
            scope, items, hasMore,
            nextCursor: hasMore ? JSON.stringify({ v: 2, off: consumed }) : null,
            coverageComplete: true, observedAt, accessContextRevision,
            fingerprint: offset === 0 ? JSON.stringify({ v: 1, d: readmeScopeDigest(entries) }) : undefined,
          };
        }
        case 'tree': {
          const branch = request.defaultBranch ?? 'HEAD';
          const result = await client.request(accessToken, `${repoPath(fullName)}/git/trees/${encodeURIComponent(branch)}?recursive=1`, (json) => ({
            entries: mapTree(json),
            sha: typeof (json as { sha?: unknown }).sha === 'string' ? (json as { sha: string }).sha : null,
            truncated: typeof json === 'object' && json !== null && (json as { truncated?: unknown }).truncated === true,
          }));
          const offset = pageOf(cursor.off, 0);
          const items = result.entries.slice(offset, offset + perPage);
          const consumed = offset + items.length;
          const hasMore = result.truncated || consumed < result.entries.length;
          return {
            scope, items, hasMore,
            nextCursor: hasMore ? JSON.stringify({ v: 2, off: consumed }) : null,
            coverageComplete: !result.truncated && consumed >= result.entries.length,
            observedAt, accessContextRevision,
            fingerprint: offset === 0 && !result.truncated && result.sha !== null ? JSON.stringify({ v: 1, d: JSON.stringify([result.sha]) }) : undefined,
          };
        }
        case 'overview': {
          const repo = await client.request(accessToken, repoPath(fullName), (json) => json as RawRepo);
          const settled = await Promise.allSettled([
            fetchReleaseRaw(accessToken, fullName),
            fetchTagRaw(accessToken, fullName),
            request.defaultBranch === null ? Promise.reject(new PortFailure('unknown', '默认分支未知')) : fetchHeadSha(accessToken, fullName, request.defaultBranch),
          ]);
          const release = settled[0].status === 'fulfilled' ? settled[0].value : null;
          const tag = settled[1].status === 'fulfilled' ? settled[1].value : null;
          const head = settled[2].status === 'fulfilled' ? settled[2].value : null;
          const partial = settled.some((entry) => entry.status === 'rejected');
          const values: GlanceValues = {
            stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
            forks: typeof repo.forks_count === 'number' ? repo.forks_count : 0,
            openIssues: typeof repo.open_issues_count === 'number' ? repo.open_issues_count : 0,
            pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null,
            latestReleaseTag: release?.tagName ?? tag?.name ?? null,
            latestTag: tag?.name ?? null,
            collaborationAt: null,
            status: 'active',
          };
          const metadata: RepositoryMetadata = {
            description: typeof repo.description === 'string' ? repo.description : null,
            homepage: typeof repo.homepage === 'string' ? repo.homepage : null,
            license: repo.license && typeof repo.license.spdx_id === 'string' ? repo.license.spdx_id : null,
            defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
          };
          const version: ContentVersion = {
            defaultBranch: metadata.defaultBranch,
            headRevision: head,
            releaseRevision: release === null ? null : releaseFingerprint(release),
            tagRevision: tagFingerprint(tag),
          };
          const repoKey = JSON.stringify([repo.full_name, repo.stargazers_count, repo.forks_count, repo.open_issues_count, repo.pushed_at, repo.default_branch]);
          const digest = JSON.stringify([repoKey, releaseFingerprint(release ?? { tagName: '', title: '', publishedAt: null }), tagFingerprint(tag), head]);
          const items: OverviewContent[] = [{ values, metadata }];
          return {
            scope, items, hasMore: false, nextCursor: null,
            coverageComplete: !partial, observedAt, accessContextRevision, version,
            // 部分信号失败时不提供基线指纹：采集不完整不冒充完整覆盖
            fingerprint: partial ? undefined : JSON.stringify({ v: 1, d: digest }),
          };
        }
        case 'trends':
          throw new PortFailure('unknown', '趋势为本地快照范围，不请求 GitHub');
      }
    },
  };
}
