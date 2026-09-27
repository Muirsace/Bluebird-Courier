/**
 * 主题契约：主进程校验入库值，渲染层据此算最终主题，两端共用同一套判定。
 */

/** 用户偏好：跟随系统 / 强制浅色 / 强制深色。 */
export type ThemePreference = 'system' | 'light' | 'dark';

/** 最终生效的主题。 */
export type EffectiveTheme = 'light' | 'dark';

/** 主题偏好在 setting 表 pref: 命名空间下的键名。 */
export const THEME_PREFERENCE_KEY = 'theme';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** 非法值与缺失一律回退 system。 */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

/** 强制值优先；只有 system 才看系统当前主题。 */
export function resolveEffectiveTheme(
  preference: ThemePreference,
  systemTheme: EffectiveTheme,
): EffectiveTheme {
  return preference === 'system' ? systemTheme : preference;
}
