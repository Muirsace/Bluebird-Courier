import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from './core/infra/database';
import { createSafeStorageCipherBox } from './core/infra/encryption';
import { createFileLogger } from './core/infra/logger';
import { systemClock } from './core/infra/clock';
import { createGitHubHttpClient } from './core/adapters/github-http-client';
import { createGitHubTokenAdapter } from './core/adapters/github-token-adapter';
import { createGitHubRepositoryAdapter } from './core/adapters/github-repository-adapter';
import { createGitHubDetailAdapter } from './core/adapters/github-detail-adapter';
import { openGitHubExternal } from './core/adapters/shell-links';
import { applyThemeSource } from './core/adapters/theme';
import { refreshWindowsWindowChrome, syncWindowsWindowChrome, windowsWindowChromeOptions } from './core/adapters/window-chrome';
import { createRepositoryList } from './features/repository-list/implementation/create';
import { createRepositoryDetail } from './features/repository-detail/implementation/create';
import { createTokenSettings } from './features/token-settings/implementation/create';
import { createSnapshotTrend } from './features/snapshot-trend/implementation/create';
import { createFacade } from './facade/facade';
import { registerIpc } from './ipc';

app.setName('青鸟信使');

let userDataPathError: unknown = null;
try {
  // 开发和安装版本统一使用产品目录，浏览器状态与应用数据放在同一处。
  const userDataPath = path.join(app.getPath('appData'), 'Bluebird-Courier');
  mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
  app.setPath('sessionData', userDataPath);
} catch (error) {
  // 目录初始化失败时终止启动，避免使用其他目录产生空白数据。
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
    const dataDirectory = app.getPath('userData');
    logHint = `\n\n日志目录：${path.join(dataDirectory, 'logs')}`;
  } catch {
    // userData 路径取不到时省略提示，不能因此再抛错
  }
  dialog.showErrorBox('青鸟信使启动失败', `应用无法启动：${detail}${logHint}`);
  app.exit(1);
}

// 单实例：两个实例写同一个 SQLite 文件会互相撞写锁，第二个实例直接让位。
if (userDataPathError !== null) {
  void app.whenReady().then(() => reportStartupFailure(userDataPathError));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  });

  void app
    .whenReady()
    .then(async () => {
      const userData = app.getPath('userData');
      const logger = createFileLogger(path.join(userData, 'logs'), systemClock);
      logger.info('主进程启动');
      const db = openDatabase(path.join(userData, 'octo.db'));
      const cipher = createSafeStorageCipherBox(safeStorage);
      const githubClient = createGitHubHttpClient();
      const github = {
        ...createGitHubTokenAdapter(githubClient),
        ...createGitHubRepositoryAdapter(githubClient),
        ...createGitHubDetailAdapter(githubClient),
      };
      const repositoryList = createRepositoryList({ db, clock: systemClock, logger });
      const facade = createFacade({
        repositoryList,
        github,
        repositoryDetail: createRepositoryDetail({
          db,
          github,
          clock: systemClock,
          repositoryById: (repositoryId) => repositoryList.findById(repositoryId),
        }),
        tokenSettings: createTokenSettings({ db, cipher, github, logger }),
        snapshotTrend: createSnapshotTrend({ db, clock: systemClock }),
        logger,
      });
      registerIpc(facade, {
        openGitHubExternal: (target) => openGitHubExternal(target, (url) => shell.openExternal(url)),
        applyTheme: (preference) => {
          applyThemeSource({ theme: preference });
          for (const window of BrowserWindow.getAllWindows()) refreshWindowsWindowChrome(window);
        },
      });
      // 创建窗口前应用已保存的主题，避免首屏与原生标题栏闪烁。
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
