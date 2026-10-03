import type { LocalDatabase } from '../../../core/infra/database';
import type { Glance } from '../../../../domain/types';
import { isPositiveId, readRow, readRowByFullName, rowToGlance } from './repository-list-store';

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function listRepositories(db: LocalDatabase): Glance[] {
  const rows = db.prepare('SELECT * FROM repository').all() as Parameters<typeof rowToGlance>[0][];
  return rows
    .map(rowToGlance)
    .sort((a, b) => {
      const aActivity = Math.max(timestamp(a.pushedAt), timestamp(a.fetchedAt), timestamp(a.addedAt));
      const bActivity = Math.max(timestamp(b.pushedAt), timestamp(b.fetchedAt), timestamp(b.addedAt));
      return bActivity - aActivity || b.id - a.id;
    });
}

export function findRepositoryById(db: LocalDatabase, id: number): Glance | null {
  if (!isPositiveId(id)) return null;
  const row = readRow(db, id);
  return row ? rowToGlance(row) : null;
}

export function findRepositoryByFullName(db: LocalDatabase, fullName: string): Glance | null {
  const row = readRowByFullName(db, fullName);
  return row ? rowToGlance(row) : null;
}
