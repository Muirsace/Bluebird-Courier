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
import { mapGitHubError, type GitHubHttpClient } from './github-http-client';
import { encodedBranch, releaseFingerprint } from './github-repository-adapter';
import { repositoryCapabilities } from './github-capabilities';

interface RawRelease { tag_name?: unknown; name?: unknown; published_at?: unknown }
interface RawCommit { sha?: unknown; commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } | null; committer?: { date?: unknown } | null } }
interface RawIssue { number?: unknown; title?: unknown; body?: unknown; state?: unknown; user?: { login?: unknown } | null; updated_at?: unknown; pull_request?: unknown }
interface RawPull { number?: unknown; title?: unknown; body?: unknown; state?: unknown; user?: { login?: unknown } | null; updated_at?: unknown; draft?: unknown; merged_at?: unknown; head?: { ref?: unknown } | null; base?: { ref?: unknown } | null }
interface RawWorkflowRun { id?: unknown; run_attempt?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown; updated_at?: unknown }
interface RawRepo { has_issues?: unknown; has_pull_requests?: unknown; archived?: unknown; disabled?: unknown; full_name?: unknown; stargazers_count?: unknown; forks_count?: unknown; open_issues_count?: unknown; pushed_at?: unknown; default_branch?: unknown; description?: unknown; homepage?: unknown; license?: { spdx_id?: unknown } | null }

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

/** 实际已取得的稳定发版也参与交付，避免预发布挤出窗口导致永久欠同步。 */
function withStableRelease(releases: ReleaseItem[], stable: ReleaseItem | null): ReleaseItem[] {
  if (stable === null || releases.some(release => releaseFingerprint(release) === releaseFingerprint(stable))) return releases;
  return [stable, ...releases.filter(release => release.tagName !== stable.tagName)];
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
  return { ...issue, kind: 'pull',
    ...(typeof item.draft === 'boolean' ? { draft: item.draft } : {}),
    ...(item.merged_at === null || typeof item.merged_at === 'string' ? { mergedAt: item.merged_at } : {}),
    ...(typeof item.head?.ref === 'string' ? { headBranch: item.head.ref } : {}),
    ...(typeof item.base?.ref === 'string' ? { baseBranch: item.base.ref } : {}),
  };
}

function issueTuple(item: RawIssue): unknown[] {
  const value = toIssue(item);
  return [value.number, value.state, value.title, value.updatedAt, value.body, value.authorName];
}

function pullTuple(item: RawPull): unknown[] {
  const value = toPull(item);
  return [value.number, value.state, value.title, value.updatedAt, value.draft === true, value.mergedAt ?? null, value.headBranch ?? null, value.baseBranch ?? null, value.body, value.authorName];
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
  return arrayOf<RawWorkflowRun>(runs).map(run => { runTuple(run); return run; });
}

const RUN_STATUSES = new Set(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending', 'action_required']);
const RUN_CONCLUSIONS = new Set(['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required', 'stale', 'skipped', 'startup_failure']);
const runId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);

/** 持久摘要逐字段校验；四元组只用于安全迁移，不能冒充已核验展示字段。 */
function readRunTuples(value: unknown, legacy = true): unknown[][] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(tuple => Array.isArray(tuple) && (tuple.length === 7 || legacy && tuple.length === 4) && runId(tuple[0]) &&
    Number.isSafeInteger(tuple[1]) && tuple[1] > 0 && typeof tuple[2] === 'string' && RUN_STATUSES.has(tuple[2]) &&
    (tuple[3] === null || typeof tuple[3] === 'string' && RUN_CONCLUSIONS.has(tuple[3])) &&
    tuple.slice(4).every(field => field === null || typeof field === 'string'))) return null;
  const unique = new Map<string, unknown[]>();
  for (const tuple of value as unknown[][]) {
    const id = String(tuple[0]); const prior = unique.get(id);
    if (prior !== undefined && !sameJson(prior, tuple)) return null;
    unique.set(id, tuple);
  }
  return [...unique.values()];
}

/** 损坏或跨身份进度整轮丢弃，不能让不合法 observed 跳过真实补查。 */
function readBuildProgress(value: Record<string, unknown> | null, key: string, request: { fullName: string; defaultBranch: string | null; accessContextRevision: number }, tracked: Map<string, unknown[]>): { pending: string[]; observed: unknown[][]; changed: boolean } | null {
  if (value?.v !== 1 || value.k !== key || value.n !== request.fullName || value.b !== request.defaultBranch || value.a !== request.accessContextRevision ||
    !Array.isArray(value.pending) || value.changed !== undefined && typeof value.changed !== 'boolean') return null;
  const observed = readRunTuples(value.observed, false);
  if (observed === null || observed.some(tuple => !tracked.has(String(tuple[0]))) || !value.pending.every(id => runId(id) && tracked.has(id))) return null;
  const seen = new Set(observed.map(tuple => String(tuple[0])));
  if (value.pending.some(id => seen.has(String(id)))) return null;
  return { pending: [...new Set(value.pending as string[])], observed, changed: value.changed === true };
}

/** 构建摘要同时覆盖协议状态与页面实际展示的名称、链接、时间。 */
function runTuple(run: RawWorkflowRun): unknown[] {
  if (typeof run !== 'object' || run === null) throw new TypeError('构建响应格式无效');
  if (typeof run.id === 'number' && !Number.isSafeInteger(run.id) || run.run_attempt !== undefined && (!Number.isSafeInteger(run.run_attempt) || Number(run.run_attempt) < 1) || run.conclusion !== undefined && run.conclusion !== null && typeof run.conclusion !== 'string') throw new TypeError('构建响应字段无效');
  const tuple = [
    String(run.id ?? ''),
    Number.isSafeInteger(run.run_attempt) ? run.run_attempt as number : 1,
    typeof run.status === 'string' ? run.status : 'unknown',
    typeof run.conclusion === 'string' ? run.conclusion : null,
    typeof run.name === 'string' ? run.name : null,
    typeof run.html_url === 'string' ? run.html_url : null,
    typeof run.updated_at === 'string' ? run.updated_at : null,
  ];
  if (readRunTuples([tuple], false) === null) throw new TypeError('构建响应字段无效');
  return tuple;
}

/** 续扫只持久化实际展示所需字段；交付时恢复平台映射输入。 */
function runFromTuple(tuple: unknown[]): RawWorkflowRun {
  return { id: tuple[0], run_attempt: tuple[1], status: tuple[2], conclusion: tuple[3], name: tuple[4], html_url: tuple[5], updated_at: tuple[6] };
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

/** 窗口游标只保存摘要，避免把完整列表再次放入游标。 */
async function windowDigest(items: readonly unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(items));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 概览内容字段的统一摘要；摘要指标与推送线索由 Summary 独立更新。 */
function overviewRepoDigest(repo: RawRepo): string {
  return JSON.stringify([repo.full_name, repo.default_branch, repo.description, repo.homepage, repo.license?.spdx_id ?? null, repositoryCapabilities(repo)]);
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
      runTuple(json as RawWorkflowRun);
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

  function fetchReleasesPage(accessToken: string, fullName: string, perPage: number, page: number): Promise<ReleaseItem[]> {
    return client.request(accessToken, `${repoPath(fullName)}/releases?per_page=${perPage}&page=${page}`, (json) => arrayOf<RawRelease>(json).map(toReleaseItem));
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

  function verification(request: ScopeVerifyRequest, changed: boolean, fingerprint?: string, version?: Partial<ContentVersion>): ScopeVerification {
    return { scope: request.scope, checkedAt: request.checkedAt, checkComplete: true, changed, fingerprint, version, accessContextRevision: request.accessContextRevision };
  }

  /** 单点信号范围（overview / releases / commits / readme / tree）：重读源信号并与基线摘要比较。 */
  async function verifySignalScope(accessToken: string, request: ScopeVerifyRequest): Promise<ScopeVerification> {
    const base = parseFingerprint(request.baselineFingerprint);
    const prior = typeof base?.d === 'string' ? base.d : null;
    const fingerprintOf = (digest: string): string => JSON.stringify({ v: 1, d: digest });
    try {
      let digest: string;
      let version: Partial<ContentVersion>;
      if (request.scope === 'overview') {
        const repo = await client.request(accessToken, repoPath(request.fullName), (json) => json as RawRepo);
        const branch = typeof repo.default_branch === 'string' ? repo.default_branch : request.defaultBranch;
        const [release, tag, head] = await Promise.all([
          fetchReleaseRaw(accessToken, request.fullName), fetchTagRaw(accessToken, request.fullName),
          branch === null ? Promise.reject(new PortFailure('unknown', '默认分支未知')) : fetchHeadSha(accessToken, request.fullName, branch),
        ]);
        const repoKey = overviewRepoDigest(repo);
        digest = JSON.stringify([repoKey, releaseFingerprint(release ?? { tagName: '', title: '', publishedAt: null }), tagFingerprint(tag), head]);
        version = {
          defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : request.defaultBranch,
          headRevision: head,
          releaseRevision: release === null ? null : releaseFingerprint(release),
          tagRevision: tagFingerprint(tag),
        };
      } else if (request.scope === 'releases') {
        const windowSize = effectiveLimit(pageOf(base?.perPage, 30));
        const [releases, tags] = await Promise.all([fetchReleasesPage(accessToken, request.fullName, windowSize, 1), fetchTagsPage(accessToken, request.fullName, windowSize, 1)]);
        // 最新稳定发版与列表首条（可能是预发布）不是同一个信号。
        const release = await fetchReleaseRaw(accessToken, request.fullName);
        digest = JSON.stringify([JSON.stringify(withStableRelease(releases, release).map(releaseFingerprint)), JSON.stringify(tags.map(tagFingerprint))]);
        const tag = tags[0] ?? null;
        version = { releaseRevision: release === null ? null : releaseFingerprint(release), tagRevision: tagFingerprint(tag) };
      } else if (request.scope === 'readme') {
        if (request.defaultBranch === null) return incompleteVerification(request);
        const entries = await client.request(accessToken, `${repoPath(request.fullName)}/contents?ref=${encodeURIComponent(request.defaultBranch)}`, readmeEntries);
        digest = readmeScopeDigest(entries); // 内容摘要：README 条目与内容 sha
        version = { defaultBranch: request.defaultBranch };
      } else {
        if (request.defaultBranch === null) return incompleteVerification(request);
        let headRevision: string | null = null;
        if (request.scope === 'tree') {
          const sha = await fetchTreeSha(accessToken, request.fullName, request.defaultBranch);
          digest = JSON.stringify([sha]); // 树根 sha 覆盖整棵树
        } else {
          const head = await fetchHeadSha(accessToken, request.fullName, request.defaultBranch);
          headRevision = head;
          digest = JSON.stringify([head]);
        }
        version = { defaultBranch: request.defaultBranch, ...(request.scope === 'commits' ? { headRevision } : {}) };
      }
      const fingerprint = request.scope === 'releases'
        ? JSON.stringify({ v: 1, perPage: effectiveLimit(pageOf(base?.perPage, 30)), d: digest })
        : fingerprintOf(digest);
      if (prior === null) {
        // 采集初始基线：提供可持久化指纹，但 checkComplete=false，不冒充"已验证旧内容无变化"
        return { ...incompleteVerification(request), fingerprint, version };
      }
      return verification(request, prior !== digest, fingerprint, version);
    } catch (error) {
      const mapped = mapGitHubError(error);
      return { ...incompleteVerification(request), error: { kind: mapped.kind, message: mapped.message, ...(mapped.resetAt ? { resetAt: mapped.resetAt } : {}) } };
    }
  }

  /**
   * Issue / PR 列表验证。
   * probe：按更新时间增量探测（带重叠窗口）；probe 只走 Issues 端点（其返回包含 PR 的更新时间）。
   * reread：重读页面对应范围（Issues + Pulls 两个来源），摘要含 PR 专有展示字段（草稿 / 合并 / 分支）。
   */
  async function verifyIssuesAndPr(accessToken: string, request: ScopeVerifyRequest): Promise<ScopeVerification> {
    const base = parseFingerprint(request.baselineFingerprint);
    const issuesDisabled = request.capabilities?.issues === 'disabled';
    const pullsDisabled = request.capabilities?.pullRequests === 'disabled';
    let sourceBudget = request.maxPages;
    if (issuesDisabled || pullsDisabled) {
      // 持久能力可能已复开；只有验证旧禁用状态时重查元信息，完整抓取不重复读取。
      try {
        const current = await client.request(accessToken, repoPath(request.fullName), json => repositoryCapabilities(json as RawRepo));
        sourceBudget -= 1;
        if (!sameJson(current, request.capabilities)) return { ...incompleteVerification(request), changed: true };
      } catch (error) {
        const mapped = mapGitHubError(error);
        return { ...incompleteVerification(request), error: { kind: mapped.kind, message: mapped.message, ...(mapped.resetAt ? { resetAt: mapped.resetAt } : {}) } };
      }
      if (issuesDisabled && pullsDisabled) {
        const digest = JSON.stringify(['disabled', 'disabled']);
        const prior = base?.reread as { digest?: unknown } | undefined;
        return prior?.digest === digest ? verification(request, false, request.baselineFingerprint ?? undefined) : { ...incompleteVerification(request), changed: true };
      }
      if (sourceBudget < 1) return incompleteVerification(request);
    }
    if (request.mode === 'probe' && !issuesDisabled && !pullsDisabled) {
      const upTo = typeof base?.upTo === 'string' ? base.upTo : null;
      const win = Array.isArray(base?.win) ? base.win as Array<[unknown, unknown]> : null;
      if (upTo === null || win === null) {
        // 没有增量基线时先采集双来源窗口，仍不宣称验证了旧缓存。
        return verifyIssuesAndPr(accessToken, { ...request, mode: 'reread', baselineFingerprint: null });
      }
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
    const sizedWindow = prior !== null && typeof (prior as { perPage?: unknown }).perPage === 'number';
    const windowSize = sizedWindow ? effectiveLimit((prior as { perPage: number }).perPage) : PAGE_SIZE;
    const windowPages = sizedWindow ? pageOf(prior.pages, request.maxPages) : request.maxPages;
    const scanPages = Math.min(windowPages, sourceBudget);
    const comparable = prior !== null && scanPages === windowPages && (sizedWindow || pageOf(prior.pages, -1) === request.maxPages) && typeof prior.digest === 'string';
    const issueTuples: unknown[][] = [];
    const pullTuples: unknown[][] = [];
    let issuesDone = issuesDisabled;
    let pullsDone = pullsDisabled;
    try {
      for (let page = 1; page <= scanPages && !(issuesDone && pullsDone); page += 1) {
        if (!issuesDone) {
          const batch = await fetchIssuesRaw(accessToken, request.fullName, `state=all&sort=updated&direction=desc&per_page=${windowSize}&page=${page}`);
          for (const item of batch) issueTuples.push(issueTuple(item));
          if (batch.length < windowSize) issuesDone = true;
        }
        if (!pullsDone) {
          const batch = await fetchPullsRaw(accessToken, request.fullName, `state=all&sort=updated&direction=desc&per_page=${windowSize}&page=${page}`);
          for (const item of batch) pullTuples.push(pullTuple(item));
          if (batch.length < windowSize) pullsDone = true;
        }
      }
    } catch (error) {
      const mapped = mapGitHubError(error);
      return { ...incompleteVerification(request), error: { kind: mapped.kind, message: mapped.message, ...(mapped.resetAt ? { resetAt: mapped.resetAt } : {}) } };
    }
    const digest = JSON.stringify([issuesDisabled ? 'disabled' : issueTuples, pullsDisabled ? 'disabled' : pullTuples]);
    let newUpTo = request.checkedAt;
    for (const tuple of issueTuples) {
      const updatedAt = tuple[3];
      if (typeof updatedAt === 'string' && updatedAt > newUpTo) newUpTo = updatedAt;
    }
    const newWin = issueTuples
      .filter((tuple) => typeof tuple[3] === 'string' && Date.parse(tuple[3]) >= Date.parse(newUpTo) - PROBE_OVERLAP_MS)
      .map((tuple) => [tuple[0], tuple[3]]);
    const fingerprint = JSON.stringify({ v: 1, upTo: newUpTo, win: newWin, reread: { pages: scanPages, perPage: windowSize, digest } });
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
    const recentBaseline = readRunTuples(base?.recent);
    const trackedBaseline = readRunTuples(base?.tracked);

    // 使用采集时的窗口大小，不能把扩大窗口后读到的旧运行当作新增。
    const windowSize = typeof base?.windowSize === 'number' ? effectiveLimit(base.windowSize) : Math.max(30, Math.min(100, recentBaseline?.length ?? 30));
    const key = await windowDigest([request.fullName, request.defaultBranch, request.accessContextRevision, request.baselineFingerprint]);
    const trackedById = new Map((trackedBaseline ?? []).map(tuple => [String(tuple[0]), tuple]));
    const progress = readBuildProgress(parseFingerprint(request.verificationProgress ?? null), key, request, trackedById);
    const validProgress = progress !== null;
    const changedByProgress = validProgress && (progress.changed || progress.observed.some(tuple => !sameJson(trackedById.get(String(tuple[0])), tuple)));
    let recentRuns: RawWorkflowRun[];
    try { recentRuns = await fetchRunsPage(accessToken, request.fullName, windowSize, 1); }
    catch (error) {
      const mapped = mapGitHubError(error);
      return { ...incompleteVerification(request), changed: changedByProgress,
        ...(validProgress ? { verificationProgress: request.verificationProgress } : {}),
        error: { kind: mapped.kind, message: mapped.message, ...(mapped.resetAt ? { resetAt: mapped.resetAt } : {}) } };
    }
    const recentTuples = recentRuns.map(runTuple);
    if (recentBaseline === null || trackedBaseline === null) {
      const tracked = recentTuples.filter((tuple) => tuple[2] !== 'completed');
      return { ...incompleteVerification(request), verificationProgress: null, fingerprint: JSON.stringify({ v: 2, windowSize, recent: recentTuples, tracked }) };
    }

    const baselineById = new Map(recentBaseline.map((tuple) => [String(tuple[0]), tuple]));
    const currentIds = new Set(recentTuples.map((tuple) => String(tuple[0])));
    const removed = recentTuples.length < windowSize && recentBaseline.some((tuple) => !currentIds.has(String(tuple[0])));
    // 旧四元组缺少展示证据，保守产生变化，抓取后升级基线而不是宣布 fresh。
    let changed = changedByProgress || removed || recentBaseline.some(tuple => tuple.length < 7) || trackedBaseline.some(tuple => tuple.length < 7) || recentTuples.some(tuple => !sameJson(baselineById.get(String(tuple[0])), tuple));
    const observed = new Map<string, unknown[]>(validProgress
      ? progress.observed.map(tuple => [String(tuple[0]), tuple])
      : []);
    // 成功记录移出本轮队列；失败记录移到队尾，避免一直失败的前排饿死后排。
    const pending = validProgress
      ? [...progress.pending]
      : [...trackedById.keys()];
    for (const id of trackedById.keys()) if (!observed.has(id) && !pending.includes(id)) pending.push(id);
    const toRead = pending.splice(0, Math.max(0, request.maxPages - 1));
    let readError: import('../../../domain/types').NormalizedError | undefined;
    for (let index = 0; index < toRead.length; index += 1) {
      const id = toRead[index]!;
      try {
        const current = runTuple(await fetchRun(accessToken, request.fullName, id));
        if (String(current[0]) !== id) throw new TypeError('构建响应标识不匹配');
        if (!sameJson(current, trackedById.get(id))) changed = true;
        observed.set(id, current);
      } catch (error) {
        const mapped = mapGitHubError(error);
        readError ??= { kind: mapped.kind, message: mapped.message, ...(mapped.resetAt ? { resetAt: mapped.resetAt } : {}) };
        pending.push(id);
        if (mapped.kind === 'access_token_invalid' || mapped.kind === 'rate_limited') {
          pending.push(...toRead.slice(index + 1));
          break;
        }
      }
    }
    const verificationProgress = JSON.stringify({ v: 1, n: request.fullName, b: request.defaultBranch, a: request.accessContextRevision, k: key, pending, observed: [...observed.values()], changed });
    if (pending.length > 0 || readError) return { ...incompleteVerification(request), changed,
      verificationProgress,
      ...(readError ? { error: readError } : {}) };
    if (changed) return { ...verification(request, true), verificationProgress };
    const tracked = [...new Map([...recentTuples, ...observed.values()].filter(tuple => tuple[2] !== 'completed').map(tuple => [String(tuple[0]), tuple])).values()];
    return { ...verification(request, false, JSON.stringify({ v: 2, windowSize, recent: recentTuples, tracked })), verificationProgress: null };
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
      if (!Number.isSafeInteger(request.maxPages) || request.maxPages < 1) return incompleteVerification(request);
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
      if (!Number.isSafeInteger(limit) || limit < 1) throw new PortFailure('unknown', '范围读取上限必须为正整数');
      const perPage = effectiveLimit(limit);
      let cursor = parseCursor(request.cursor);
      const sourceRef = request.targetVersion?.headRevision ?? request.defaultBranch;
      // 分页参数改变就是新查询；旧 offset / page 不得应用到另一个窗口。
      if (cursor.v === 2 && (cursor.l !== undefined && cursor.l !== perPage || cursor.b !== undefined && cursor.b !== request.defaultBranch || cursor.a !== undefined && cursor.a !== accessContextRevision || cursor.n !== undefined && cursor.n !== fullName || cursor.ref !== undefined && cursor.ref !== sourceRef || request.targetVersion?.headRevision && cursor.ref !== sourceRef || cursor.cap !== undefined && cursor.cap !== JSON.stringify(request.capabilities))) cursor = {};
      const makeCursor = (value: Record<string, unknown>): string => JSON.stringify({ v: 2, l: perPage, b: request.defaultBranch, a: accessContextRevision, n: fullName, ref: sourceRef, cap: JSON.stringify(request.capabilities), sv: cursor.sv, ...value });
      switch (scope) {
        case 'issuesAndPr': {
          const versioned = cursor.v === 2;
          const issuesDisabled = request.capabilities?.issues === 'disabled';
          const pullsDisabled = request.capabilities?.pullRequests === 'disabled';
          const issuePage = issuesDisabled || versioned && cursor.i === null ? null : pageOf(cursor.i);
          const pullPage = pullsDisabled || versioned && cursor.p === null ? null : pageOf(cursor.p);
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
          if (attempted > 0 && succeeded === 0 && !issuesDisabled && !pullsDisabled) throw issuesError ?? pullsError;

          const merged = new Map<number, IssueOrPullRequest>();
          for (const item of issues) if (Number.isSafeInteger(item.number)) merged.set(item.number as number, toIssue(item));
          for (const item of pulls) if (Number.isSafeInteger(item.number)) merged.set(item.number as number, toPull(item));
          const ordered = [...merged.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number);

          const errors = [issuesError, pullsError].filter(error => error !== null).map(error => { const mapped = mapGitHubError(error); return { kind: mapped.kind, message: mapped.message, ...(mapped.resetAt ? { resetAt: mapped.resetAt } : {}) }; });
          const partial = issuesError !== null || pullsError !== null;
          const windowKey = await windowDigest(ordered);
          if (!partial && offset > 0 && cursor.w !== windowKey) {
            return { scope, items: [], hasMore: true, nextCursor: makeCursor({ i: issuePage, p: pullPage, off: 0, w: windowKey }), coverageComplete: false, windowRestarted: true, observedAt, accessContextRevision };
          }
          // 窗口内失败时不能把原 offset 应用于缩小后的单来源列表；重发成功来源并保留原窗口重试。
          const retryWindow = partial && offset > 0;
          const windowItems = ordered.slice(retryWindow ? 0 : offset, (retryWindow ? 0 : offset) + perPage);
          const consumed = offset + windowItems.length;
          const windowRemaining = consumed < ordered.length;
          const issuesMore = issuePage !== null && issuesError === null && issues.length === perPage;
          const pullsMore = pullPage !== null && pullsError === null && pulls.length === perPage;
          const nextIssues = issuePage === null ? null : issuesError !== null ? issuePage : issuesMore ? issuePage + 1 : null;
          const nextPulls = pullPage === null ? null : pullsError !== null ? pullPage : pullsMore ? pullPage + 1 : null;
          const nextCursor = retryWindow
            ? makeCursor({ i: issuePage, p: pullPage, off: offset, w: cursor.w })
            : windowRemaining
              ? makeCursor({ i: issuePage, p: pullPage, off: consumed, w: windowKey })
              : nextIssues !== null || nextPulls !== null
                ? makeCursor({ i: nextIssues, p: nextPulls, off: 0 })
                : null;
          const delivered = new Set(ordered.slice(0, consumed).map((item) => item.number));

          // 采集基线：只在窗口起点、两个来源都成功时提供（feature 原样保存，不代表"已验证无变化"）
          let fingerprint: string | undefined;
          if ((issuePage === 1 || issuesDisabled) && (pullPage === 1 || pullsDisabled) && !partial) {
            let upTo = observedAt;
            for (const item of ordered) if (item.updatedAt > upTo) upTo = item.updatedAt;
            const win = ordered.filter((item) => Date.parse(item.updatedAt) >= Date.parse(upTo) - PROBE_OVERLAP_MS).map((item) => [item.number, item.updatedAt]);
            fingerprint = JSON.stringify({ v: 1, upTo, win, reread: { pages: 1, perPage, digest: JSON.stringify([issuesDisabled ? 'disabled' : issues.map(issueTuple), pullsDisabled ? 'disabled' : pulls.map(pullTuple)]) } });
          }

          return {
            scope, items: windowItems, ...(errors.length > 0 ? { errors } : {}),
            hasMore: windowRemaining || issuesMore || pullsMore || partial,
            nextCursor,
            coverageComplete: !partial && !windowRemaining,
            observedAt, accessContextRevision, fingerprint,
            parts: {
              issues: {
                ok: issuesError === null,
                availability: request.capabilities?.issues ?? 'unknown',
                fingerprint: issuesDisabled ? JSON.stringify(['disabled']) : undefined,
                coverageComplete: issuesDisabled || issuePage !== null && issuesError === null && !retryWindow && issues.every((item) => delivered.has(item.number as number)),
                hasMore: issuesMore,
                nextCursor: retryWindow && issuePage !== null ? String(issuePage) : issuesError !== null ? String(issuePage) : issuesMore ? String(issuePage! + 1) : null,
              },
              pullRequests: {
                ok: pullsError === null,
                availability: request.capabilities?.pullRequests ?? 'unknown',
                fingerprint: pullsDisabled ? JSON.stringify(['disabled']) : undefined,
                coverageComplete: pullsDisabled || pullPage !== null && pullsError === null && !retryWindow && pulls.every((item) => delivered.has(item.number as number)),
                hasMore: pullsMore,
                nextCursor: retryWindow && pullPage !== null ? String(pullPage) : pullsError !== null ? String(pullPage) : pullsMore ? String(pullPage! + 1) : null,
              },
            },
          };
        }
        case 'builds': {
          const page = pageOf(cursor.p, pageOf(cursor.page));
          const runs = await fetchRunsPage(accessToken, fullName, perPage, page);
          const tuples = runs.map(runTuple);
          const hasMore = runs.length === perPage;
          const prior = parseFingerprint(request.baselineFingerprint ?? null);
          const oldTracked = page === 1 ? readRunTuples(prior?.tracked) ?? [] : [];
          const trackedById = new Map(oldTracked.map(tuple => [String(tuple[0]), tuple]));
          const key = await windowDigest([fullName, request.defaultBranch, accessContextRevision, request.baselineFingerprint ?? null]);
          const progress = readBuildProgress(typeof cursor.bp === 'object' && cursor.bp !== null ? cursor.bp as Record<string, unknown> : parseFingerprint(request.verificationProgress ?? null), key, request, trackedById);
          const validProgress = progress !== null;
          const observed = new Map<string, unknown[]>(validProgress
            ? progress.observed.map(tuple => [String(tuple[0]), tuple])
            : []);
          for (const tuple of tuples) if (trackedById.has(String(tuple[0]))) observed.set(String(tuple[0]), tuple);
          const pending = validProgress
            ? progress.pending.filter(id => !observed.has(id))
            : [];
          for (const id of trackedById.keys()) if (!observed.has(id) && !pending.includes(id)) pending.push(id);
          const toRead = pending.splice(0, 2); // 近期页与补查共最多三次 HTTP，不无界读取全部运行。
          let readError: import('../../../domain/types').NormalizedError | undefined;
          for (let index = 0; index < toRead.length; index += 1) {
            const id = toRead[index]!;
            try {
              const current = runTuple(await fetchRun(accessToken, fullName, id));
              if (String(current[0]) !== id) throw new TypeError('构建响应标识不匹配');
              observed.set(id, current);
            } catch (error) {
              const mapped = mapGitHubError(error);
              readError ??= { kind: mapped.kind, message: mapped.message, ...(mapped.resetAt ? { resetAt: mapped.resetAt } : {}) };
              pending.push(id);
              if (mapped.kind === 'access_token_invalid' || mapped.kind === 'rate_limited') { pending.push(...toRead.slice(index + 1)); break; }
            }
          }
          if (pending.length > 0 || readError) return {
            scope, items: [], hasMore: true, nextCursor: makeCursor({ p: page, bp: { v: 1, n: fullName, b: request.defaultBranch, a: accessContextRevision, k: key, pending, observed: [...observed.values()] } }),
            coverageComplete: false, observedAt, accessContextRevision,
            ...(readError ? { errors: [readError] } : {}),
          };
          const delivered = [...new Map([...tuples, ...observed.values()].map(tuple => [String(tuple[0]), tuple])).values()];
          const offset = pageOf(cursor.off, 0);
          const windowKey = await windowDigest(delivered);
          const completedProgress = { v: 1, n: fullName, b: request.defaultBranch, a: accessContextRevision, k: key, pending: [], observed: [...observed.values()] };
          if (offset > 0 && cursor.w !== windowKey) return { scope, items: [], hasMore: true, nextCursor: makeCursor({ p: page, bp: completedProgress, off: 0, w: windowKey }), coverageComplete: false, windowRestarted: true, observedAt, accessContextRevision };
          const items: BuildItem[] = delivered.slice(offset, offset + perPage).map(tuple => ({ ...toBuildInfo(runFromTuple(tuple)), id: String(tuple[0]) }));
          const consumed = offset + items.length;
          const windowRemaining = consumed < delivered.length;
          const tracked = delivered.filter(tuple => tuple[2] !== 'completed');
          return {
            scope, items, hasMore: hasMore || windowRemaining,
            nextCursor: windowRemaining ? makeCursor({ p: page, bp: completedProgress, off: consumed, w: windowKey }) : hasMore ? makeCursor({ p: page + 1 }) : null,
            coverageComplete: !windowRemaining, observedAt, accessContextRevision,
            version: { defaultBranch: request.defaultBranch },
            // 首页采集即基线：保留 attempt / status / conclusion 源字段，feature 原样保存
            fingerprint: page === 1 ? JSON.stringify({ v: 2, windowSize: perPage, recent: tuples, tracked }) : undefined,
          };
        }
        case 'commits': {
          const branch = request.defaultBranch ?? null;
          // 查询身份随游标保存：分支变化视为新查询，从第一页重新开始
          const identityMatches = cursor.v !== 2 || (typeof cursor.b === 'string' || cursor.b === null) && cursor.b === branch;
          const page = identityMatches ? pageOf(cursor.p, pageOf(cursor.page)) : 1;
          const items = await client.request(accessToken, `${repoPath(fullName)}/commits?per_page=${perPage}&page=${page}${sourceRef ? `&sha=${encodeURIComponent(sourceRef)}` : ''}`, mapCommits);
          const hasMore = items.length === perPage;
          return {
            scope, items, hasMore,
            nextCursor: hasMore ? makeCursor({ p: page + 1, b: branch }) : null,
            coverageComplete: true, observedAt, accessContextRevision,
            version: page === 1 ? { defaultBranch: branch, headRevision: items[0]?.sha ?? null } : undefined,
            fingerprint: page === 1 ? JSON.stringify({ v: 1, d: JSON.stringify([items[0]?.sha ?? null]) }) : undefined,
          };
        }
        case 'releases': {
          const versioned = cursor.v === 2;
          const releasePage = versioned && cursor.r === null ? null : pageOf(cursor.r, pageOf(cursor.page));
          const tagPage = versioned && cursor.t === null ? null : pageOf(cursor.t, pageOf(cursor.page));
          const offset = pageOf(cursor.off, 0);
          let releases: ReleaseItem[] = [];
          let releasesError: unknown = null;
          if (releasePage !== null) {
            try { releases = await fetchReleasesPage(accessToken, fullName, perPage, releasePage); } catch (error) { releasesError = error; }
          }
          let tags: Array<{ name: string; commitSha: string | null }> = [];
          let tagsError: unknown = null;
          if (tagPage !== null) {
            try { tags = await fetchTagsPage(accessToken, fullName, perPage, tagPage); } catch (error) { tagsError = error; }
          }
          const attempted = (releasePage !== null ? 1 : 0) + (tagPage !== null ? 1 : 0);
          const succeeded = (releasePage !== null && releasesError === null ? 1 : 0) + (tagPage !== null && tagsError === null ? 1 : 0);
          if (attempted > 0 && succeeded === 0) throw releasesError ?? tagsError;

          const releasesMore = releasePage !== null && releasesError === null && releases.length === perPage;
          const tagsMore = tagPage !== null && tagsError === null && tags.length === perPage;
          const nextTagPage = tagPage === null ? null : tagsError !== null ? tagPage : tagsMore ? tagPage + 1 : null;
          const fresh = releasePage === 1 && tagPage === 1;
          let releaseFp: string | null | undefined;
          let sourceError: unknown = null;
          if (fresh && request.targetVersion && 'releaseRevision' in request.targetVersion) {
            try {
              const saved = cursor.sv as Partial<ReleaseItem> | null | undefined;
              const stable = saved === null ? null : saved && typeof saved.tagName === 'string' && typeof saved.title === 'string' && (saved.publishedAt === null || typeof saved.publishedAt === 'string')
                ? saved as ReleaseItem : await fetchReleaseRaw(accessToken, fullName);
              releaseFp = stable === null ? null : releaseFingerprint(stable);
              cursor.sv = stable;
              releases = withStableRelease(releases, stable);
            } catch (error) { sourceError = error; }
          }
          // 两个栏目可区分：Release 与 Tag 各自带 kind 标记；新增实际稳定发版仍按 limit 续窗。
          const items = [
            ...releases.map((release) => ({ kind: 'release' as const, ...release })),
            ...tags.map((tag) => ({ kind: 'tag' as const, name: tag.name, committedAt: null as string | null })),
          ];
          const nextReleasePage = releasePage === null ? null : releasesError !== null || sourceError !== null ? releasePage : releasesMore ? releasePage + 1 : null;
          const errors = [releasesError, tagsError, sourceError].filter(error => error !== null).map(error => { const mapped = mapGitHubError(error); return { kind: mapped.kind, message: mapped.message, ...(mapped.resetAt ? { resetAt: mapped.resetAt } : {}) }; });
          const partial = releasesError !== null || tagsError !== null || sourceError !== null;
          const tagFp = tags[0] ? JSON.stringify([tags[0].name, tags[0].commitSha]) : null;
          const windowKey = await windowDigest(items);
          if (!partial && offset > 0 && cursor.w !== windowKey) {
            return { scope, items: [], hasMore: true, nextCursor: makeCursor({ r: releasePage, t: tagPage, off: 0, w: windowKey }), coverageComplete: false, windowRestarted: true, observedAt, accessContextRevision };
          }
          const retryWindow = partial && offset > 0;
          const windowItems = items.slice(retryWindow ? 0 : offset, (retryWindow ? 0 : offset) + perPage);
          const consumed = offset + windowItems.length;
          const windowRemaining = consumed < items.length;
          const releasesCovered = releasePage !== null && releasesError === null && sourceError === null && !retryWindow && consumed >= releases.length;
          const tagsCovered = tagPage !== null && tagsError === null && !retryWindow && !windowRemaining;
          const releaseWindowFp = JSON.stringify(releases.map(releaseFingerprint));
          const tagWindowFp = JSON.stringify(tags.map(tagFingerprint));
          return {
            scope, items: windowItems, ...(errors.length > 0 ? { errors } : {}),
            hasMore: windowRemaining || releasesMore || tagsMore || partial,
            nextCursor: retryWindow
              ? makeCursor({ r: releasePage, t: tagPage, off: offset, w: cursor.w })
              : windowRemaining
                ? makeCursor({ r: releasePage, t: tagPage, off: consumed, w: windowKey })
                : nextReleasePage !== null || nextTagPage !== null
                  ? makeCursor({ r: nextReleasePage, t: nextTagPage, off: 0 })
                  : null,
            coverageComplete: !partial && !windowRemaining, observedAt, accessContextRevision,
            version: fresh
              ? { ...(releaseFp !== undefined && releasesError === null && sourceError === null ? { releaseRevision: releaseFp } : {}), ...(tagsError === null ? { tagRevision: tagFp } : {}) }
              : undefined,
            fingerprint: fresh && !partial ? JSON.stringify({ v: 1, perPage, d: JSON.stringify([releaseWindowFp, tagWindowFp]) }) : undefined,
            parts: {
              releases: { ok: releasesError === null && sourceError === null, coverageComplete: releasesCovered, hasMore: releasesMore, nextCursor: retryWindow && releasePage !== null ? String(releasePage) : nextReleasePage !== null && (releasesError !== null || sourceError !== null) ? String(nextReleasePage) : releasesMore ? String(releasePage! + 1) : null, fingerprint: fresh && releasesCovered ? releaseWindowFp : undefined },
              tags: { ok: tagsError === null, coverageComplete: tagsCovered, hasMore: tagsMore, nextCursor: retryWindow && tagPage !== null ? String(tagPage) : nextTagPage !== null && tagsError !== null ? String(nextTagPage) : tagsMore ? String(tagPage! + 1) : null, fingerprint: fresh && tagsCovered ? tagWindowFp : undefined },
            },
          };
        }
        case 'readme': {
          const branchQuery = sourceRef ? `?ref=${encodeURIComponent(sourceRef)}` : '';
          const entries = await client.request(accessToken, `${repoPath(fullName)}/contents${branchQuery}`, readmeEntries);
          const offset = pageOf(cursor.off, 0);
          const windowKey = await windowDigest(entries);
          if (offset > 0 && cursor.w !== windowKey) return { scope, items: [], hasMore: true, nextCursor: makeCursor({ off: 0, w: windowKey }), coverageComplete: false, windowRestarted: true, observedAt, accessContextRevision };
          const items = entries.slice(offset, offset + perPage).map(toReadmeDocument);
          const consumed = offset + items.length;
          const hasMore = consumed < entries.length;
          return {
            scope, items, hasMore,
            nextCursor: hasMore ? makeCursor({ off: consumed, w: windowKey }) : null,
            coverageComplete: !hasMore, observedAt, accessContextRevision,
            version: request.targetVersion?.headRevision ? { defaultBranch: request.defaultBranch, headRevision: request.targetVersion.headRevision } : undefined,
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
          const windowKey = await windowDigest([result.sha, result.entries]);
          if (offset > 0 && cursor.w !== windowKey) return { scope, items: [], hasMore: true, nextCursor: makeCursor({ off: 0, w: windowKey }), coverageComplete: false, windowRestarted: true, observedAt, accessContextRevision };
          const items = result.entries.slice(offset, offset + perPage);
          const consumed = offset + items.length;
          const hasMore = result.truncated || consumed < result.entries.length;
          return {
            scope, items, hasMore,
            nextCursor: consumed < result.entries.length ? makeCursor({ off: consumed, w: windowKey }) : null,
            coverageComplete: !result.truncated && consumed >= result.entries.length,
            observedAt, accessContextRevision,
            fingerprint: offset === 0 && !result.truncated && result.sha !== null ? JSON.stringify({ v: 1, d: JSON.stringify([result.sha]) }) : undefined,
          };
        }
        case 'overview': {
          const repo = await client.request(accessToken, repoPath(fullName), (json) => json as RawRepo);
          const branch = typeof repo.default_branch === 'string' ? repo.default_branch : request.defaultBranch;
          const settled = await Promise.allSettled([
            fetchReleaseRaw(accessToken, fullName),
            fetchTagRaw(accessToken, fullName),
            branch === null ? Promise.reject(new PortFailure('unknown', '默认分支未知')) : fetchHeadSha(accessToken, fullName, branch),
          ]);
          const release = settled[0].status === 'fulfilled' ? settled[0].value : null;
          const tag = settled[1].status === 'fulfilled' ? settled[1].value : null;
          const head = settled[2].status === 'fulfilled' ? settled[2].value : null;
          const errors = settled.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected').map(entry => { const mapped = mapGitHubError(entry.reason); return { kind: mapped.kind, message: mapped.message, ...(mapped.resetAt ? { resetAt: mapped.resetAt } : {}) }; });
          const partial = errors.length > 0;
          const values: GlanceValues = {
            stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
            forks: typeof repo.forks_count === 'number' ? repo.forks_count : 0,
            openIssues: typeof repo.open_issues_count === 'number' ? repo.open_issues_count : 0,
            pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null,
            latestReleaseTag: release?.tagName ?? tag?.name ?? null,
            latestTag: tag?.name ?? null,
            collaborationAt: null,
            status: repo.archived === true ? 'archived' : repo.disabled === true ? 'deleted' : 'active',
          };
          const metadata: RepositoryMetadata = {
            description: typeof repo.description === 'string' ? repo.description : null,
            homepage: typeof repo.homepage === 'string' ? repo.homepage : null,
            license: repo.license && typeof repo.license.spdx_id === 'string' ? repo.license.spdx_id : null,
            defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
            capabilities: repositoryCapabilities(repo),
          };
          const version: ContentVersion = {
            defaultBranch: metadata.defaultBranch,
            headRevision: head,
            releaseRevision: release === null ? null : releaseFingerprint(release),
            tagRevision: tagFingerprint(tag),
          };
          const repoKey = overviewRepoDigest(repo);
          const digest = JSON.stringify([repoKey, releaseFingerprint(release ?? { tagName: '', title: '', publishedAt: null }), tagFingerprint(tag), head]);
          const items: OverviewContent[] = [{ values, metadata }];
          return {
            scope, items, ...(errors.length > 0 ? { errors } : {}), hasMore: false, nextCursor: null,
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
