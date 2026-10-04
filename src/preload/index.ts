import { contextBridge, ipcRenderer } from 'electron';
import type { BluebirdCourierBridge } from '../shared/types';
import type { IpcChannelMap } from '../shared/ipc';

/**
 * 预加载脚本只保留受限桥接方法。Electron 沙箱不允许这里运行时加载相对模块，
 * 因此通道字面量由 shared/ipc.ts 生成后在构建产物中内联，并用类型导入校验漂移。
 */
const CHANNELS: IpcChannelMap = {
  accessTokenState: 'octo:accessTokenState',
  validateAccessToken: 'octo:validateAccessToken',
  saveAccessToken: 'octo:saveAccessToken',
  beginTokenReplacement: 'octo:beginTokenReplacement',
  confirmTokenReplacement: 'octo:confirmTokenReplacement',
  cancelTokenReplacement: 'octo:cancelTokenReplacement',
  getSettings: 'octo:getSettings',
  updateSettings: 'octo:updateSettings',
  setThemePreference: 'octo:setThemePreference',
  inspectRepositoryInput: 'octo:inspectRepositoryInput',
  listRepositories: 'octo:listRepositories',
  addRepository: 'octo:addRepository',
  removeRepository: 'octo:removeRepository',
  refreshGlance: 'octo:refreshGlance',
  refreshRepository: 'octo:refreshRepository',
  fetchDetail: 'octo:fetchDetail',
  loadHistory: 'octo:loadHistory',
  trend: 'octo:trend',
  openGitHubExternal: 'octo:openGitHubExternal',
};

const bridge = {
  accessTokenState: () => ipcRenderer.invoke(CHANNELS.accessTokenState),
  validateAccessToken: (accessToken: string) => ipcRenderer.invoke(CHANNELS.validateAccessToken, accessToken),
  saveAccessToken: (accessToken: string) => ipcRenderer.invoke(CHANNELS.saveAccessToken, accessToken),
  beginTokenReplacement: () => ipcRenderer.invoke(CHANNELS.beginTokenReplacement),
  confirmTokenReplacement: (accessToken: string) => ipcRenderer.invoke(CHANNELS.confirmTokenReplacement, accessToken),
  cancelTokenReplacement: () => ipcRenderer.invoke(CHANNELS.cancelTokenReplacement),
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings),
  updateSettings: (patch: Record<string, string>) => ipcRenderer.invoke(CHANNELS.updateSettings, patch),
  setThemePreference: (preference: Parameters<BluebirdCourierBridge['setThemePreference']>[0]) => ipcRenderer.invoke(CHANNELS.setThemePreference, preference),
  inspectRepositoryInput: (input: string) => ipcRenderer.invoke(CHANNELS.inspectRepositoryInput, input),
  listRepositories: () => ipcRenderer.invoke(CHANNELS.listRepositories),
  addRepository: (fullName: string) => ipcRenderer.invoke(CHANNELS.addRepository, fullName),
  removeRepository: (repositoryId: number) => ipcRenderer.invoke(CHANNELS.removeRepository, repositoryId),
  refreshGlance: () => ipcRenderer.invoke(CHANNELS.refreshGlance),
  refreshRepository: (repositoryId: number, force?: boolean) => ipcRenderer.invoke(CHANNELS.refreshRepository, repositoryId, force),
  fetchDetail: (repositoryId: number) => ipcRenderer.invoke(CHANNELS.fetchDetail, repositoryId),
  loadHistory: (repositoryId: number, kind: 'commits' | 'issues' | 'pullRequests', cursor?: string) => ipcRenderer.invoke(CHANNELS.loadHistory, repositoryId, kind, cursor),
  trend: (repositoryId: number) => ipcRenderer.invoke(CHANNELS.trend, repositoryId),
  openGitHubExternal: (target: Parameters<BluebirdCourierBridge['openGitHubExternal']>[0]) => ipcRenderer.invoke(CHANNELS.openGitHubExternal, target),
} satisfies BluebirdCourierBridge;

contextBridge.exposeInMainWorld('bluebirdCourier', bridge);
