import type { LocalDatabase } from '../../../core/infra/database';
import type { Glance } from '../../../../domain/types';
import { compareResolvedActivity } from '../../../../domain/rules/activity-sort';
import { isPositiveId, readRow, readRowByFullName, rowToGlance } from './repository-list-store';

export function listRepositories(db: LocalDatabase): Glance[] {
  const rows = db.prepare('SELECT * FROM repository').all() as Parameters<typeof rowToGlance>[0][];
  return rows
    .map(rowToGlance)
    .sort((a, b) =>
      // 尚未成功取得摘要的新增卡片独立置顶；普通清单只按真实活动排序。
      Number(b.lastSucceededAt === null) - Number(a.lastSucceededAt === null) ||
      compareResolvedActivity(
        { at: a.activityAt ?? null, kind: a.activityKind ?? null },
        { at: b.activityAt ?? null, kind: b.activityKind ?? null },
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
