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
  /** mode='status' 或缓存不可用时为 null。 */
  values: DetailValues | null;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  viewVersion: number;
  accessContextRevision: number;
  scopes: Partial<Record<DetailScope, ScopeSyncState>>;
  task: SyncTaskState | null;
  cursors?: Partial<Record<DetailScope, PaginationCursor>>;
  truncated: boolean;
  /** 损坏缓存、schema 或访问上下文不匹配等明确失败；不得伪装成空成功。 */
  error: NormalizedError | null;
}

/** 幂等观察应用结果：duplicate=true 表示同一 observationId 重放，不再重复递增序号。 */
export interface ObservationApplyOutcome {
  applied: boolean;
  duplicate: boolean;
  affectedScopes: DetailScope[];
}

/** 真实远端摘要观察；由 facade 协调清单写回与趋势采样。 */
export interface DetailObservation { repositoryId: number; accessContextRevision: number; observedAt: string; values: import('../../../../domain/types').GlanceValues; }

export interface DetailAccessResult {
  view: LocalDetailView;
  /** true = 本次调用等待的网络获取已提交内容；部分覆盖仍通过 error 与范围账本明示。 */
  fetched: boolean;
  /** 等待的获取失败时的原始错误；由 facade 归一化为跨进程错误。 */
  error: unknown;
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
  /** 真正取得远端摘要后通知 facade；缓存读取和仅内容抓取不产生采样。 */
  onObservation(listener: (observation: DetailObservation) => void): void;
  /**
   * 打开用例：先读本地视图；有可展示缓存立即返回并按需安排后台任务（不等待网络），
   * 无有效缓存时等待必要的首次获取。token 为 null 时只读本地、不安排网络计划。
   */
  open(repositoryId: number, token: string | null): Promise<DetailAccessResult>;
  /** 强制同步：按 domain.planSync 的 force 决策执行完整获取；失败保留旧内容与 dirty。 */
  refresh(repositoryId: number, token: string): Promise<DetailAccessResult>;
  /** 历史分页：只读已保存的本地内容，不在读取路径触发网络。 */
  loadHistory(repositoryId: number, token: string, kind: 'commits' | 'issues' | 'pullRequests', cursor?: string): Promise<HistoryPage<unknown>>;
  remove(repositoryId: number): void;
  clear(): void;
  /**
   * 只读本地视图 / 纯状态：无网络副作用，不启动抓取，不刷新抓取时间。
   * mode='status' 只读状态与版本，不解析详情 payload；无效/损坏缓存以 error 明示。
   * 内容读取按 scopes 选择范围、itemLimit 收口并支持按范围续读游标。
   * task 字段为当前上下文内的真实在途任务快照；无任务为 null。
   */
  readLocal(repositoryId: number, request?: LocalReadRequest): LocalDetailView | null;
  /**
   * 幂等应用清单观察：按 observationId 去重；同事务保存受影响范围的序号、dirty 原因与应用记录。
   * 观察只递增待同步序号，不推进成功同步基线，也不宣布 fresh；跨访问上下文观察不改动账本。
   */
  applyObservation(handoff: ObservationHandoff, appliedAt: string): ObservationApplyOutcome;
  /**
   * 按范围执行同步（显式范围入口）。
   * 步骤 8 剩余能力：当前后台执行由打开 / 强制用例经 domain 计划驱动（构建范围已可执行）；
   * 非构建范围的显式入口与 facade 接线随后续批次提供，当前为 undefined。
   */
  syncScopes?(repositoryId: number, request: ScopeSyncRequest): Promise<ScopeSyncOutcome>;
}

export type { BuildInfo, DetailValues, Glance, Snapshot };
