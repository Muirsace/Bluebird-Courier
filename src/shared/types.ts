/**
 * 领域类型与用例门面契约（词汇表见 CONTEXT.md）。
 *
 * 时间一律以 UTC ISO8601 字符串存储与传输，展示层负责转相对时间。
 * 本文件被主进程、preload、渲染进程三方共享，是唯一的跨进程契约来源。
 */

// ---------- 错误（归一为五类） ----------

/** 错误类别：令牌无效、限流、不存在/无权限、网络失败、未知。 */
export type ErrorKind = 'access_token_invalid' | 'rate_limited' | 'not_found' | 'network' | 'unknown';

export interface NormalizedError {
  kind: ErrorKind;
  /** 面向用户的提示文案。 */
  message: string;
  /** 仅限流时存在：配额恢复时间（UTC ISO8601）。 */
  resetAt?: string;
  /** 关联的监控仓库（owner/name），批量抓取时逐仓库标注。 */
  fullName?: string;
}

// ---------- 轻量信息 / 监控仓库 ----------

/** 轻量信息：清单中每个监控仓库的概览。 */
export interface Glance {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  addedAt: string;
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  /** 最近动态时间：最近一次推送。 */
  pushedAt: string | null;
  latestReleaseTag: string | null;
  /** 最近一次成功抓取时间。 */
  fetchedAt: string | null;
}

// ---------- 全量信息 ----------

export interface ReleaseItem {
  tagName: string;
  title: string;
  publishedAt: string | null;
}

export interface CommitItem {
  sha: string;
  /** 提交消息（首行）。 */
  message: string;
  authorName: string | null;
  committedAt: string;
}

export interface IssueItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  authorName: string | null;
  updatedAt: string;
}

export interface PullRequestItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  authorName: string | null;
  updatedAt: string;
}

/** 构建状态：none = 没有构建（"无构建"空态）。 */
export type BuildStatus = 'success' | 'failure' | 'pending' | 'neutral' | 'none';

export interface BuildInfo {
  status: BuildStatus;
  /** 最近一次构建的结论原文（GitHub conclusion），无构建时为 null。 */
  conclusion: string | null;
  workflowName: string | null;
  url: string | null;
  finishedAt: string | null;
}

/** 历史快照：一次成功抓取后按日留存的仓库指标值。 */
export interface Snapshot {
  capturedAt: string;
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  latestReleaseTag: string | null;
  pushedAt: string | null;
}

/** 全量信息：五类更新的完整内容（趋势只读快照，不调接口）。 */
export interface Detail {
  repository: Glance;
  releases: ReleaseItem[];
  commits: CommitItem[];
  issues: IssueItem[];
  pullRequests: PullRequestItem[];
  build: BuildInfo;
  /** 星标趋势：由历史快照序列构成。 */
  trend: Snapshot[];
}

// ---------- 用例门面结果 ----------

export interface AccessTokenState {
  configured: boolean;
}

export interface AccessTokenResult {
  ok: boolean;
  error: NormalizedError | null;
}

export interface AddRepositoryResult {
  ok: boolean;
  repository: Glance | null;
  error: NormalizedError | null;
}

/** 清单页重新抓取的结果：失败的仓库保留上次数据并附错误。 */
export interface RefreshGlanceResult {
  repositories: Glance[];
  errors: NormalizedError[];
}

export interface DetailResult {
  /** 抓取失败时为 null，UI 继续展示上次数据并显示错误条。 */
  detail: Detail | null;
  error: NormalizedError | null;
}

export interface SettingsView {
  /** 偏好项（setting 表中的键值）。 */
  preferences: Record<string, string>;
  accessTokenConfigured: boolean;
}

/** 渲染层唯一入口：主进程用例门面。 */
export interface OctoFacade {
  // 访问令牌
  accessTokenState(): Promise<AccessTokenState>;
  validateAccessToken(accessToken: string): Promise<AccessTokenResult>;
  saveAccessToken(accessToken: string): Promise<AccessTokenResult>;
  // 设置读写
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: Record<string, string>): Promise<SettingsView>;
  // 监控清单（增删与列举，列举返回轻量信息）
  listRepositories(): Promise<Glance[]>;
  addRepository(fullName: string): Promise<AddRepositoryResult>;
  removeRepository(repositoryId: number): Promise<void>;
  // 抓取（清单页=轻量；详情页=全量）
  refreshGlance(): Promise<RefreshGlanceResult>;
  fetchDetail(repositoryId: number): Promise<DetailResult>;
}

// ---------- 桌面集成：在 GitHub 打开 ----------

/**
 * 外链目标：渲染层只描述"要打开哪个 GitHub 实体"，URL 一律由主进程构造。
 * 唯一例外是 build——GitHub Actions 页面地址由接口直接给出（BuildInfo 里没有 run id 可构造）。
 */
export type GitHubExternalTarget =
  | { kind: 'repository'; owner: string; name: string }
  | { kind: 'release'; owner: string; name: string; tagName: string }
  | { kind: 'commit'; owner: string; name: string; sha: string }
  | { kind: 'issue'; owner: string; name: string; number: number }
  | { kind: 'pull'; owner: string; name: string; number: number }
  | { kind: 'build'; url: string };

/** 外链打开结果：要么目标被主进程守卫拒绝，要么系统打不开，不存在"假装成功"。 */
export interface OpenExternalResult {
  ok: boolean;
  reason: 'invalid_target' | 'open_failed' | null;
}

/**
 * 桌面集成窄接口：渲染层唯一能触碰系统浏览器的入口。
 * 没有 shell / ipcRenderer / 任意协议 / 任意 URL 的通用通道，目标由主进程再次校验。
 */
export interface ExternalLinkBridge {
  openGitHubExternal(target: GitHubExternalTarget): Promise<OpenExternalResult>;
}

/** preload 暴露到 window.octo 的通道白名单。 */
export type OctoBridge = OctoFacade & ExternalLinkBridge;
