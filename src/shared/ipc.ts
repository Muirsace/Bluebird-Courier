/** IPC 通道白名单：渲染层只能经此访问用例门面。
 * 主进程运行时引用本表；preload 因沙箱限制只做 import type 引用（见 src/preload/index.ts）。 */
export const IPC_CHANNELS = {
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
} as const;

export type IpcChannelMap = typeof IPC_CHANNELS;

export type IpcChannelName = IpcChannelMap[keyof IpcChannelMap];
