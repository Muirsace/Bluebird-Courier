import { describe, it, expect } from 'vitest';
import type { GitHubPort } from '../../../src/domain/ports';
import { createGitHubHttpClient } from '../../../src/main/core/adapters/github-http-client';
import { createGitHubTokenAdapter } from '../../../src/main/core/adapters/github-token-adapter';
import { createGitHubRepositoryAdapter } from '../../../src/main/core/adapters/github-repository-adapter';
import { createGitHubDetailAdapter } from '../../../src/main/core/adapters/github-detail-adapter';
import { normalizeError } from '../../../src/main/facade/result-mappers';

function createGitHubPort(fetchImpl: typeof fetch, timeoutMs?: number): GitHubPort {
  const client = createGitHubHttpClient(fetchImpl, timeoutMs);
  return {
    ...createGitHubTokenAdapter(client),
    ...createGitHubRepositoryAdapter(client),
    ...createGitHubDetailAdapter(client),
  };
}

/** 永不返回的 fetch：只在收到中止信号时 reject，模拟连接挂起。 */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
}

describe('GitHub HTTP 适配器', () => {
  it('保留 Issue 与 Pull Request 的 body，并将空 body 归一为 null', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          {
            number: 42,
            title: '一个议题',
            body: '问题复现步骤与背景',
            state: 'open',
            user: { login: 'octocat' },
            updated_at: '2026-09-25T02:00:00.000Z',
          },
          {
            number: 57,
            title: '一个合并请求',
            body: null,
            state: 'closed',
            user: null,
            updated_at: '2026-09-25T07:20:00.000Z',
            pull_request: { url: 'https://api.github.com/repos/octo/demo/pulls/57' },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const issues = await createGitHubPort(fetchImpl).listIssues('ghp_any', 'octo/demo');

    expect(issues).toEqual([
      {
        kind: 'issue',
        number: 42,
        title: '一个议题',
        body: '问题复现步骤与背景',
        state: 'open',
        authorName: 'octocat',
        updatedAt: '2026-09-25T02:00:00.000Z',
      },
      {
        kind: 'pull',
        number: 57,
        title: '一个合并请求',
        body: null,
        state: 'closed',
        authorName: null,
        updatedAt: '2026-09-25T07:20:00.000Z',
      },
    ]);
  });

  it('请求挂起时按超时中止，并归一到网络失败', async () => {
    const github = createGitHubPort(hangingFetch(), 20);

    const error = await github.validateAccessToken('ghp_any').then(
      () => {
        throw new Error('应当超时失败，却成功返回');
      },
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({ name: 'PortFailure', kind: 'network' });
    expect(normalizeError(error)).toMatchObject({ kind: 'network' });
  });
});
