import { describe, it, expect } from 'vitest';
import { createHttpGitHub } from '../../src/main/core/github/http-github';
import { normalizeError } from '../../src/main/facade/errors';

/** 永不返回的 fetch：只在收到中止信号时 reject，模拟连接挂起。 */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
}

describe('GitHub HTTP 适配器', () => {
  it('请求挂起时按超时中止，并归一到网络失败', async () => {
    const github = createHttpGitHub(hangingFetch(), 20);

    const error = await github.validateAccessToken('ghp_any').then(
      () => {
        throw new Error('应当超时失败，却成功返回');
      },
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(normalizeError(error)).toMatchObject({ kind: 'network' });
  });
});
