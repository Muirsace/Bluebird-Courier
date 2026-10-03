import { normalizeRepositoryIdentity } from '../../../../domain/rules/repository-identity';
import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { FetchedGlance, Glance, RepoInputResult } from '../../../../domain/types';
import { insertFetched, readRow, rowToGlance } from './repository-list-store';

export function inspectRepositoryInput(input: unknown): RepoInputResult {
  const result = normalizeRepositoryIdentity(typeof input === 'string' ? input : '');
  return result.ok ? { ok: true, owner: result.owner, name: result.name } : result;
}

export function createPendingRepository(db: LocalDatabase, clock: Clock, fullName: string): Glance {
  const parsed = normalizeRepositoryIdentity(fullName);
  if (!parsed.ok) throw new Error(parsed.message);
  const now = clock.now().toISOString();
  const result = db.prepare('INSERT INTO repository (owner, name, full_name, added_at) VALUES (?, ?, ?, ?)').run(parsed.owner, parsed.name, `${parsed.owner}/${parsed.name}`, now);
  return rowToGlance(readRow(db, Number(result.lastInsertRowid))!);
}

export function addFetchedRepository(db: LocalDatabase, clock: Clock, values: FetchedGlance): Glance {
  const id = insertFetched(db, values, clock.now().toISOString());
  return rowToGlance(readRow(db, id)!);
}
