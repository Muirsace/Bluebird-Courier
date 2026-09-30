import { nativeTheme } from 'electron';
import { normalizeThemePreference, THEME_PREFERENCE_KEY } from '../../../domain/rules/theme';

/**
 * 把持久化的主题偏好落到 Electron。
 * themeSource 决定原生部分（窗口边框、系统对话框、表单控件）以及渲染层的
 * prefers-color-scheme，所以必须在建窗口之前调用，避免首屏先按系统主题画一帧。
 */
export function applyThemeSource(preferences: Record<string, string>): void {
  nativeTheme.themeSource = normalizeThemePreference(preferences[THEME_PREFERENCE_KEY]);
}
