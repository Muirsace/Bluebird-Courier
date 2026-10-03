import type { LocalDatabase } from '../../../core/infra/database';
import { isPositiveId, readRow } from './repository-list-store';

export function deleteRepository(db: LocalDatabase, id: unknown): { removed: boolean; fullName?: string } {
  if (!isPositiveId(id)) return { removed: false };
  const row = readRow(db, id);
  if (!row) return { removed: false };
  db.prepare('DELETE FROM repository WHERE id = ?').run(id);
  return { removed: true, fullName: row.full_name };
}

export function clearRepositories(db: LocalDatabase): void {
  db.prepare('DELETE FROM repository').run();
}
