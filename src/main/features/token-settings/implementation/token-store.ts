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

export { ACCESS_TOKEN_KEY };
