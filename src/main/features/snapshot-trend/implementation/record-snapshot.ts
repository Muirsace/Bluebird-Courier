import type { GlanceValues } from '../../../../domain/types';
import type { LocalDatabase } from '../../../core/infra/database';
import { recordSnapshot as writeSnapshot } from './snapshot-store';

export interface SnapshotRecorder {
  record(repositoryId: number, values: GlanceValues, capturedAt: Date, accessContextRevision: number): void;
}

/** 写入仓库当天的最后一档快照。事务由 service 统一控制。 */
export function createSnapshotRecorder(db: LocalDatabase): SnapshotRecorder {
  return {
    record(repositoryId, values, capturedAt, accessContextRevision) {
      writeSnapshot(db, repositoryId, values, capturedAt, accessContextRevision);
    },
  };
}

