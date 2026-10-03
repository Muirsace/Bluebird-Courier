import type { GitHubPort } from '../../../../domain/ports';
import type { NormalizedError } from '../../../../domain/types';
import type { CipherBox } from '../../../core/infra/encryption';
import { SecureStorageUnavailableError } from '../../../core/infra/encryption';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Logger } from '../../../core/infra/logger';
import { writeToken } from './token-store';

export interface TokenVerificationResult {
  ok: boolean;
  error: NormalizedError | null;
}

export interface TokenVerifier {
  verify(token: string): Promise<TokenVerificationResult>;
  save(token: string): Promise<TokenVerificationResult>;
}

function normalizeError(error: unknown): NormalizedError {
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
      return { ok: false, error: normalizeError(error) };
    }
  };

  const save = async (token: string): Promise<TokenVerificationResult> => {
    const checked = await verify(token);
    if (!checked.ok) return checked;
    try {
      writeToken(db, cipher, token);
      return { ok: true, error: null };
    } catch (error) {
      logger?.error('访问令牌保存失败', error);
      return { ok: false, error: normalizeError(error) };
    }
  };

  return { verify, save };
}

