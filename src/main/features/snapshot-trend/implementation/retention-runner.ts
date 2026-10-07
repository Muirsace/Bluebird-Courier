import type { LocalDatabase } from '../../../core/infra/database';
import { bumpSnapshotViewVersion, deleteExpired } from './snapshot-store';

export interface RetentionRunner {
  retain(repositoryId?: number, now?: Date): void;
  remove(repositoryId: number): void;
  clear(): void;
}

/** 执行快照自然日保留和资料清理。 */
export function createRetentionRunner(db: LocalDatabase): RetentionRunner {
  return {
    retain(repositoryId, now = new Date()) {
      deleteExpired(db, repositoryId, now);
    },
    remove(repositoryId) {
      db.transaction(() => {
        if (db.prepare('DELETE FROM snapshot WHERE repository_id = ?').run(repositoryId).changes > 0) bumpSnapshotViewVersion(db, repositoryId);
      })();
    },
    clear() {
      db.transaction(() => {
        db.prepare('UPDATE snapshot_view_state SET view_version = view_version + 1 WHERE repository_id IN (SELECT DISTINCT repository_id FROM snapshot)').run();
        db.prepare('DELETE FROM snapshot').run();
      })();
    },
  };
}

