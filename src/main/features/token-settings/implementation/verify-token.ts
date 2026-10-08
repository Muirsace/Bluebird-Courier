import type { GitHubPort } from '../../../../domain/ports';
import type { NormalizedError } from '../../../../domain/types';
import type { CipherBox } from '../../../core/infra/encryption';
import { SecureStorageUnavailableError } from '../../../core/infra/encryption';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Logger } from '../../../core/infra/logger';
import { readToken, writeToken } from './token-store';

export interface TokenVerificationResult {
  ok: boolean;
  error: NormalizedError | null;
}

export interface TokenVerifier {
  verify(token: string): Promise<TokenVerificationResult>;
  save(token: string): Promise<TokenVerificationResult>;
}

export function normalizeTokenError(error: unknown): NormalizedError {
  if (error instanceof SecureStorageUnavailableError) {
    return { kind: 'unknown', message: '系统安全存储不可用，无法保存访问令牌' };
  }
  const kind = typeof error === 'object' && error !== null && 'kind' in error
    ? (error as { kind?: NormalizedError['kind'] }).kind
    : undefined;
  if (kind === undefined && error instanceof TypeError) {
    return { kind: 'network', message: '网络失败，请检查网络后重试' };
  }
  if (kind === undefined && typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { kind: 'network', message: '网络请求超时，请检查网络后重试' };
    }
  }
  return {
    kind: kind ?? 'unknown',
    message: error instanceof Error ? error.message : '访问令牌操作失败',
  };
}

/** 创建只负责校验和保存访问令牌的流程。 */
export function createTokenVerifier({ db, cipher, github, logger }: {
  db: LocalDatabase;
  cipher: CipherBox;
  github: GitHubPort;
  logger?: Logger;
}): TokenVerifier {
  const verify = async (token: string): Promise<TokenVerificationResult> => {
    try {
      await github.validateAccessToken(token);
      return { ok: true, error: null };
    } catch (error) {
      logger?.error('访问令牌校验失败', error);
      return { ok: false, error: normalizeTokenError(error) };
    }
  };

  const save = async (token: string): Promise<TokenVerificationResult> => {
    const checked = await verify(token);
    if (!checked.ok) return checked;
    try {
      // 网络校验期间其他首次保存可能已提交；同步写入前再次检查，禁止迟到结果绕过更换确认。
      if (readToken(db, cipher) !== null) {
        return { ok: false, error: { kind: 'unknown', message: '访问令牌已配置，请通过确认更换流程更新令牌' } };
      }
      writeToken(db, cipher, token);
      return { ok: true, error: null };
    } catch (error) {
      logger?.error('访问令牌保存失败', error);
      return { ok: false, error: normalizeTokenError(error) };
    }
  };

  return { verify, save };
}

