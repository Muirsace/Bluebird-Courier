import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  listeners: new Map<string, (...args: unknown[]) => void>(),
  windows: [] as Array<{ isMinimized(): boolean; restore(): void; show(): void; focus(): void }>,
}));

vi.mock('electron', () => ({
  app: {
    setName: vi.fn(),
    getName: () => '青鸟信使',
    getPath: () => 'test-app-data',
    setPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    on: (event: string, listener: (...args: unknown[]) => void) => state.listeners.set(event, listener),
    // 暂停首次启动，仅触发真实的重复实例事件处理。
    whenReady: () => new Promise<void>(() => {}),
  },
  BrowserWindow: { getAllWindows: () => state.windows },
  dialog: {},
  safeStorage: {},
  shell: {},
  nativeTheme: {},
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  mkdirSync: vi.fn(),
}));

describe('重复启动恢复已有窗口', () => {
  beforeEach(async () => {
    state.listeners.clear();
    state.windows = [];
    vi.resetModules();
    await import('../../src/main/index');
  });

  it('隐藏窗口在重复启动后变为可见并获得焦点', () => {
    let visible = false;
    let focused = false;
    state.windows = [{
      isMinimized: () => false,
      restore: () => {},
      show: () => { visible = true; },
      focus: () => { focused = visible; },
    }];
    state.listeners.get('second-instance')!();
    expect(visible).toBe(true);
    expect(focused).toBe(true);
  });

  it('最小化窗口在重复启动后恢复并获得焦点', () => {
    let minimized = true;
    let focused = false;
    state.windows = [{
      isMinimized: () => minimized,
      restore: () => { minimized = false; },
      show: () => {},
      focus: () => { focused = !minimized; },
    }];
    state.listeners.get('second-instance')!();
    expect(minimized).toBe(false);
    expect(focused).toBe(true);
  });

  it('窗口尚未创建时，重复启动不会抛出异常', () => {
    expect(() => state.listeners.get('second-instance')!()).not.toThrow();
  });
});
