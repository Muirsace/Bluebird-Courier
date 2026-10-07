import type { AccessContextPort } from '../../../../domain/ports';
import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { GlanceValues } from '../../../../domain/types';
import type { SnapshotTrendService } from '../contract';
import { createRetentionRunner } from './retention-runner';
import { createSnapshotRecorder } from './record-snapshot';
import { createTrendQuery } from './trend-query';
import { readLocalTrend, readLocalTrendState } from './snapshot-store';

export interface SnapshotTrendDependencies { db: LocalDatabase; clock: Clock; accessContext: AccessContextPort }

export function createSnapshotTrendService({ db, clock, accessContext }: SnapshotTrendDependencies): SnapshotTrendService {
  const recorder = createSnapshotRecorder(db);
  const retention = createRetentionRunner(db);
  const query = createTrendQuery(db);
  const record = (repositoryId: number, values: GlanceValues, capturedAt = clock.now()): void => {
    const write = db.transaction(() => {
      recorder.record(repositoryId, values, capturedAt, accessContext.currentRevision());
      retention.retain(repositoryId, capturedAt);
    });
    write();
  };
  const recordObserved = (repositoryId: number, values: GlanceValues, observedAt: string | Date): void => {
    record(repositoryId, values, observedAt instanceof Date ? observedAt : new Date(observedAt));
  };
  const retain = (repositoryId?: number, now = clock.now()): void => retention.retain(repositoryId, now);
  return { record, recordObserved, retain, trend: query.trend, localCacheState: (id) => readLocalTrendState(db, id, accessContext.currentRevision()), readLocalPage: (id, offset, limit) => readLocalTrend(db, id, offset, limit, accessContext.currentRevision()), listSnapshots: query.listSnapshots, remove: retention.remove, clear: retention.clear };
}
