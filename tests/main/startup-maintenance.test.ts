import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ order: [] as string[], appData: '' }));

vi.mock('electron', () => {
  class StubWindow {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      state.order.push('window');
    }
    loadFile(): Promise<void> { return Promise.resolve(); }
    loadURL(): Promise<void> { return Promise.resolve(); }
    isDestroyed(): boolean { return false; }
    setTitleBarOverlay(): void {}
    setBackgroundColor(): void {}
    once(): void {}
    on(): void {}
    static getAllWindows(): StubWindow[] { return []; }
  }
  return {
    app: {
      setName: () => {},
      getName: () => '青鸟信使',
      getPath: () => state.appData,
      setPath: () => {},
      requestSingleInstanceLock: () => true,
      on: () => {},
      whenReady: () => Promise.resolve(),
      quit: () => {},
      exit: () => {},
      isPackaged: false,
      getAppPath: () => process.cwd(),
    },
    BrowserWindow: StubWindow,
    // 启动期不应弹错框：把失败记录下来供断言定位。
    dialog: { showErrorBox: (_title: string, detail: string) => { state.order.push(`startup-failure:${detail}`); } },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8'),
    },
    shell: { openExternal: () => Promise.resolve() },
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: () => {}, removeListener: () => {} },
    ipcMain: { handle: () => {} },
  };
});

vi.mock('../../src/main/facade/facade', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/facade/facade')>();
  return {
    ...actual,
    createFacade: (dependencies: Parameters<typeof actual.createFacade>[0]) => {
      const facade = actual.createFacade(dependencies);
      const maintenance = facade.startupMaintenance;
      facade.startupMaintenance = () => { state.order.push('maintenance'); maintenance(); };
      return facade;
    },
  };
});

describe('主进程启动序列', () => {
  beforeEach(() => {
    state.order = [];
    state.appData = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-main-'));
    vi.resetModules();
  });

  afterEach(() => {
    // 组合根按设计持有 SQLite 连接直到进程退出：Windows 下无法删除仍被打开的文件，忽略清理失败。
    try { fs.rmSync(state.appData, { recursive: true, force: true }); } catch { /* 留给进程退出后回收 */ }
  });

  it('在创建窗口（UI 依赖 freshness）之前先执行一次本地启动维护', async () => {
    await import('../../src/main/index');

    await vi.waitFor(() => { expect(state.order).toContain('window'); });

    expect(state.order.filter((entry) => entry === 'maintenance')).toHaveLength(1);
    expect(state.order).not.toContain(expect.stringContaining('startup-failure'));
    expect(state.order.indexOf('maintenance')).toBeLessThan(state.order.indexOf('window'));
  });
});
