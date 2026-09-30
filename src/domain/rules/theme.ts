import type { EffectiveTheme, ThemePreference } from '../types';

export const THEME_PREFERENCE_KEY = 'theme';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** Invalid or missing preferences use the system theme. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

/** Forced values win; system delegates to the current OS theme. */
export function resolveEffectiveTheme(
  preference: ThemePreference,
  systemTheme: EffectiveTheme,
): EffectiveTheme {
  return preference === 'system' ? systemTheme : preference;
}
