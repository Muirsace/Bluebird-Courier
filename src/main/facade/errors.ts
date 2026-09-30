import { PortFailure } from '../../domain/ports';
import type { NormalizedError } from '../../domain/types';

export function normalizeError(error: unknown, fullName?: string): NormalizedError {
  const context = fullName === undefined ? {} : { fullName };
  if (error instanceof PortFailure) {
    return { kind: error.kind, message: error.message, ...(error.resetAt ? { resetAt: error.resetAt } : {}), ...context };
  }
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { kind: 'network', message: '网络请求超时，请检查网络后重试', ...context };
    }
  }
  if (error instanceof TypeError) return { kind: 'network', message: '网络失败，请检查网络后重试', ...context };
  return { kind: 'unknown', message: error instanceof Error ? error.message : '发生未知错误', ...context };
}
