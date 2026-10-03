import type {
  BuildInfo,
  BuildItem,
  CommitItem,
  ErrorKind,
  Glance,
  GlanceValues,
  IssueItem,
  PullRequestItem,
  ReadmeDocument,
  ReleaseItem,
  RepositoryMetadata,
  Snapshot,
  TagItem,
  TreeEntry,
} from './types';

export interface RepoMeta {
  fullName: string;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string | null;
  latestReleaseTag?: string | null;
  latestTag?: string | null;
  collaborationAt?: string | null;
  status?: 'active' | 'archived' | 'deleted' | 'renamed';
}

export type IssueOrPullRequest =
  | (IssueItem & { kind: 'issue' })
  | (PullRequestItem & { kind: 'pull' });

/** 适配器把平台错误收敛为领域可识别的失败。 */
export class PortFailure extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly resetAt?: string) {
    super(message);
    this.name = 'PortFailure';
  }
}

export interface Logger { info(message: string): void; error(message: string, error?: unknown): void; }
export interface Clock { now(): Date; }
export interface Transaction { commit(): Promise<void> | void; rollback(): Promise<void> | void; }
export interface TransactionManager { transaction<T>(work: (tx: Transaction) => Promise<T> | T): Promise<T>; }

export interface TokenStore {
  read(): Promise<string | null> | string | null;
  save(token: string): Promise<void> | void;
  clear(): Promise<void> | void;
  isConfigured?(): Promise<boolean> | boolean;
}

export interface RepositoryListStore {
  list(): Promise<Glance[]> | Glance[];
  findById(id: number): Promise<Glance | null> | Glance | null;
  save(repository: Glance): Promise<void> | void;
  remove(id: number): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface DetailStore {
  read(repositoryId: number): Promise<unknown> | unknown;
  save(repositoryId: number, value: unknown): Promise<void> | void;
  remove(repositoryId: number): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface SnapshotStore {
  upsert(repositoryId: number, snapshot: Snapshot): Promise<void> | void;
  list(repositoryId: number): Promise<Snapshot[]> | Snapshot[];
  remove(repositoryId: number): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface GitHubPort {
  validateAccessToken(accessToken: string): Promise<void>;
  getRepositoryMeta(accessToken: string, fullName: string): Promise<RepoMeta>;
  getLatestRelease(accessToken: string, fullName: string): Promise<ReleaseItem | null>;
  listReleases(accessToken: string, fullName: string): Promise<ReleaseItem[]>;
  getLatestTag?(accessToken: string, fullName: string): Promise<TagItem | null>;
  /** 标签适配器可返回旧版字符串列表或新版标签值；feature 在边界归一化。 */
  listTags?(accessToken: string, fullName: string): Promise<unknown>;
  listTagItems?(accessToken: string, fullName: string, cursor?: string): Promise<{ items: TagItem[]; nextCursor: string | null }>;
  listCommits(accessToken: string, fullName: string): Promise<CommitItem[]>;
  listIssues(accessToken: string, fullName: string): Promise<IssueOrPullRequest[]>;
  listReleasesPage?(accessToken: string, fullName: string, cursor?: string): Promise<{ items: ReleaseItem[]; nextCursor: string | null }>;
  listTagsPage?(accessToken: string, fullName: string, cursor?: string): Promise<{ items: TagItem[]; nextCursor: string | null }>;
  listCommitsPage?(accessToken: string, fullName: string, cursor?: string): Promise<{ items: CommitItem[]; nextCursor: string | null }>;
  listIssuesPage?(accessToken: string, fullName: string, cursor?: string): Promise<{ items: IssueOrPullRequest[]; nextCursor: string | null }>;
  getLatestBuild(accessToken: string, fullName: string): Promise<BuildInfo | null>;
  listBuilds?(accessToken: string, fullName: string): Promise<BuildItem[]>;
  getMetadata?(accessToken: string, fullName: string): Promise<RepositoryMetadata>;
  listReadmes?(accessToken: string, fullName: string): Promise<ReadmeDocument[]>;
  listTree?(accessToken: string, fullName: string): Promise<TreeEntry[]>;
  getCollaborationActivity?(accessToken: string, fullName: string): Promise<string | null>;
}

/** 轻量摘要写入所需的最小端口，便于 feature 替换持久化实现。 */
export interface GlancePort { fetch(accessToken: string, fullName: string): Promise<GlanceValues & { fullName?: string }>; }
/** 详情抓取端口。 */
export interface DetailPort { fetch(accessToken: string, fullName: string): Promise<unknown>; }
/** 摘要快照端口。 */
export interface SnapshotPort { record(repositoryId: number, snapshot: Snapshot): Promise<void> | void; trend(repositoryId: number): Promise<Snapshot[]> | Snapshot[]; }
