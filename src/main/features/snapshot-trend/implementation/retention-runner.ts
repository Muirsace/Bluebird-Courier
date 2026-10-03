import type { LocalDatabase } from '../../../core/infra/database';
import { deleteExpired } from './snapshot-store';

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
      db.prepare('DELETE FROM snapshot WHERE repository_id = ?').run(repositoryId);
    },
    clear() {
      db.prepare('DELETE FROM snapshot').run();
    },
  };
}

