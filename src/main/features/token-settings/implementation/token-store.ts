import type { LocalDatabase } from '../../../core/infra/database';
import type { CipherBox } from '../../../core/infra/encryption';

const ACCESS_TOKEN_KEY = 'access_token';
const PREFERENCE_PREFIX = 'pref:';

export function readToken(db: LocalDatabase, cipher: CipherBox): string | null {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(ACCESS_TOKEN_KEY) as { value: string } | undefined;
  if (!row) return null;
  try { return cipher.decrypt(row.value); } catch { return null; }
}

export function writeToken(db: LocalDatabase, cipher: CipherBox, token: string): void {
  const encrypted = cipher.encrypt(token);
  db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ACCESS_TOKEN_KEY, encrypted);
}

export function readPreferences(db: LocalDatabase): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM setting WHERE key LIKE ?').all(`${PREFERENCE_PREFIX}%`) as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key.slice(PREFERENCE_PREFIX.length), row.value]));
}

export function writePreferences(db: LocalDatabase, patch: Record<string, string>): void {
  const upsert = db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const transaction = db.transaction(() => { for (const [key, value] of Object.entries(patch)) upsert.run(`${PREFERENCE_PREFIX}${key}`, value); });
  transaction();
}

/** 当前访问上下文版本；旧库升级后首行为 0（初始上下文）。 */
export function readAccessContextRevision(db: LocalDatabase): number {
  const row = db.prepare('SELECT revision FROM access_context WHERE id = 1').get() as { revision: number } | undefined;
  return row?.revision ?? 0;
}

/** 推进访问上下文版本（成功更换令牌后调用）；在事务内自增并返回新版本。 */
export function advanceAccessContextRevision(db: LocalDatabase, updatedAt: string): number {
  const advance = db.transaction(() => {
    db.prepare(
      'INSERT INTO access_context (id, revision, updated_at) VALUES (1, 1, ?) ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at',
    ).run(updatedAt);
    return readAccessContextRevision(db);
  });
  return advance();
}

export { ACCESS_TOKEN_KEY };
