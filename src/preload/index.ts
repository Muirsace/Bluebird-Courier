import { contextBridge, ipcRenderer } from 'electron';
import type { BluebirdCourierBridge } from '../shared/types';
import type { IpcChannelMap } from '../shared/ipc';

/**
 * 白名单网关：仅暴露用例门面的固定方法，不透传任意通道。
 *
 * 沙箱 preload 的 require 只允许 electron/events/timers/url（Electron ≥20 默认
 * 沙箱化渲染进程，见官方文档 Process Sandboxing），因此本文件必须自包含：
 * 通道名在此内联，不得运行时 import 相对模块（tsc 会编译成 require，加载即抛错，
 * 症状为启动即报"无法读取访问令牌状态"且无法输入令牌）。
 * IpcChannelMap 是 import type（编译期擦除、零运行时依赖），字面量类型保证
 * 与主进程 IPC_CHANNELS 逐字一致，漂移即编译错误。
 * 回归测试：tests/preload/preload-sandbox.test.ts。
 */
const CHANNELS: IpcChannelMap = {
  accessTokenState: 'octo:accessTokenState',
  validateAccessToken: 'octo:validateAccessToken',
  saveAccessToken: 'octo:saveAccessToken',
  getSettings: 'octo:getSettings',
  updateSettings: 'octo:updateSettings',
  inspectRepositoryInput: 'octo:inspectRepositoryInput',
  listRepositories: 'octo:listRepositories',
  addRepository: 'octo:addRepository',
  removeRepository: 'octo:removeRepository',
  refreshGlance: 'octo:refreshGlance',
  fetchDetail: 'octo:fetchDetail',
  openGitHubExternal: 'octo:openGitHubExternal',
};

const bridge = {
  accessTokenState: () => ipcRenderer.invoke(CHANNELS.accessTokenState),
  validateAccessToken: (accessToken) => ipcRenderer.invoke(CHANNELS.validateAccessToken, accessToken),
  saveAccessToken: (accessToken) => ipcRenderer.invoke(CHANNELS.saveAccessToken, accessToken),
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(CHANNELS.updateSettings, patch),
  inspectRepositoryInput: (input) => ipcRenderer.invoke(CHANNELS.inspectRepositoryInput, input),
  listRepositories: () => ipcRenderer.invoke(CHANNELS.listRepositories),
  addRepository: (fullName) => ipcRenderer.invoke(CHANNELS.addRepository, fullName),
  removeRepository: (repositoryId) => ipcRenderer.invoke(CHANNELS.removeRepository, repositoryId),
  refreshGlance: () => ipcRenderer.invoke(CHANNELS.refreshGlance),
  fetchDetail: (repositoryId) => ipcRenderer.invoke(CHANNELS.fetchDetail, repositoryId),
  openGitHubExternal: (target) => ipcRenderer.invoke(CHANNELS.openGitHubExternal, target),
} satisfies BluebirdCourierBridge;

contextBridge.exposeInMainWorld('bluebirdCourier', bridge);
