import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const theme = vi.hoisted(() => ({ shouldUseDarkColors: false, themeSource: 'system' }));
const events = new EventEmitter();
vi.mock('electron', () => ({
  nativeTheme: Object.assign(theme, {
    on: (...args: Parameters<typeof events.on>) => events.on(...args),
    removeListener: (...args: Parameters<typeof events.removeListener>) => events.removeListener(...args),
  }),
}));
import { refreshWindowsWindowChrome, syncWindowsWindowChrome, windowsWindowChromeOptions } from '../../src/main/core/adapters/window-chrome';
import { applyThemeSource } from '../../src/main/core/adapters/theme';

function createWindow() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    setTitleBarOverlay: vi.fn(),
    setBackgroundColor: vi.fn(),
  });
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  theme.shouldUseDarkColors = false;
  theme.themeSource = 'system';
});
afterEach(() => {
  events.removeAllListeners();
  vi.restoreAllMocks();
});

describe('Windows native window chrome', () => {
  it('enables the overlay at creation using the effective theme, without disabling the frame', () => {
    expect(windowsWindowChromeOptions()).toEqual({
      titleBarStyle: 'hidden',
      backgroundColor: '#f5f7fa',
      titleBarOverlay: { height: 52, color: '#f5f7fa', symbolColor: '#172033' },
    });
    theme.shouldUseDarkColors = true;
    expect(windowsWindowChromeOptions().titleBarOverlay).toEqual({
      height: 52, color: '#020617', symbolColor: '#f1f5f9',
    });
  });

  it.each(['darwin', 'linux'] as const)('leaves %s options and theme listeners unchanged', platform => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const window = createWindow();
    expect(windowsWindowChromeOptions()).toEqual({});
    syncWindowsWindowChrome(window as unknown as BrowserWindow);
    events.emit('updated');
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(events.listenerCount('updated')).toBe(0);
  });

  it('updates an existing window on Light/Dark/System changes and OS theme updates', () => {
    const window = createWindow();
    syncWindowsWindowChrome(window as unknown as BrowserWindow);
    for (const [source, dark] of [
      ['light', false], ['dark', true], ['light', false],
      ['system', false], ['system', true], ['light', false], ['system', true], ['dark', true],
    ] as const) {
      applyThemeSource({ theme: source });
      expect(theme.themeSource).toBe(source);
      // Electron derives this value and emits updated after themeSource/OS changes.
      theme.shouldUseDarkColors = dark;
      events.emit('updated');
      expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({
        height: 52, color: dark ? '#020617' : '#f5f7fa', symbolColor: dark ? '#f1f5f9' : '#172033',
      });
      expect(window.setBackgroundColor).toHaveBeenLastCalledWith(dark ? '#020617' : '#f5f7fa');
    }
  });

  it('repaints forced Light/Dark colors synchronously before nativeTheme.updated', () => {
    const window = createWindow();
    syncWindowsWindowChrome(window as unknown as BrowserWindow);
    window.setTitleBarOverlay.mockClear();
    window.setBackgroundColor.mockClear();

    applyThemeSource({ theme: 'dark' });
    refreshWindowsWindowChrome(window as unknown as BrowserWindow);

    expect(window.setTitleBarOverlay).toHaveBeenCalledWith({
      height: 52, color: '#020617', symbolColor: '#f1f5f9',
    });
    expect(window.setBackgroundColor).toHaveBeenCalledWith('#020617');
    expect(window.setTitleBarOverlay).toHaveBeenCalledOnce();
  });

  it('guards destroyed windows and removes only the closed window listener', () => {
    const first = createWindow();
    const second = createWindow();
    syncWindowsWindowChrome(first as unknown as BrowserWindow);
    syncWindowsWindowChrome(second as unknown as BrowserWindow);
    first.isDestroyed.mockReturnValue(true);
    first.setTitleBarOverlay.mockClear();
    events.emit('updated');
    expect(first.setTitleBarOverlay).not.toHaveBeenCalled();
    first.emit('closed');
    expect(events.listenerCount('updated')).toBe(1);
    second.setTitleBarOverlay.mockClear();
    events.emit('updated');
    expect(second.setTitleBarOverlay).toHaveBeenCalledOnce();
    second.emit('closed');
    expect(events.listenerCount('updated')).toBe(0);
  });
});
