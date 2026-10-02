import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from './core/infra/database';
import { createSafeStorageCipherBox } from './core/infra/cipher';
import { createFileLogger } from './core/infra/logger';
import { systemClock } from './core/infra/clock';
import { createHttpGitHub } from './core/adapters/github/http-github';
import { openGitHubExternal } from './core/adapters/shell-links';
import { applyThemeSource } from './core/adapters/theme';
import { refreshWindowsWindowChrome, syncWindowsWindowChrome, windowsWindowChromeOptions } from './core/adapters/window-chrome';
import { createFetching } from './features/fetching/implementation';
import { createSettings } from './features/settings/implementation';
import { createWatchlist } from './features/watchlist/implementation';
import { createFacade } from './facade/facade';
import { registerIpc } from './ipc';

// productName changed for display, but existing installations store the database,
// settings and safeStorage ciphertext under the former Electron userData directory.
const LEGACY_USER_DATA_DIRECTORY = 'OCTO 仓库监控器';
let legacyUserDataPath: string | null = null;
let userDataPathError: unknown = null;
try {
  legacyUserDataPath = path.join(app.getPath('appData'), LEGACY_USER_DATA_DIRECTORY);
  mkdirSync(legacyUserDataPath, { recursive: true });
  app.setPath('userData', legacyUserDataPath);
} catch (error) {
  // Do not continue with Electron's new productName-based directory if compatibility setup fails.
  userDataPathError = error;
}

function appIconPath(): string {
  const iconDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(app.getAppPath(), 'resources', 'icons');
  return path.join(iconDirectory, 'bluebird-app.png');
}

/**
 * Electron 主进程：承载服务层（core + features），经白名单 IPC 暴露用例门面。
 * 普通窗口、无托盘、无开机自启；关闭即停，不留后台进程；数据全部在本机。
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 480,
    minHeight: 640,
    autoHideMenuBar: true,
    title: '青鸟信使',
    icon: appIconPath(),
    ...windowsWindowChromeOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  syncWindowsWindowChrome(window);

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }
  return window;
}

/**
 * 启动期任何失败（库打不开、日志目录不可写、窗口创建失败）都必须让用户看见：
 * 打包后没有控制台，沉默退出等于"双击没反应"。
 */
function reportStartupFailure(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  let logHint = '';
  try {
    const dataDirectory = legacyUserDataPath ?? app.getPath('userData');
    logHint = `\n\n日志目录：${path.join(dataDirectory, 'logs')}`;
  } catch {
    // userData 路径取不到时省略提示，不能因此再抛错
  }
  dialog.showErrorBox('青鸟信使启动失败', `应用无法启动：${detail}${logHint}`);
  app.exit(1);
}

// 单实例：两个实例写同一个 SQLite 文件会互相撞写锁（SQLITE_BUSY），第二个实例直接让位
if (userDataPathError !== null) {
  void app.whenReady().then(() => reportStartupFailure(userDataPathError));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  void app
    .whenReady()
    .then(async () => {
      const userData = app.getPath('userData');
      const logger = createFileLogger(path.join(userData, 'logs'));
      logger.info('主进程启动');
      const db = openDatabase(path.join(userData, 'octo.db'));
      const cipher = createSafeStorageCipherBox(safeStorage);
      const github = createHttpGitHub();
      const facade = createFacade({
        settings: createSettings({ db, cipher, logger }),
        watchlist: createWatchlist({ db, clock: systemClock, logger }),
        fetching: createFetching({ github }),
        logger,
      });
      registerIpc(facade, {
        openGitHubExternal: (target) => openGitHubExternal(target, (url) => shell.openExternal(url)),
        applyTheme: (preference) => {
          applyThemeSource({ theme: preference });
          for (const window of BrowserWindow.getAllWindows()) refreshWindowsWindowChrome(window);
        },
      });
      // 建窗口之前先落地主题偏好：首屏就按用户选的主题绘制，不闪一下再切
      applyThemeSource((await facade.getSettings()).preferences);
      createWindow();
      logger.info('窗口已创建');

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch(reportStartupFailure);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
