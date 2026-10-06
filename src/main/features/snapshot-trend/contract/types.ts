import type { GlanceValues, Snapshot } from '../../../../domain/types';

export interface TrendPoint {
  capturedAt: string;
  stars: number | null;
  forks: number | null;
}

export interface SnapshotTrendService {
  /**
   * 兼容保留的历史入口：缺省以调用时刻记档。
   * 缓存复用场景仍会调用它（步骤 9 收口）；新代码应使用 recordObserved。
   */
  record(repositoryId: number, values: GlanceValues, capturedAt?: Date): void;
  /** 记录一次真实观察；观察时间由调用方提供，缓存复用不得调用。 */
  recordObserved(repositoryId: number, values: GlanceValues, observedAt: string | Date): void;
  retain(repositoryId?: number, now?: Date): void;
  trend(repositoryId: number): TrendPoint[];
  listSnapshots(repositoryId: number): Snapshot[];
  remove(repositoryId: number): void;
  clear(): void;
}
