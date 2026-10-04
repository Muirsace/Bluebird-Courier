import { nativeTheme } from 'electron';

/** 在创建窗口和切换外观时应用 Electron 主题来源。 */
export function applyThemeSource(preferences: Record<string, string>): void {
  const preference = preferences.theme;
  nativeTheme.themeSource = preference === 'light' || preference === 'dark' ? preference : 'system';
}
