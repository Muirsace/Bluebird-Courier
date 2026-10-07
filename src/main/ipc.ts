import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import type { BluebirdCourierFacade, OpenExternalResult, ThemePreference } from '../shared/types';

export interface IpcHandlers {
  /** 外链属于主进程平台出口，IPC 只把目标转发给已注入的出口。 */
  openGitHubExternal(target: unknown): Promise<OpenExternalResult>;
  applyTheme(preference: ThemePreference): void;
}

/** IPC 层只负责注册通道、转发参数和返回门面或平台出口结果。 */
export function registerIpc(facade: BluebirdCourierFacade, handlers: IpcHandlers): void {
  ipcMain.handle(IPC_CHANNELS.accessTokenState, () => facade.accessTokenState());
  ipcMain.handle(IPC_CHANNELS.validateAccessToken, (_event, accessToken: unknown) => facade.validateAccessToken(accessToken as string));
  ipcMain.handle(IPC_CHANNELS.saveAccessToken, (_event, accessToken: unknown) => facade.saveAccessToken(accessToken as string));
  ipcMain.handle(IPC_CHANNELS.beginTokenReplacement, () => facade.beginTokenReplacement!());
  ipcMain.handle(IPC_CHANNELS.confirmTokenReplacement, (_event, accessToken: unknown) => facade.confirmTokenReplacement!(accessToken as string));
  ipcMain.handle(IPC_CHANNELS.cancelTokenReplacement, () => facade.cancelTokenReplacement!());
  ipcMain.handle(IPC_CHANNELS.getSettings, () => facade.getSettings());
  ipcMain.handle(IPC_CHANNELS.updateSettings, (_event, patch: unknown) => facade.updateSettings((patch ?? {}) as Record<string, string>));
  ipcMain.handle(IPC_CHANNELS.setThemePreference, (_event, preference: unknown) => {
    if (preference !== 'system' && preference !== 'light' && preference !== 'dark') return;
    handlers.applyTheme(preference);
  });
  ipcMain.handle(IPC_CHANNELS.inspectRepositoryInput, (_event, input: unknown) => facade.inspectRepositoryInput(input as string));
  ipcMain.handle(IPC_CHANNELS.listRepositories, () => facade.listRepositories());
  ipcMain.handle(IPC_CHANNELS.addRepository, (_event, fullName: unknown) => facade.addRepository(fullName as string));
  ipcMain.handle(IPC_CHANNELS.removeRepository, (_event, repositoryId: unknown) => facade.removeRepository(repositoryId as number));
  ipcMain.handle(IPC_CHANNELS.refreshGlance, (_event, origin: unknown) => facade.refreshGlance(origin as 'startup' | 'manual' | undefined));
  ipcMain.handle(IPC_CHANNELS.refreshRepository, (_event, repositoryId: unknown, force: unknown) => facade.refreshRepository!(repositoryId as number, force as boolean | undefined));
  ipcMain.handle(IPC_CHANNELS.fetchDetail, (_event, repositoryId: unknown) => facade.fetchDetail(repositoryId as number));
  ipcMain.handle(IPC_CHANNELS.loadHistory, (_event, repositoryId: unknown, kind: unknown, cursor: unknown) => facade.loadHistory!(repositoryId as number, kind as 'commits' | 'issues' | 'pullRequests', cursor as string | undefined));
  ipcMain.handle(IPC_CHANNELS.trend, (_event, repositoryId: unknown) => facade.trend!(repositoryId as number));
  ipcMain.handle(IPC_CHANNELS.openGitHubExternal, (_event, target: unknown) => handlers.openGitHubExternal(target));
}
