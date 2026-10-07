import type { BuildInfo, CheckedSignal, CommitItem, ReleaseItem, SummaryObservation } from '../../src/domain/types';
import { PortFailure } from '../../src/domain/ports';
import type {
  GitHubPort,
  IssueOrPullRequest,
  RepoMeta,
  ScopeFetchOutcome,
  ScopeFetchRequest,
  ScopeVerification,
  ScopeVerifyRequest,
} from '../../src/domain/ports';

/** 录制形态的仓库数据（按抓取与 API 调用清单组织）。 */
export interface FakeRepoData {
  meta: RepoMeta;
  latestRelease: ReleaseItem | null;
  releases: ReleaseItem[];
  commits: CommitItem[];
  issuesAndPullRequests: IssueOrPullRequest[];
  build: BuildInfo | null;
  /** 归一化观察的信号配置；缺省 head 为 null、release/tag 为 null。 */
  observation?: FakeObservationConfig;
}

export interface FakeObservationConfig {
  defaultBranch?: string | null;
  head?: string | null;
  release?: string | null;
  tag?: string | null;
  /** 注入为 unknown 的信号；用于验证"未检查/失败"与"确认不存在"的区分。 */
  unknown?: Array<'head' | 'release' | 'tag'>;
  /** 协作活动候选（直接读到的源时间）；缺省 = 确认无活动。 */
  collaborationAt?: string | null;
  collaborationKind?: 'issue' | 'pull-request';
  collaborationState?: 'open' | 'closed';
  collaborationSourceId?: string;
  collaborationRevision?: string;
  collaborationCreatedAt?: string | null;
  collaborationClosedAt?: string | null;
  errors?: SummaryObservation['errors'];
}

export type FakeMethod = 'validateAccessToken' | keyof Omit<GitHubPort, 'validateAccessToken'> | 'observeSummary' | 'verifyScopes' | 'fetchScope';

/** 按 spec 的错误与降级场景构造的适配器错误。 */
export const fixtures = {
  unauthorized(): PortFailure {
    return new PortFailure('access_token_invalid', '访问令牌无效，请到设置页更换令牌');
  },
  rateLimited(resetAt: Date): PortFailure {
    return new PortFailure('rate_limited', '抓取被 GitHub 限流，配额恢复前暂不可用', resetAt.toISOString());
  },
  /** 限流但响应不带恢复时间头。 */
  rateLimitedNoReset(): PortFailure {
    return new PortFailure('rate_limited', '抓取被 GitHub 限流，配额恢复前暂不可用');
  },
  /** 429 限流（无任何配额头）。 */
  tooManyRequests(): PortFailure {
    return new PortFailure('rate_limited', '抓取被 GitHub 限流，配额恢复前暂不可用');
  },
  notFound(): PortFailure {
    return new PortFailure('not_found', '仓库不存在或无权访问');
  },
  networkError(): TypeError {
    return new TypeError('fetch failed');
  },
  unknownError(): Error {
    return new Error('unexpected payload');
  },
};

export function makeRepoData(overrides: Partial<FakeRepoData> = {}): FakeRepoData {
  return {
    meta: {
      fullName: 'octo-demo/hello-world',
      stars: 1284,
      forks: 96,
      openIssues: 23,
      pushedAt: '2026-09-25T08:30:00.000Z',
    },
    latestRelease: {
      tagName: 'v2.4.0',
      title: 'v2.4.0 — 稳定性修复',
      publishedAt: '2026-09-20T12:00:00.000Z',
    },
    releases: [
      { tagName: 'v2.4.0', title: 'v2.4.0 — 稳定性修复', publishedAt: '2026-09-20T12:00:00.000Z' },
      { tagName: 'v2.3.1', title: 'v2.3.1 — 补丁', publishedAt: '2026-08-11T09:00:00.000Z' },
    ],
    commits: [
      {
        sha: 'a1b2c3d',
        message: '修复快照当日重复记档',
        authorName: 'octo-dev',
        committedAt: '2026-09-25T08:30:00.000Z',
      },
      {
        sha: 'e4f5a6b',
        message: '补充限流错误归一',
        authorName: 'octo-dev',
        committedAt: '2026-09-24T15:10:00.000Z',
      },
    ],
    issuesAndPullRequests: [
      { kind: 'issue', number: 42, title: '清单页刷新按钮无反馈', body: '刷新按钮应该显示进行中的状态。', state: 'open', authorName: 'user-a', updatedAt: '2026-09-25T02:00:00.000Z' },
      { kind: 'pull', number: 57, title: 'feat: 详情页构建徽章', body: '为详情页增加构建状态展示。', state: 'open', authorName: 'user-b', updatedAt: '2026-09-25T07:20:00.000Z' },
    ],
    build: {
      workflowName: 'ci',
      status: 'success',
      resultDescription: 'success',
      url: 'https://github.com/octo-demo/hello-world/actions/runs/1',
      finishedAt: '2026-09-25T08:45:00.000Z',
    },
    ...overrides,
  };
}

/**
 * 假 GitHub 适配器：以录制的 fixtures 应答，
 * 并可按仓库 + 方法注入限流 / 401 / 404 / 网络失败场景。
 * 每个方法调用都计入 `calls`，供用例分别统计适配器调用（与 fake fetch 的 HTTP 计数区分）。
 */
export class FakeGitHub implements GitHubPort {
  validAccessToken = 'ghp_valid_token';
  /** 抓取过程中令牌失效（401）。 */
  accessTokenInvalid = false;
  /** 全局断网。 */
  networkDown = false;
  repos = new Map<string, FakeRepoData>();
  /** 按 fullName（'*' 表示所有仓库）+ 方法注入的错误。 */
  failures = new Map<string, Partial<Record<FakeMethod, unknown>>>();
  /** 适配器调用计数（按方法名）。 */
  readonly calls: Record<string, number> = {};
  /** 范围验证的预置结果；未配置时返回 checkComplete=false（未完成，不冒充无变化）。 */
  scopeVerifications = new Map<string, ScopeVerification>();
  /** 范围抓取的预置处理器；未配置即抛出（不返回空成功）。 */
  scopeFetches = new Map<string, (request: ScopeFetchRequest) => Promise<ScopeFetchOutcome>>();
  /** observeSummary 的挂起闸门（测去重时让在途任务可见）。 */
  observationGate: Promise<void> | null = null;

  holdNextObservation(): () => void {
    let release = (): void => {};
    this.observationGate = new Promise<void>((resolve) => {
      release = () => {
        this.observationGate = null;
        resolve();
      };
    });
    return release;
  }

  addRepo(data: FakeRepoData): FakeRepoData {
    this.repos.set(data.meta.fullName, data);
    return data;
  }

  fail(fullName: string, method: FakeMethod, error: unknown): void {
    const perRepo = this.failures.get(fullName) ?? {};
    perRepo[method] = error;
    this.failures.set(fullName, perRepo);
  }

  resetCalls(): void {
    for (const key of Object.keys(this.calls)) delete this.calls[key];
  }

  count(method: string): number {
    return this.calls[method] ?? 0;
  }

  setScopeVerification(fullName: string, scope: string, result: Omit<ScopeVerification, 'scope' | 'accessContextRevision'>): void {
    this.scopeVerifications.set(`${fullName}|${scope}`, { scope: scope as ScopeVerification['scope'], accessContextRevision: 0, ...result });
  }

  setScopeFetch(fullName: string, scope: string, handler: (request: ScopeFetchRequest) => Promise<ScopeFetchOutcome>): void {
    this.scopeFetches.set(`${fullName}|${scope}`, handler);
  }

  private record(method: string): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
  }

  private guard(fullName: string, method: FakeMethod): void {
    const scoped = this.failures.get(fullName)?.[method] ?? this.failures.get('*')?.[method];
    if (scoped) throw scoped;
    if (this.networkDown) throw fixtures.networkError();
    if (this.accessTokenInvalid) throw fixtures.unauthorized();
  }

  private repo(fullName: string): FakeRepoData {
    // 真实 GitHub API 对仓库名大小写不敏感（同语义）
    for (const [key, data] of this.repos) {
      if (key.toLowerCase() === fullName.toLowerCase()) return data;
    }
    throw fixtures.notFound();
  }

  async validateAccessToken(accessToken: string): Promise<void> {
    this.record('validateAccessToken');
    this.guard('*', 'validateAccessToken');
    if (accessToken !== this.validAccessToken) throw fixtures.unauthorized();
  }

  async getRepositoryMeta(_accessToken: string, fullName: string): Promise<RepoMeta> {
    this.record('getRepositoryMeta');
    this.guard(fullName, 'getRepositoryMeta');
    return this.repo(fullName).meta;
  }

  async getLatestRelease(_accessToken: string, fullName: string): Promise<ReleaseItem | null> {
    this.record('getLatestRelease');
    this.guard(fullName, 'getLatestRelease');
    return this.repo(fullName).latestRelease;
  }

  async listReleases(_accessToken: string, fullName: string): Promise<ReleaseItem[]> {
    this.record('listReleases');
    this.guard(fullName, 'listReleases');
    return this.repo(fullName).releases;
  }

  async listCommits(_accessToken: string, fullName: string): Promise<CommitItem[]> {
    this.record('listCommits');
    this.guard(fullName, 'listCommits');
    return this.repo(fullName).commits;
  }

  async listIssues(_accessToken: string, fullName: string): Promise<IssueOrPullRequest[]> {
    this.record('listIssues');
    this.guard(fullName, 'listIssues');
    return this.repo(fullName).issuesAndPullRequests;
  }

  async getLatestBuild(_accessToken: string, fullName: string): Promise<BuildInfo | null> {
    this.record('getLatestBuild');
    this.guard(fullName, 'getLatestBuild');
    return this.repo(fullName).build;
  }

  // —— 步骤 4 端口：归一化观察、范围验证与范围抓取 ——

  async observeSummary(_accessToken: string, fullName: string, observedAt: string, accessContextRevision: number): Promise<SummaryObservation> {
    this.record('observeSummary');
    this.guard(fullName, 'observeSummary');
    if (this.observationGate) await this.observationGate;
    const data = this.repo(fullName);
    const config = data.observation ?? {};
    const known = <T>(value: T | null): CheckedSignal<T> => ({ state: 'known', value, checkedAt: observedAt });
    const maybe = <T>(name: 'head' | 'release' | 'tag', value: T | null): CheckedSignal<T> =>
      config.unknown?.includes(name) ? { state: 'unknown', error: `注入的 ${name} 检查失败` } : known(value);
    const tagName = config.tag ?? null;
    const collaborationAt = config.collaborationAt ?? null;
    return {
      fullName: data.meta.fullName,
      observedAt,
      accessContextRevision,
      ...(config.errors ? { errors: config.errors } : {}),
      values: {
        stars: data.meta.stars,
        forks: data.meta.forks,
        openIssues: data.meta.openIssues,
        pushedAt: data.meta.pushedAt,
        latestReleaseTag: data.latestRelease?.tagName ?? tagName,
        latestTag: tagName,
        collaborationAt,
        status: data.meta.status ?? 'active',
      },
      signals: {
        defaultBranch: known(config.defaultBranch === undefined ? 'main' : config.defaultBranch),
        headRevision: maybe('head', config.head === undefined ? null : config.head),
        releaseRevision: maybe('release', config.release === undefined ? null : config.release),
        tagRevision: maybe('tag', tagName),
      },
      activity: {
        // 与真实适配器一致：只保留源信息与检查结果，重要性由 domain/feature 判定
        code: { kind: 'code', at: data.meta.pushedAt, verified: false },
        release: { kind: 'release', at: data.latestRelease?.publishedAt ?? null, verified: true },
        collaboration: collaborationAt === null
          ? { kind: 'issue', at: null, verified: false }
          : { kind: config.collaborationKind ?? 'issue', at: collaborationAt, verified: true, state: config.collaborationState ?? 'open',
              sourceId: config.collaborationSourceId ?? '1', contentRevision: config.collaborationRevision ?? 'initial',
              createdAt: config.collaborationCreatedAt === undefined ? collaborationAt : config.collaborationCreatedAt,
              closedAt: config.collaborationClosedAt ?? null },
      },
    };
  }

  async verifyScopes(_accessToken: string, request: ScopeVerifyRequest): Promise<ScopeVerification> {
    this.record('verifyScopes');
    this.guard(request.fullName, 'verifyScopes');
    const configured = this.scopeVerifications.get(`${request.fullName}|${request.scope}`);
    if (!configured) {
      // 未配置 = 检查未完成：不得被当成"已确认无变化"。
      return { scope: request.scope, checkedAt: request.checkedAt, checkComplete: false, changed: false, accessContextRevision: request.accessContextRevision };
    }
    return { ...configured, accessContextRevision: request.accessContextRevision };
  }

  async fetchScope(_accessToken: string, request: ScopeFetchRequest): Promise<ScopeFetchOutcome> {
    this.record('fetchScope');
    this.guard(request.fullName, 'fetchScope');
    const handler = this.scopeFetches.get(`${request.fullName}|${request.scope}`);
    if (!handler) throw new Error(`FakeGitHub：fetchScope(${request.scope}) 未配置`);
    return handler(request);
  }
}
