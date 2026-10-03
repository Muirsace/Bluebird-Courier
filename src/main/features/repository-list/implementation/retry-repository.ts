import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Glance, NormalizedError } from '../../../../domain/types';
import { readRow, rowToGlance } from './repository-list-store';

export function markRepositoryFailure(db: LocalDatabase, clock: Clock, id: number, error: NormalizedError): Glance {
  if (!readRow(db, id)) throw new Error(`监控仓库不存在：${id}`);
  db.prepare('UPDATE repository SET last_error_kind = ?, last_error_message = ?, last_attempt_at = ? WHERE id = ?').run(error.kind, error.message, clock.now().toISOString(), id);
  return rowToGlance(readRow(db, id)!);
}
