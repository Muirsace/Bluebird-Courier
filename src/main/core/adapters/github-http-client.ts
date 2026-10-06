import { PortFailure } from '../../../domain/ports';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'bluebird-courier';
const REQUEST_TIMEOUT_MS = 10_000;
/** 统一并发上限：所有 GitHub adapter 共用一个 client 实例时共享该闸门。 */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;

export class GitHubHttpError extends Error {
  constructor(readonly status: number, readonly headers: Record<string, string>) {
    super(`GitHub API ${status}`);
    this.name = 'GitHubHttpError';
  }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : headers[key];
}

function resetAt(headers: Record<string, string>, now: () => number): string | undefined {
  const reset = header(headers, 'x-ratelimit-reset');
  if (reset !== undefined && /^\d+$/.test(reset)) return new Date(Number(reset) * 1000).toISOString();
  const retryAfter = header(headers, 'retry-after');
  if (retryAfter !== undefined && /^\d+$/.test(retryAfter)) return new Date(now() + Number(retryAfter) * 1000).toISOString();
  return undefined;
}

function isRateLimited(error: GitHubHttpError): boolean {
  return error.status === 429 || (error.status === 403 && (
    header(error.headers, 'x-ratelimit-remaining') === '0' || header(error.headers, 'retry-after') !== undefined
  ));
}

function isAbortFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    ['AbortError', 'TimeoutError'].includes(String((error as { name?: unknown }).name ?? ''));
}

/** 将协议层异常转换为领域端口失败。 */
export function mapGitHubError(error: unknown, now: () => number = Date.now): PortFailure {
  if (error instanceof PortFailure) return error;
  if (error instanceof GitHubHttpError) {
    if (error.status === 401) return new PortFailure('access_token_invalid', '访问令牌无效，请到设置页更换令牌');
    if (isRateLimited(error)) return new PortFailure('rate_limited', '抓取被 GitHub 限流，配额恢复前暂不可用', resetAt(error.headers, now));
    if (error.status === 403 || error.status === 404) return new PortFailure('not_found', '仓库不存在或无权访问');
    return new PortFailure('unknown', `抓取失败（HTTP ${error.status}）`);
  }
  if (isAbortFailure(error)) return new PortFailure('network', '网络请求超时或已取消，请检查网络后重试');
  if (error instanceof TypeError) return new PortFailure('network', '网络失败，请检查网络后重试');
  return new PortFailure('unknown', '发生未知错误');
}

export interface GitHubRequestOptions {
  /** 调用方取消信号（如页面离开）；与超时信号合并，任一触发即中止。 */
  signal?: AbortSignal;
}

export interface GitHubHttpClient {
  request<T>(accessToken: string, apiPath: string, map: (json: unknown) => T, onNotFound?: () => T, options?: GitHubRequestOptions): Promise<T>;
}

/**
 * GitHub REST 的传输封装：只处理认证、并发闸门、超时、HTTP 与失败归一。
 * 并发闸门按请求计数；中止、超时或异常都会释放名额，不会泄漏资源。
 */
export function createGitHubHttpClient(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  now: () => number = Date.now,
  maxConcurrent = DEFAULT_MAX_CONCURRENT_REQUESTS,
): GitHubHttpClient {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('请求并发上限必须为正整数');
  let active = 0;
  const waiters: Array<() => void> = [];

  function acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const start = (): void => {
        signal.removeEventListener('abort', abort);
        active += 1;
        resolve();
      };
      const abort = (): void => {
        const index = waiters.indexOf(start);
        if (index >= 0) waiters.splice(index, 1);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      waiters.push(start);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  function release(): void {
    active -= 1;
    waiters.shift()?.();
  }

  return {
    async request<T>(accessToken: string, apiPath: string, map: (json: unknown) => T, onNotFound?: () => T, options?: GitHubRequestOptions): Promise<T> {
      let acquired = false;
      try {
        // 排队也属于请求生命周期，取消或超时后不得再启动实际 HTTP。
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = options?.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
        await acquire(signal);
        acquired = true;
        signal.throwIfAborted();
        const response = await fetchImpl(`${API_BASE}${apiPath}`, {
          signal,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION,
            'User-Agent': USER_AGENT,
          },
        });
        if (!response.ok) {
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => { headers[key] = value; });
          if (response.status === 404 && onNotFound) return onNotFound();
          throw new GitHubHttpError(response.status, headers);
        }
        return map(await response.json());
      } catch (error) {
        throw mapGitHubError(error, now);
      } finally {
        if (acquired) release();
      }
    },
  };
}
