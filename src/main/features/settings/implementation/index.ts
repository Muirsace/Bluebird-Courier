import type { PortFailure } from '../../../../domain/ports';
import { PortFailure as PortFailureClass } from '../../../../domain/ports';
import { normalizeThemePreference, THEME_PREFERENCE_KEY } from '../../../../domain/rules/theme';
import type { SettingsState } from '../../../../domain/types';
import type { CipherBox } from '../../../core/infra/cipher';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Logger } from '../../../core/infra/logger';
import type { SettingsFeature } from '../contract';

const ACCESS_TOKEN_KEY = 'access_token';
const PREFERENCE_PREFIX = 'pref:';
const CIPHER_READ_ERROR = '无法读取访问令牌状态，请稍后重试';
const CIPHER_SAVE_ERROR = '系统安全存储不可用，无法保存访问令牌';

export interface SettingsDependencies {
  db: LocalDatabase;
  cipher: CipherBox;
  logger?: Logger;
}

function rawSetting(db: LocalDatabase, key: string): string | null {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeSetting(db: LocalDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function readPreferences(db: LocalDatabase): Record<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM setting WHERE key LIKE ?')
    .all(`${PREFERENCE_PREFIX}%`) as Array<{ key: string; value: string }>;
  const preferences: Record<string, string> = {};
  for (const row of rows) preferences[row.key.slice(PREFERENCE_PREFIX.length)] = row.value;
  if (THEME_PREFERENCE_KEY in preferences) {
    preferences[THEME_PREFERENCE_KEY] = normalizeThemePreference(preferences[THEME_PREFERENCE_KEY]);
  }
  return preferences;
}

function validPatch(patch: unknown): Record<string, string> | null {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return null;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'string') return null;
    cleaned[key] = value;
  }
  if (THEME_PREFERENCE_KEY in cleaned) {
    cleaned[THEME_PREFERENCE_KEY] = normalizeThemePreference(cleaned[THEME_PREFERENCE_KEY]);
  }
  return cleaned;
}

function translatedCipherFailure(message: string, cause: unknown): PortFailure {
  const failure = new PortFailureClass('unknown', message);
  // Preserve the original failure for an optional logger without exposing
  // provider/platform details through the feature interface.
  if (cause instanceof Error && cause.stack) failure.stack = `${failure.stack}\nCaused by: ${cause.stack}`;
  return failure;
}

export function createSettings({ db, cipher, logger }: SettingsDependencies): SettingsFeature {
  const readAccessToken = (): string | null => {
    const raw = rawSetting(db, ACCESS_TOKEN_KEY);
    if (raw === null) return null;
    try {
      return cipher.decrypt(raw);
    } catch (error) {
      logger?.error(CIPHER_READ_ERROR, error);
      // A corrupt old ciphertext behaves as an unavailable configuration. The
      // caller can then ask the user to save a fresh token.
      return null;
    }
  };

  const saveAccessToken = (token: string): void => {
    let encrypted: string;
    try {
      encrypted = cipher.encrypt(token);
    } catch (error) {
      logger?.error(CIPHER_SAVE_ERROR, error);
      throw translatedCipherFailure(CIPHER_SAVE_ERROR, error);
    }
    writeSetting(db, ACCESS_TOKEN_KEY, encrypted);
  };

  const getSettings = (): SettingsState => ({
    preferences: readPreferences(db),
    accessTokenConfigured: readAccessToken() !== null,
  });

  const updateSettings = (patch: unknown): SettingsState => {
    const cleaned = validPatch(patch);
    if (cleaned === null) {
      logger?.error('忽略格式非法的偏好项补丁（值必须是字符串）', patch);
      return getSettings();
    }
    const upsert = db.prepare(
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const write = db.transaction(() => {
      for (const [key, value] of Object.entries(cleaned)) upsert.run(`${PREFERENCE_PREFIX}${key}`, value);
    });
    write();
    return getSettings();
  };

  return { readAccessToken, saveAccessToken, getSettings, updateSettings };
}

export type { SettingsFeature } from '../contract';
