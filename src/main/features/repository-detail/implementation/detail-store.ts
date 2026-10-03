import type { LocalDatabase } from '../../../core/infra/database';
import type { DetailCache } from '../contract';

export function readDetail(db: LocalDatabase, repositoryId: number): DetailCache | null {
  const row = db.prepare('SELECT payload, fetched_at FROM detail_cache WHERE repository_id = ?').get(repositoryId) as { payload: string; fetched_at: string } | undefined;
  if (!row) return null;
  try { return { ...(JSON.parse(row.payload) as DetailCache), fetchedAt: row.fetched_at }; } catch { return null; }
}

export function writeDetail(db: LocalDatabase, cache: DetailCache): void {
  const write = db.transaction(() => {
    db.prepare('INSERT INTO detail_cache (repository_id, payload, fetched_at, source_updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(repository_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, source_updated_at = excluded.source_updated_at')
      .run(cache.repositoryId, JSON.stringify(cache), cache.fetchedAt, cache.fetchedAt);
    const upsert = db.prepare('INSERT INTO detail_column (repository_id, column_name, state, payload, error_kind, error_message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, column_name) DO UPDATE SET state = excluded.state, payload = excluded.payload, error_kind = excluded.error_kind, error_message = excluded.error_message, updated_at = excluded.updated_at');
    for (const [name, column] of Object.entries(cache.columns)) {
      upsert.run(cache.repositoryId, name, column?.status ?? 'unsupported', column?.value === null || column?.value === undefined ? null : JSON.stringify(column.value), column?.error?.kind ?? null, column?.error?.message ?? null, cache.fetchedAt);
    }
  });
  write();
}

export function deleteDetail(db: LocalDatabase, repositoryId: number): void {
  db.prepare('DELETE FROM detail_cache WHERE repository_id = ?').run(repositoryId);
  db.prepare('DELETE FROM detail_column WHERE repository_id = ?').run(repositoryId);
}

export function clearDetails(db: LocalDatabase): void {
  db.prepare('DELETE FROM detail_cache').run();
  db.prepare('DELETE FROM detail_column').run();
}
