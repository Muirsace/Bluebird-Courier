import { nativeTheme } from 'electron';
import type { BrowserWindow, BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron';

// DIP, aligned with the existing 52px Desktop sidebar brand row.
const WINDOW_CONTROLS_HEIGHT = 52;

function shouldUseDarkWindowChrome(): boolean {
  return nativeTheme.themeSource === 'dark'
    || (nativeTheme.themeSource === 'system' && nativeTheme.shouldUseDarkColors);
}

function titleBarOverlay(): Required<TitleBarOverlayOptions> {
  // Match renderer tokens: --color-app and --color-text in styles/tokens.css.
  const dark = shouldUseDarkWindowChrome();
  return {
    height: WINDOW_CONTROLS_HEIGHT,
    color: dark ? '#020617' : '#f5f7fa',
    symbolColor: dark ? '#f1f5f9' : '#172033',
  };
}

export function windowsWindowChromeOptions(): BrowserWindowConstructorOptions {
  if (process.platform !== 'win32') return {};
  const overlay = titleBarOverlay();
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay,
    backgroundColor: overlay.color,
  };
}

/** Updates the Windows overlay synchronously after a theme source change. */
export function refreshWindowsWindowChrome(window: BrowserWindow): void {
  if (process.platform !== 'win32') return;
  if (window.isDestroyed()) return;
  const overlay = titleBarOverlay();
  window.setTitleBarOverlay(overlay);
  window.setBackgroundColor(overlay.color);
}

/** Theme source remains owned by applyThemeSource; each window owns its listener. */
export function syncWindowsWindowChrome(window: BrowserWindow): void {
  if (process.platform !== 'win32') return;
  const update = (): void => refreshWindowsWindowChrome(window);
  nativeTheme.on('updated', update);
  window.once('closed', () => nativeTheme.removeListener('updated', update));
  update();
}
