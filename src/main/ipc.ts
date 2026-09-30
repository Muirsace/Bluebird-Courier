import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import type { BluebirdCourierFacade, GitHubExternalTarget, OpenExternalResult, SettingsView } from '../shared/types';

export interface IpcHandlers {
  openGitHubExternal(target: unknown): Promise<OpenExternalResult>;
  applyTheme(preferences: SettingsView['preferences']): void;
}

/** Register the fixed IPC surface and forward calls to the already-built facade. */
export function registerIpc(facade: BluebirdCourierFacade, handlers: IpcHandlers): void {
  ipcMain.handle(IPC_CHANNELS.accessTokenState, () => facade.accessTokenState());
  ipcMain.handle(IPC_CHANNELS.validateAccessToken, (_event, accessToken: string) => facade.validateAccessToken(accessToken));
  ipcMain.handle(IPC_CHANNELS.saveAccessToken, (_event, accessToken: string) => facade.saveAccessToken(accessToken));
  ipcMain.handle(IPC_CHANNELS.getSettings, () => facade.getSettings());
  ipcMain.handle(IPC_CHANNELS.updateSettings, async (_event, patch: Record<string, string>) => {
    const view = await facade.updateSettings(patch);
    handlers.applyTheme(view.preferences);
    return view;
  });
  ipcMain.handle(IPC_CHANNELS.inspectRepositoryInput, (_event, input: string) => facade.inspectRepositoryInput(input));
  ipcMain.handle(IPC_CHANNELS.listRepositories, () => facade.listRepositories());
  ipcMain.handle(IPC_CHANNELS.addRepository, (_event, fullName: string) => facade.addRepository(fullName));
  ipcMain.handle(IPC_CHANNELS.removeRepository, (_event, repositoryId: number) => facade.removeRepository(repositoryId));
  ipcMain.handle(IPC_CHANNELS.refreshGlance, () => facade.refreshGlance());
  ipcMain.handle(IPC_CHANNELS.fetchDetail, (_event, repositoryId: number) => facade.fetchDetail(repositoryId));
  ipcMain.handle(IPC_CHANNELS.openGitHubExternal, (_event, target: GitHubExternalTarget) => handlers.openGitHubExternal(target));
}
