import type { AccessContextPort } from '../../../../domain/ports';
import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { GlanceValues } from '../../../../domain/types';
import type { SamplingRecoveryOutcome, SnapshotTrendService } from '../contract';
import { createRetentionRunner } from './retention-runner';
import { createSnapshotRecorder } from './record-snapshot';
import { createTrendQuery } from './trend-query';
import {
  countPendingSnapshots,
  deletePendingSnapshot,
  registerSnapshotObservation,
  normalizeGlanceValues,
  parseObservationTime,
  readPendingSnapshotByIdentity,
  type PendingSnapshotEntry,
  isExpiredObservationDay,
  maxPendingSnapshotRowId,
  pendingSnapshotIdentity,
  pendingSnapshotRepositoryExists,
  readLocalTrend,
  readLocalTrendState,
  readPendingSnapshotCursor,
  readPendingSnapshots,
  writePendingSnapshotCursor,
} from './snapshot-store';

export interface SnapshotTrendDependencies { db: LocalDatabase; clock: Clock; accessContext: AccessContextPort }

/** 单次补偿的缺省批次与上限：有界，不做无界失败重试。 */
const RECOVERY_BATCH_DEFAULT = 50;
const RECOVERY_BATCH_MAX = 500;

export function createSnapshotTrendService({ db, clock, accessContext }: SnapshotTrendDependencies): SnapshotTrendService {
  const recorder = createSnapshotRecorder(db);
  const retention = createRetentionRunner(db);
  const query = createTrendQuery(db, () => clock.now());

  /** 所有写入路径共用事务；过期与损坏只删意图，保留维护同样执行。 */
  const writeAndClear = (entry: PendingSnapshotEntry): 'recovered' | 'discarded' => {
    const now = clock.now();
    const at = parseObservationTime(entry.observedAt);
    const valid = entry.values !== null && at !== null && !isExpiredObservationDay(at, now) &&
      entry.accessContextRevision === accessContext.currentRevision() && pendingSnapshotRepositoryExists(db, entry.repositoryId);
    return db.transaction(() => {
      if (valid) recorder.record(entry.repositoryId, entry.values!, at!, entry.accessContextRevision, entry.sequence);
      retention.retain(undefined, now);
      deletePendingSnapshot(db, entry.identity);
      return valid ? 'recovered' : 'discarded';
    })();
  };

  /** 来源身份去重与持久序号登记在一个事务；重复交付重试原意图，不改原值和顺序。 */
  const registerObserved = (repositoryId: number, values: GlanceValues, observedAt: string | Date, observationId?: string): string | null => {
    const at = parseObservationTime(observedAt);
    const normalized = normalizeGlanceValues(values);
    if (at === null || normalized === null) return null;
    const revision = accessContext.currentRevision();
    const identity = observationId === undefined
      ? pendingSnapshotIdentity(repositoryId, at, revision, normalized)
      : JSON.stringify([repositoryId, revision, observationId]);
    if (observationId !== undefined && (typeof observationId !== 'string' || observationId.length === 0)) return null;
    if (isExpiredObservationDay(at, clock.now())) { retention.retain(undefined, clock.now()); return null; }
    registerSnapshotObservation(db, { identity, repositoryId, accessContextRevision: revision, observedAt: at.toISOString(), values: normalized, createdAt: clock.now().toISOString() });
    return identity;
  };

  const recordObserved = (repositoryId: number, values: GlanceValues, observedAt: string | Date, observationId?: string): void => {
    const identity = registerObserved(repositoryId, values, observedAt, observationId);
    if (identity === null) return;
    const entry = readPendingSnapshotByIdentity(db, identity);
    if (!entry) return;
    try { writeAndClear(entry); } catch {
      // 意图已持久化，写入或保留失败可在重启后继续补偿，不回滚摘要。
    }
  };

  // 兼容入口与真实观察同一条可靠采样路径；缺省以调用时刻作为观察时间。
  const record = (repositoryId: number, values: GlanceValues, capturedAt = clock.now()): void => {
    recordObserved(repositoryId, values, capturedAt);
  };

  /**
   * 有界补偿：只写登记过的真实样本与观察时间，不发 HTTP、不刷新采样时间、不覆盖同日更新的样本。
   * 采用可恢复游标：从上次处理位置继续，瞬时失败前缀不会每次从头占用预算；
   * 走到队尾后回到起点，此前因事务失败而保留的意图可以再次重试。
   * 结构损坏、字段非法、过期、换访问上下文或仓库已删的意图按身份丢弃。
   */
  const recoverPendingSampling = (maxBatch = RECOVERY_BATCH_DEFAULT): SamplingRecoveryOutcome => {
    const budget = Number.isFinite(maxBatch)
      ? Math.min(RECOVERY_BATCH_MAX, Math.max(1, Math.floor(maxBatch)))
      : RECOVERY_BATCH_DEFAULT;
    retention.retain(undefined, clock.now());
    let cursor = readPendingSnapshotCursor(db);
    let batch = readPendingSnapshots(db, cursor, budget);
    if (batch.length === 0 && cursor !== 0) {
      // 已到队尾：回到起点，给此前失败的意图留出重试机会。
      writePendingSnapshotCursor(db, 0);
      cursor = 0;
      batch = readPendingSnapshots(db, 0, budget);
    }
    let recovered = 0;
    let failed = 0;
    let discarded = 0;
    for (const entry of batch) {
      try {
        const outcome = writeAndClear(entry);
        if (outcome === 'recovered') recovered += 1;
        else discarded += 1;
      } catch {
        // 数据损坏删除和保留失败也是事务失败，不能宣称已丢弃或已恢复。
        failed += 1;
      }
    }
    if (batch.length > 0) {
      const last = batch[batch.length - 1]!.rowId;
      const reachedEnd = batch.length < budget || last >= maxPendingSnapshotRowId(db);
      writePendingSnapshotCursor(db, reachedEnd ? 0 : last);
    }
    return { recovered, failed, discarded, remaining: countPendingSnapshots(db) };
  };

  const retain = (repositoryId?: number, now = clock.now()): void => retention.retain(repositoryId, now);
  return {
    record,
    recordObserved,
    stageObserved: (repositoryId, values, observedAt, observationId) => { registerObserved(repositoryId, values, observedAt, observationId); },
    commitStagedObservation(repositoryId, observationId) {
      const identity = JSON.stringify([repositoryId, accessContext.currentRevision(), observationId]);
      if (!db.prepare('SELECT 1 FROM snapshot_observation WHERE identity = ?').get(identity)) {
        throw new Error('真实采样观察未成功登记，本次批次不能补造先后顺序');
      }
      const entry = readPendingSnapshotByIdentity(db, identity);
      if (!entry) return; // 同一来源已经提交完成，重复交付不制造新样本。
      try { writeAndClear(entry); } catch {
        // 登记事实已落盘，写入失败保持原身份和顺序供后续补偿。
      }
    },
    recoverPendingSampling,
    retain,
    trend: query.trend,
    localCacheState: (id) => readLocalTrendState(db, id, accessContext.currentRevision(), clock.now()),
    readLocalPage: (id, offset, limit) => readLocalTrend(db, id, offset, limit, accessContext.currentRevision(), clock.now()),
    listSnapshots: query.listSnapshots,
    remove: retention.remove,
    clear: retention.clear,
  };
}
