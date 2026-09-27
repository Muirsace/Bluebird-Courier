import { GitHubRequestError } from '../core/github/port';
import { SecureStorageUnavailableError } from '../core/cipher/cipher-box';
import type { NormalizedError } from '../../shared/types';

/**
 * 错误归一：五类 —— 令牌无效、限流（带恢复时间）、不存在/无权限、网络失败、未知。
 * 一切抓取错误都经此映射后才离开主进程。
 */
export function normalizeError(error: unknown, fullName?: string): NormalizedError {
  const context = fullName === undefined ? {} : { fullName };

  // 系统钥匙串不可用：非抓取失败，但必须让用户看到真实原因
  if (error instanceof SecureStorageUnavailableError) {
    return {
      kind: 'unknown',
      message: '系统安全存储不可用，无法保存访问令牌',
      ...context,
    };
  }

  if (error instanceof GitHubRequestError) {
    if (error.status === 401) {
      return {
        kind: 'access_token_invalid',
        message: '访问令牌无效，请到设置页更换令牌',
        ...context,
      };
    }
    if (isRateLimited(error)) {
      const resetAt = rateLimitResetAt(error);
      return {
        kind: 'rate_limited',
        message: '抓取被 GitHub 限流，配额恢复前暂不可用',
        ...(resetAt === undefined ? {} : { resetAt }),
        ...context,
      };
    }
    if (error.status === 404 || error.status === 403) {
      return {
        kind: 'not_found',
        message: '仓库不存在或无权访问',
        ...context,
      };
    }
    return {
      kind: 'unknown',
      message: `抓取失败（HTTP ${error.status}）`,
      ...context,
    };
  }

  // 请求被中止：AbortSignal.timeout 触发的超时（DOMException: TimeoutError）
  if (isAbortFailure(error)) {
    return {
      kind: 'network',
      message: '网络请求超时，请检查网络后重试',
      ...context,
    };
  }

  // 与 fetch 的网络层失败一致（TypeError: fetch failed）
  if (error instanceof TypeError) {
    return {
      kind: 'network',
      message: '网络失败，请检查网络后重试',
      ...context,
    };
  }

  return {
    kind: 'unknown',
    message: '发生未知错误',
    ...context,
  };
}

/** 请求中止判定：AbortSignal 触发的超时/取消（DOMException 或任意带 name 的 Error）。 */
function isAbortFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** 限流判定：429，或 403 且配额耗尽/带 Retry-After。 */
function isRateLimited(error: GitHubRequestError): boolean {
  if (error.status === 429) return true;
  if (error.status !== 403) return false;
  return error.headers['x-ratelimit-remaining'] === '0' || 'retry-after' in error.headers;
}

/** 限流恢复时间：优先 x-ratelimit-reset（epoch 秒），其次 retry-after（秒）；都没有则缺省。 */
function rateLimitResetAt(error: GitHubRequestError): string | undefined {
  const reset = error.headers['x-ratelimit-reset'];
  if (reset && /^\d+$/.test(reset)) {
    return new Date(Number(reset) * 1000).toISOString();
  }
  const retryAfter = error.headers['retry-after'];
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return new Date(Date.now() + Number(retryAfter) * 1000).toISOString();
  }
  return undefined;
}
