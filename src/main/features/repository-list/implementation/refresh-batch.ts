import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Glance, GlanceValues } from '../../../../domain/types';
import { readRow, rowToGlance } from './repository-list-store';
import { writeRepositoryGlance } from './repository-status';

export function applyRepositoryGlance(db: LocalDatabase, clock: Clock, id: number, values: GlanceValues): Glance {
  if (!readRow(db, id)) throw new Error(`监控仓库不存在：${id}`);
  writeRepositoryGlance(db, id, values, clock.now().toISOString());
  return rowToGlance(readRow(db, id)!);
}
