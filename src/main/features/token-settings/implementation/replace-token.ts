import type { NormalizedError } from '../../../../domain/types';
import type { TokenChangeState, TokenOperationResult } from '../contract';
import type { TokenVerificationResult } from './verify-token';

export interface ReplaceTokenController {
  begin(): TokenOperationResult;
  confirm(token: string): Promise<TokenOperationResult>;
  cancel(): TokenOperationResult;
}

/** 管理更换访问令牌的二次确认状态，不触碰其他 feature 的存储。 */
export function createReplaceTokenController(
  saveToken: (token: string) => Promise<TokenVerificationResult>,
): ReplaceTokenController {
  let state: TokenChangeState = 'idle';
  const result = (ok: boolean, error: NormalizedError | null = null): TokenOperationResult => ({ ok, state, error });

  const begin = (): TokenOperationResult => {
    state = 'awaiting_confirmation';
    return result(true);
  };

  const confirm = async (token: string): Promise<TokenOperationResult> => {
    if (state !== 'awaiting_confirmation') {
      return result(false, { kind: 'unknown', message: '请先确认更换访问令牌' });
    }
    state = 'verifying';
    const checked = await saveToken(token);
    if (!checked.ok) {
      state = 'failed';
      return result(false, checked.error);
    }
    state = 'completed';
    return result(true);
  };

  const cancel = (): TokenOperationResult => {
    state = 'idle';
    return result(true);
  };

  return { begin, confirm, cancel };
}

