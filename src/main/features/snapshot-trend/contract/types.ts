import type { CacheStatus, GlanceValues, Snapshot } from '../../../../domain/types';

export interface TrendPoint {
  capturedAt: string;
  stars: number | null;
  forks: number | null;
}

/** 有界补偿的结果计数：recovered + failed + discarded 为本批处理量，remaining 为仍在待补偿队列中的数量。 */
export interface SamplingRecoveryOutcome {
  /** 本批成功写入快照并清除意图的数量。 */
  recovered: number;
  /** 本批写入仍失败、意图保留待下次补偿的数量。 */
  failed: number;
  /** 本批丢弃的失效意图数量（仓库已删或访问上下文已变化，不回填）。 */
  discarded: number;
  /** 处理完本批后仍待补偿的意图数量。 */
  remaining: number;
}

export interface SnapshotTrendService {
  /**
   * 兼容保留的历史入口：缺省以调用时刻记档，与 recordObserved 走同一条可靠采样路径。
   * 缓存复用不再调用它——本地读取与缓存命中不产生任何采样。
   */
  record(repositoryId: number, values: GlanceValues, capturedAt?: Date): void;
  /** 真实观察已取得时先登记身份、顺序和意图；不写展示样本，重复登记复用序号。 */
  stageObserved(repositoryId: number, values: GlanceValues, observedAt: string | Date, observationId: string): void;
  /** 提交此前已登记的批次观察；未登记则明确失败，不能晚到时补造观察顺序。 */
  commitStagedObservation(repositoryId: number, observationId: string): void;
  /**
   * 记录一次真实观察：先把采样意图持久化，再尝试写入当天快照。
   * 写入失败时意图保留待补偿（重启后可恢复真实值、观察时间与上下文），不吞掉摘要或 dirty。
   * 整库不可写（意图都无法落盘）时抛出，不声称已持久化。观察时间由调用方提供，缓存复用不得调用。
   * observationId 由真实来源为一次观察分配，重复交付必须复用。
   * 身份只负责去重；同毫秒先后取首次持久登记序号，成功与补偿共用，重启不丢失。
   * 无身份旧调用仅保证时间+内容重试幂等，不能区分同内容同时间的独立观察。
   */
  recordObserved(repositoryId: number, values: GlanceValues, observedAt: string | Date, observationId?: string): void;
  /**
   * 有界补偿先前未写成功的真实采样：只保存登记的观察值 / 观察时间 / 访问上下文，
   * 不发 HTTP、不刷新采样时间、不覆盖同日更新的真实样本；较早样本不覆盖较新样本。
   * 采用可恢复游标，瞬时失败前缀不会永久阻塞后续有效样本；走到队尾后回到起点重试此前失败的意图。
   * 保留窗口按注入时钟的当前时间判定，过期意图安全丢弃；字段非法 / 结构损坏 / 换访问上下文 /
   * 仓库已删的意图按数据损坏丢弃（discarded），只有可重试的写入失败才计入 failed。
   */
  recoverPendingSampling(maxBatch?: number): SamplingRecoveryOutcome;
  retain(repositoryId?: number, now?: Date): void;
  trend(repositoryId: number): TrendPoint[];
  /** 本地趋势版本及有界分页；不访问网络、不刷新采样时间。 */
  localCacheState(repositoryId: number): { viewVersion: number; cacheStatus: CacheStatus; windowKey: string };
  readLocalPage(repositoryId: number, offset: number, limit: number): { points: TrendPoint[]; hasMore: boolean };
  listSnapshots(repositoryId: number): Snapshot[];
  remove(repositoryId: number): void;
  clear(): void;
}
