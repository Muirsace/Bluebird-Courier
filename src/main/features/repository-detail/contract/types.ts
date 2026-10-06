import type {
  BuildInfo,
  DetailScope,
  DetailValues,
  Glance,
  NormalizedError,
  ObservationHandoff,
  PaginationCursor,
  RequestStatus,
  ScopeSyncState,
  Snapshot,
} from '../../../../domain/types';

export type ColumnName = 'overview' | 'releases' | 'tags' | 'commits' | 'issues' | 'pullRequests' | 'builds' | 'readme' | 'tree';
export type ColumnStatus = 'loading' | 'success' | 'empty' | 'forbidden' | 'failed' | 'unsupported';

export interface ColumnResult<T = unknown> {
  status: ColumnStatus;
  value: T | null;
  error: NormalizedError | null;
  hasMore?: boolean;
  cursor?: string | null;
}

export interface DetailCache {
  repositoryId: number;
  fullName: string;
  values: DetailValues;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  fetchedAt: string;
  source: 'fresh' | 'cache';
}

export interface DetailResult {
  repository: Glance;
  values: DetailValues;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  cached: boolean;
  stale: boolean;
  error: NormalizedError | null;
}

export interface HistoryPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// —— 步骤 5 契约面：本地读取、观察应用、任务状态与范围同步（实现见步骤 7、8） ——

/** 有界本地读取请求；mode='status' 只返回状态与版本，不解析详情 payload。 */
export interface LocalReadRequest {
  mode?: 'view' | 'status';
  scopes?: readonly DetailScope[];
  /** 每个范围的最大条目数；缺省由实现按上限收口。 */
  itemLimit?: number;
  /** 各范围的续读游标（范围分页）；缺省从头读取。 */
  cursors?: Partial<Record<DetailScope, PaginationCursor>>;
}

/** 任务状态快照：只含状态与版本，不携带详情 payload。 */
export interface SyncTaskState {
  taskId: string;
  kind: 'open' | 'check' | 'force' | 'scope';
  status: RequestStatus;
  targetScopes: DetailScope[];
  targetRevisions: Partial<Record<DetailScope, number>>;
  startedAt: string;
}

/** 本地视图读取结果；无网络副作用，不启动抓取。 */
export interface LocalDetailView {
  repository: Glance;
  /** mode='status' 或没有详情缓存时为 null。 */
  values: DetailValues | null;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  viewVersion: number;
  accessContextRevision: number;
  scopes: Partial<Record<DetailScope, ScopeSyncState>>;
  task: SyncTaskState | null;
  cursors?: Partial<Record<DetailScope, PaginationCursor>>;
  truncated: boolean;
}

/** 幂等观察应用结果：duplicate=true 表示同一 observationId 重放，不再重复递增序号。 */
export interface ObservationApplyOutcome {
  applied: boolean;
  duplicate: boolean;
  affectedScopes: DetailScope[];
}

/** 范围同步请求（强制 / 计划执行的输入）。 */
export interface ScopeSyncRequest {
  scopes: readonly DetailScope[];
  accessContextRevision: number;
}

export interface ScopeSyncOutcome {
  scopes: Partial<Record<DetailScope, 'synced' | 'partial' | 'failed'>>;
}

export interface RepositoryDetailService {
  getCached(repositoryId: number): DetailCache | null;
  open(repositoryId: number, token: string, force?: boolean): Promise<DetailResult>;
  refresh(repositoryId: number, token: string): Promise<DetailResult>;
  loadHistory(repositoryId: number, token: string, kind: 'commits' | 'issues' | 'pullRequests', cursor?: string): Promise<HistoryPage<unknown>>;
  remove(repositoryId: number): void;
  clear(): void;
  /**
   * 只读本地视图 / 纯状态：无网络副作用，不启动抓取。
   * 步骤 7 实现（当前为 undefined，不返回假视图）。
   */
  readLocal?(repositoryId: number, request?: LocalReadRequest): LocalDetailView | null;
  /**
   * 幂等应用清单观察（按 observationId 去重，旧 dirty 不被重复递增）。
   * 步骤 7 实现（当前为 undefined）。
   */
  applyObservation?(handoff: ObservationHandoff, appliedAt: string): ObservationApplyOutcome;
  /**
   * 按范围执行同步（后台任务的实际执行入口）。
   * 步骤 8 实现（当前为 undefined）。
   */
  syncScopes?(repositoryId: number, request: ScopeSyncRequest): Promise<ScopeSyncOutcome>;
}

export type { BuildInfo, DetailValues, Glance, Snapshot };
