import type { NormalizedError, SettingsState } from '../../../../domain/types';

export type TokenChangeState = 'idle' | 'awaiting_confirmation' | 'verifying' | 'failed' | 'completed';

export interface TokenOperationResult {
  ok: boolean;
  state: TokenChangeState;
  error: NormalizedError | null;
  /** 本次操作对应的加密令牌与访问上下文已原子提交；清理失败仍为 true。 */
  tokenCommitted?: boolean;
  /** 持久化的跨 feature 清理意图尚未完成；begin / cancel / 验证失败不得置位。 */
  cleanupPending?: boolean;
  /** 组装结果时权威的访问上下文版本。 */
  accessContextRevision?: number;
}

/** 持久清理意图：令牌与上下文已提交，但跨 feature 资料清理尚未确认完成。 */
export interface TokenCleanupState {
  pending: boolean;
  /** 该清理义务对应的访问上下文版本。 */
  accessContextRevision: number;
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
  /** 读取持久清理意图（重启后仍可读，不依赖任何内存标志）。 */
  cleanupState(): TokenCleanupState;
  /**
   * 条件性完成清理：仅当持久意图仍对应该访问上下文版本时清除并返回 true。
   * 更新的更换已经写下新意图时返回 false，旧清理回包不得清除新版义务。
   */
  completeCleanup(accessContextRevision: number): boolean;
}
