/** IPC 通道唯一白名单；主进程注册和 preload 桥接均从这里取得名称。 */
export const IPC_CHANNELS = {
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
  readLocalDetail: 'octo:readLocalDetail',
  acknowledgeRepositoryViewed: 'octo:acknowledgeRepositoryViewed',
  loadHistory: 'octo:loadHistory',
  trend: 'octo:trend',
  openGitHubExternal: 'octo:openGitHubExternal',
} as const;

export type IpcChannelMap = typeof IPC_CHANNELS;
export type IpcChannelName = IpcChannelMap[keyof IpcChannelMap];
