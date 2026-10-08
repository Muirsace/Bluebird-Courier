import type { LocalDatabase } from '../../../core/infra/database';
import type { Snapshot } from '../../../../domain/types';
import type { TrendPoint } from '../contract';
import { listSnapshots, listTrend } from './snapshot-store';

export interface TrendQuery {
  trend(repositoryId: number): TrendPoint[];
  listSnapshots(repositoryId: number): Snapshot[];
}

/** 查询趋势和原始快照，不为缺失日期补造数据。 */
export function createTrendQuery(db: LocalDatabase, now: () => Date): TrendQuery {
  return {
    trend: (repositoryId) => listTrend(db, repositoryId, now()),
    listSnapshots: (repositoryId) => listSnapshots(db, repositoryId, now()),
  };
}

