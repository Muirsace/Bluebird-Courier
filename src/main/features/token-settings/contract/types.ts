import type { NormalizedError, SettingsState } from '../../../../domain/types';

export type TokenChangeState = 'idle' | 'awaiting_confirmation' | 'verifying' | 'failed' | 'completed';

export interface TokenOperationResult {
  ok: boolean;
  state: TokenChangeState;
  error: NormalizedError | null;
}

export interface TokenSettingsService {
  readAccessToken(): string | null;
  accessTokenConfigured(): boolean;
  verify(token: string): Promise<TokenOperationResult>;
  save(token: string): Promise<TokenOperationResult>;
  beginReplace(): TokenOperationResult;
  confirmReplace(token: string): Promise<TokenOperationResult>;
  cancelReplace(): TokenOperationResult;
  getSettings(): SettingsState;
  updateSettings(patch: unknown): SettingsState;
  /** 当前访问上下文版本（0 = 初始上下文）；缓存身份与指纹按此版本隔离。 */
  accessContextRevision(): number;
  /**
   * 成功更换令牌后推进访问上下文版本并返回新版本；时间由调用方提供。
   * 具体清理编排由 facade 负责（步骤 9）。
   */
  advanceAccessContext(updatedAt: string): number;
}
