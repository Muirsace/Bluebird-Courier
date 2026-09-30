import type { SettingsState } from '../../../../domain/types';

/** Settings feature interface. Values are synchronous because storage is local. */
export interface SettingsFeature {
  readAccessToken(): string | null;
  saveAccessToken(token: string): void;
  getSettings(): SettingsState;
  updateSettings(patch: unknown): SettingsState;
}

export type { SettingsState };
