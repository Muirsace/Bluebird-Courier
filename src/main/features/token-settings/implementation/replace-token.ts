import type { NormalizedError } from '../../../../domain/types';
import type { TokenChangeState, TokenOperationResult } from '../contract';
import type { TokenVerificationResult } from './verify-token';
import { normalizeTokenError } from './verify-token';

export interface ReplaceTokenController {
  begin(): TokenOperationResult;
  confirm(token: string): Promise<TokenOperationResult>;
  cancel(): TokenOperationResult;
}

export interface ReplaceTokenDependencies {
  /** 网络校验：只验证候选令牌，不写任何本地状态。 */
  verify(token: string): Promise<TokenVerificationResult>;
  /** 同步原子提交：验证通过且操作仍有效时保存加密令牌并推进访问上下文；失败必须抛出。 */
  commit(token: string): void;
}

/**
 * 管理更换访问令牌的二次确认状态，不触碰其他 feature 的存储。
 *
 * 每次 begin / confirm / cancel 都推进代号：验证在途时被取消、再次 begin 或新的确认取代，
 * 迟到的验证结果不再提交；取消对进行中的确认是真实阻止，而不只是隐藏界面。
 * 验证失败停在 failed，可直接重新确认，状态机不会永久卡死。
 */
export function createReplaceTokenController({ verify, commit }: ReplaceTokenDependencies): ReplaceTokenController {
  let state: TokenChangeState = 'idle';
  let generation = 0;
  const result = (ok: boolean, error: NormalizedError | null = null): TokenOperationResult => ({ ok, state, error });

  const begin = (): TokenOperationResult => {
    generation += 1;
    state = 'awaiting_confirmation';
    return result(true);
  };

  const confirm = async (token: string): Promise<TokenOperationResult> => {
    if (state === 'verifying') return result(false, { kind: 'unknown', message: '更换验证进行中，请稍候' });
    if (state !== 'awaiting_confirmation' && state !== 'failed') return result(false, { kind: 'unknown', message: '请先确认更换访问令牌' });
    const mine = ++generation;
    state = 'verifying';
    const checked = await verify(token);
    // 迟到的验证结果：不保存令牌、不推进上下文、不改动原资料。
    if (mine !== generation) return result(false, { kind: 'unknown', message: '更换访问令牌操作已取消，未做任何修改' });
    if (!checked.ok) {
      state = 'failed';
      return result(false, checked.error);
    }
    try {
      commit(token);
    } catch (error) {
      state = 'failed';
      return result(false, normalizeTokenError(error));
    }
    state = 'completed';
    return result(true);
  };

  const cancel = (): TokenOperationResult => {
    generation += 1;
    state = 'idle';
    return result(true);
  };

  return { begin, confirm, cancel };
}
