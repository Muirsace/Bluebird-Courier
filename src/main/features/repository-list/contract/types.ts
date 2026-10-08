import type { Glance, GlanceValues, RepoInputResult, NormalizedError, FetchedGlance, ObservationHandoff } from '../../../../domain/types';
import type { RepositoryRef } from '../../../../domain/ports';

export interface AddRepositoryInput {
  fullName: string;
  token: string;
}

export interface AddRepositoryResult {
  ok: boolean;
  repository: Glance | null;
  error: NormalizedError | null;
}

export interface RefreshRepositoryResult {
  repository: Glance;
  error: NormalizedError | null;
}

export interface RefreshBatchResult {
  repositories: Glance[];
  errors: NormalizedError[];
  stopped: boolean;
  nextCursor: number | null;
}

export type RepositoryListFailureSource = 'input' | 'fetch' | 'persistence' | 'batch';

export interface RepositoryCheckOutcome {
  repositories: Glance[];
  errors: NormalizedError[];
  /** Token 无效或限流时停止后续仓库的检查。 */
  stopped: boolean;
  stopReason: 'access_token_invalid' | 'rate_limited' | null;
  /** 本次成功观察（真实观察时间与摘要值）；供 facade 编排趋势采样。 */
  observed: ObservedSummaryRecord[];
  skipped?: boolean;
}

/** 单仓库检查结果（重试入口与批量共用同一去重机制）。 */
export interface RepositorySingleCheckOutcome {
  repository: Glance | null;
  error: NormalizedError | null;
  observed: ObservedSummaryRecord | null;
}

/** 一次成功观察的摘要记录；observedAt 是真实观察时间，不是调用时间。 */
export interface ObservedSummaryRecord {
  observationId: string;
  repositoryId: number;
  accessContextRevision: number;
  observedAt: string;
  values: GlanceValues;
}

export interface RepositoryListService {
  /** 每次真实新增观察分配一次来源身份，重复交付复用此值。 */
  newObservationId(): string;
  /** 单仓库真实观察提交后立即通知；不能等批量结果回包才确定同毫秒顺序。 */
  onObservation(listener: (observation: ObservedSummaryRecord) => void): void;
  /** 从持久进度继续读取并隔离坏结构；每批有界。完成/失败均推进，队尾回绕重试。 */
  nextObservationReplayPage(limit: number, accessContextRevision: number, repositoryId?: number): { observations: ObservationHandoff[]; reachedEnd: boolean };
  inspectInput(input: unknown): RepoInputResult;
  list(): Glance[];
  findById(id: number): Glance | null;
  findByFullName(fullName: string): Glance | null;
  createPending(fullName: string): Glance;
  applyGlance(id: number, values: GlanceValues): Glance;
  applyObservedSummary(id: number, values: GlanceValues, observedAt: string, accessContextRevision: number): Glance | null;
  markFailure(id: number, error: NormalizedError): Glance;
  add(values: FetchedGlance): Glance;
  remove(id: unknown): { removed: boolean; fullName?: string };
  clear(): void;
  /**
   * 全部仓库的轻量检查（启动一次 / 手动检查共用）。
   * 只做归一化观察与摘要更新；未查看仓库不抓取详情。
   */
  checkRepositories(accessToken: string, accessContextRevision: number, origin?: 'startup' | 'manual'): Promise<RepositoryCheckOutcome>;
  /** 单仓库检查（重试入口）；与批量检查共用去重登记。 */
  checkRepository(repositoryId: number, accessToken: string, accessContextRevision: number): Promise<RepositorySingleCheckOutcome>;
  /** 读取待交接的清单观察（按检测时间升序，最多 limit 条）；不含已被隔离的损坏记录。 */
  pendingObservations(limit?: number, filter?: { repositoryId?: number; accessContextRevision?: number; afterObservationId?: string }): ObservationHandoff[];
  /**
   * 有界扫描未确认交接并隔离结构中不可修复的损坏记录（含无法解析的 JSON）。
   * 已隔离记录不再重复扫描，进度可跨调用累积；可重试失败保持待交接。
   */
  quarantineInvalidObservations(limit?: number, filter?: { repositoryId?: number; afterObservationId?: string }): { scanned: number; quarantined: number; lastScannedObservationId: string | null };
  /** 确认某条观察已由详情应用（幂等；重复确认或不存在返回 false）。 */
  confirmObservationHandoff(observationId: string): boolean;
  /** 详情 feature 所需的仓库窄引用；默认分支来自最近一次成功观察的已知信号，未知为 null。 */
  findReference(repositoryId: number): RepositoryRef | null;
}
