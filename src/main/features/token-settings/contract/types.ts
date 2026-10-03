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
}
