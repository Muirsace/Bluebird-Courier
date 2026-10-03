import { PortFailure } from '../../../domain/ports';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'bluebird-courier';
const REQUEST_TIMEOUT_MS = 10_000;

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
  if (isAbortFailure(error)) return new PortFailure('network', '网络请求超时，请检查网络后重试');
  if (error instanceof TypeError) return new PortFailure('network', '网络失败，请检查网络后重试');
  return new PortFailure('unknown', '发生未知错误');
}

export interface GitHubHttpClient {
  request<T>(accessToken: string, apiPath: string, map: (json: unknown) => T, onNotFound?: () => T): Promise<T>;
}

/** GitHub REST 的传输封装：只处理认证、超时、HTTP 与失败归一。 */
export function createGitHubHttpClient(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  now: () => number = Date.now,
): GitHubHttpClient {
  return {
    async request<T>(accessToken: string, apiPath: string, map: (json: unknown) => T, onNotFound?: () => T): Promise<T> {
      try {
        const response = await fetchImpl(`${API_BASE}${apiPath}`, {
          signal: AbortSignal.timeout(timeoutMs),
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
      }
    },
  };
}

