import type { Glance, GlanceValues, RepoInputResult, NormalizedError, FetchedGlance, ObservationHandoff } from '../../../../domain/types';

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

export interface RepositoryListService {
  inspectInput(input: unknown): RepoInputResult;
  list(): Glance[];
  findById(id: number): Glance | null;
  findByFullName(fullName: string): Glance | null;
  createPending(fullName: string): Glance;
  applyGlance(id: number, values: GlanceValues): Glance;
  markFailure(id: number, error: NormalizedError): Glance;
  add(values: FetchedGlance): Glance;
  remove(id: unknown): { removed: boolean; fullName?: string };
  clear(): void;
  /**
   * 读取待交接的清单观察（按检测时间升序，最多 limit 条）。
   * 由清单 feature 事务保存、facade 取给详情应用；步骤 6 实现（当前为 undefined，不返回空成功）。
   */
  pendingObservations?(limit?: number): ObservationHandoff[];
  /**
   * 确认某条观察已由详情应用（幂等；重复确认或不存在返回 false）。
   * 步骤 6 实现（当前为 undefined）。
   */
  confirmObservationHandoff?(observationId: string): boolean;
}
