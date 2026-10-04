import type { LocalDatabase } from '../../../core/infra/database';
import type { Glance } from '../../../../domain/types';
import { compareActivity } from '../../../../domain/rules/activity-sort';
import { isPositiveId, readRow, readRowByFullName, rowToGlance } from './repository-list-store';

export function listRepositories(db: LocalDatabase): Glance[] {
  const rows = db.prepare('SELECT * FROM repository').all() as Parameters<typeof rowToGlance>[0][];
  return rows
    .map(rowToGlance)
    .sort((a, b) =>
      compareActivity(
        // 无活动数据（如抓取失败的卡片）按加入时间参与排序，保持刚加入的可见性。
        { code: a.activityAt ?? a.addedAt, collaboration: a.collaborationAt },
        { code: b.activityAt ?? b.addedAt, collaboration: b.collaborationAt },
      ) || b.id - a.id,
    );
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
