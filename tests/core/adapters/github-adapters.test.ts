import { describe, it, expect } from 'vitest';
import type {
  GitHubPort,
  ScopeFetchPort,
  ScopeVerificationPort,
  SummaryObservationPort,
} from '../../../src/domain/ports';
import { createGitHubHttpClient } from '../../../src/main/core/adapters/github-http-client';
import { createGitHubTokenAdapter } from '../../../src/main/core/adapters/github-token-adapter';
import { createGitHubRepositoryAdapter } from '../../../src/main/core/adapters/github-repository-adapter';
import { createGitHubDetailAdapter } from '../../../src/main/core/adapters/github-detail-adapter';
import { normalizeError } from '../../../src/main/facade/result-mappers';
import type { ScopeVerifyRequest } from '../../../src/domain/ports';
import type { CheckedSignal } from '../../../src/domain/types';

type ComposedGitHub = GitHubPort & SummaryObservationPort & ScopeVerificationPort & ScopeFetchPort;

function knownValue(signal: CheckedSignal<string>): string | null {
  if (signal.state !== 'known') throw new Error('信号应为已确认状态');
  return signal.value;
}

function compose(fetchImpl: typeof fetch, timeoutMs?: number, maxConcurrent?: number): ComposedGitHub {
  const client = createGitHubHttpClient(fetchImpl, timeoutMs, Date.now, maxConcurrent);
  return {
    ...createGitHubTokenAdapter(client),
    ...createGitHubRepositoryAdapter(client),
    ...createGitHubDetailAdapter(client),
  };
}

// —— 假响应与路由（HTTP 层计数） ——

const STATUS = Symbol('http-status');
interface HttpStatus { [STATUS]: true; status: number; headers?: Record<string, string> }
function httpStatus(status: number, headers?: Record<string, string>): HttpStatus {
  return { [STATUS]: true, status, headers };
}
function isHttpStatus(value: unknown): value is HttpStatus {
  return typeof value === 'object' && value !== null && (value as HttpStatus)[STATUS] === true;
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { forEach: (callback: (value: string, key: string) => void) => { map.forEach((value, key) => callback(value, key)); } },
    json: async () => payload,
  } as unknown as Response;
}

/** 路由 fetch：按路径应答并记录实际 HTTP 请求；Error 值模拟网络失败，httpStatus 模拟 HTTP 状态。 */
function routeFetch(handler: (path: string) => unknown): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const path = String(input).replace('https://api.github.com', '');
    calls.push(path);
    const result = handler(path);
    if (isHttpStatus(result)) return jsonResponse(null, result.status, result.headers);
    if (result instanceof Error) throw result;
    return jsonResponse(result);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

// —— 观察路由 ——

const REPO_BODY = {
  full_name: 'octo/demo',
  stargazers_count: 10,
  forks_count: 2,
  open_issues_count: 3,
  pushed_at: '2026-10-05T01:00:00.000Z',
  default_branch: 'main',
};

function observationRoutes(overrides: { release?: unknown; tag?: unknown; head?: unknown; collaboration?: unknown } = {}) {
  return (path: string): unknown => {
    if (path === '/repos/octo/demo') return REPO_BODY;
    if (path === '/repos/octo/demo/git/ref/heads/main') return overrides.head ?? { object: { sha: 'sha-head-1' } };
    if (path === '/repos/octo/demo/releases/latest') return overrides.release ?? { tag_name: 'v1.0.0', name: 'v1', published_at: '2026-10-01T00:00:00.000Z' };
    if (path === '/repos/octo/demo/tags?per_page=1') return overrides.tag ?? [{ name: 'v1.0.1', commit: { sha: 'tag-sha' } }];
    if (path === '/repos/octo/demo/issues?state=all&sort=updated&direction=desc&per_page=1') return overrides.collaboration ?? [{ number: 1, updated_at: '2026-10-05T02:00:00.000Z' }];
    return httpStatus(404);
  };
}

function verifyRequest(scope: ScopeVerifyRequest['scope'], overrides: Partial<ScopeVerifyRequest> = {}): ScopeVerifyRequest {
  return {
    fullName: 'octo/demo',
    scope,
    defaultBranch: 'main',
    accessContextRevision: 5,
    mode: 'probe',
    maxPages: 3,
    checkedAt: '2026-10-05T03:00:00.000Z',
    baselineFingerprint: null,
    ...overrides,
  };
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

    const issues = await compose(fetchImpl).listIssues('ghp_any', 'octo/demo');

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
    /** 永不返回的 fetch：只在收到中止信号时 reject，模拟连接挂起。 */
    const hangingFetch = (async (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;

    const github = compose(hangingFetch, 20);

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

describe('归一化观察（observeSummary）', () => {
  it('成功确认无 Release 与未检查区分：Release 404 记为 known-null，Tag 兜底展示', async () => {
    const { fetchImpl, calls } = routeFetch(observationRoutes({ release: httpStatus(404) }));
    const observation = await compose(fetchImpl).observeSummary('ghp', 'octo/demo', '2026-10-05T03:00:00.000Z', 7);

    expect(observation.accessContextRevision).toBe(7); // 访问上下文由调用链提供并原样回显
    expect(observation.signals.releaseRevision).toEqual({ state: 'known', value: null, checkedAt: '2026-10-05T03:00:00.000Z' });
    expect(observation.signals.headRevision).toEqual({ state: 'known', value: 'sha-head-1', checkedAt: '2026-10-05T03:00:00.000Z' });
    expect(observation.signals.tagRevision).toEqual({ state: 'known', value: JSON.stringify(['v1.0.1', 'tag-sha']), checkedAt: '2026-10-05T03:00:00.000Z' });
    expect(observation.values.latestReleaseTag).toBe('v1.0.1'); // 无 Release 时保留 Tag 展示
    expect(observation.values.latestTag).toBe('v1.0.1');
    expect(observation.activity.release.at).toBeNull();
    expect(observation.activity.collaboration.at).toBe('2026-10-05T02:00:00.000Z');
    // 适配器调用：一次观察 = 5 个 HTTP 请求（元数据 + HEAD 引用 + Release + Tag + 协作线索）
    expect(calls).toEqual([
      '/repos/octo/demo',
      '/repos/octo/demo/git/ref/heads/main',
      '/repos/octo/demo/releases/latest',
      '/repos/octo/demo/tags?per_page=1',
      '/repos/octo/demo/issues?state=all&sort=updated&direction=desc&per_page=1',
    ]);
  });

  it('单信号失败隔离：Release 请求失败记为 unknown，不拖垮其他信号', async () => {
    const { fetchImpl } = routeFetch(observationRoutes({ release: httpStatus(500) }));
    const observation = await compose(fetchImpl).observeSummary('ghp', 'octo/demo', '2026-10-05T03:00:00.000Z', 0);

    expect(observation.signals.releaseRevision.state).toBe('unknown');
    expect(observation.signals.headRevision.state).toBe('known');
    expect(observation.values.latestReleaseTag).toBe('v1.0.1'); // Tag 兜底不受 Release 失败影响
  });

  it('HEAD 探测失败记为 unknown，不冒充"确认不存在"', async () => {
    const { fetchImpl } = routeFetch(observationRoutes({ head: httpStatus(404) }));
    const observation = await compose(fetchImpl).observeSummary('ghp', 'octo/demo', '2026-10-05T03:00:00.000Z', 0);
    expect(observation.signals.headRevision.state).toBe('unknown');
  });

  it('摘要本身失败（401）时整体抛出，由调用方保留旧摘要', async () => {
    const { fetchImpl } = routeFetch((path) => path === '/repos/octo/demo' ? httpStatus(401) : httpStatus(404));
    await expect(compose(fetchImpl).observeSummary('ghp', 'octo/demo', '2026-10-05T03:00:00.000Z', 0))
      .rejects.toMatchObject({ kind: 'access_token_invalid' });
  });

  it('Release 指纹覆盖页面关心的编辑字段：同 Tag 改名也会产生新指纹', async () => {
    const first = routeFetch(observationRoutes({ release: { tag_name: 'v1.0.0', name: '原名', published_at: '2026-10-01T00:00:00.000Z' } }));
    const second = routeFetch(observationRoutes({ release: { tag_name: 'v1.0.0', name: '改名后', published_at: '2026-10-01T00:00:00.000Z' } }));
    const third = routeFetch(observationRoutes({ release: { tag_name: 'v1.0.0', name: '原名', published_at: '2026-10-01T00:00:00.000Z' } }));

    const a = await compose(first.fetchImpl).observeSummary('ghp', 'octo/demo', 'T', 0);
    const b = await compose(second.fetchImpl).observeSummary('ghp', 'octo/demo', 'T', 0);
    const c = await compose(third.fetchImpl).observeSummary('ghp', 'octo/demo', 'T', 0);

    expect(a.signals.releaseRevision.state).toBe('known');
    expect(b.signals.releaseRevision.state).toBe('known');
    expect(knownValue(a.signals.releaseRevision)).not.toBe(knownValue(b.signals.releaseRevision));
    expect(knownValue(a.signals.releaseRevision)).toBe(knownValue(c.signals.releaseRevision));
  });
});

describe('Issue / PR 列表验证（verifyScopes）', () => {
  const upTo = '2026-10-05T02:00:00.000Z';

  it('probe：更新时间前进即判定变化（数量相同也能发现），并带重叠窗口', async () => {
    const baseline = JSON.stringify({ v: 1, upTo, win: [[42, '2026-10-05T01:59:30.000Z']] });
    const { fetchImpl, calls } = routeFetch((path) => {
      if (path.startsWith('/repos/octo/demo/issues?')) return [{ number: 42, updated_at: '2026-10-05T02:10:00.000Z' }];
      return httpStatus(404);
    });
    const result = await compose(fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { baselineFingerprint: baseline, maxPages: 1 }));

    expect(result.changed).toBe(true);
    expect(result.checkComplete).toBe(true);
    expect(result.accessContextRevision).toBe(5);
    // 重叠 60 秒：since = upTo - 60s
    expect(calls[0]).toContain('since=2026-10-05T01%3A59%3A00.000Z');
  });

  it('probe：重叠窗口内一致则无变化并推进游标；未记录或时间不同视为变化', async () => {
    const baseline = JSON.stringify({ v: 1, upTo, win: [[42, '2026-10-05T01:59:30.000Z']] });

    // 旧的重叠记录已不在新窗口内：无变化，新窗口为空，游标推进到检查开始时间
    const same = routeFetch(() => [{ number: 42, updated_at: '2026-10-05T01:59:30.000Z' }]);
    const unchanged = await compose(same.fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { baselineFingerprint: baseline, maxPages: 1 }));
    expect(unchanged.changed).toBe(false);
    expect(unchanged.checkComplete).toBe(true);
    const minted = JSON.parse(unchanged.fingerprint ?? '{}') as { upTo?: string; win?: unknown[] };
    expect(minted.upTo).toBe('2026-10-05T03:00:00.000Z');
    expect(minted.win).toEqual([]);

    // 新鲜的重叠记录（检查前 60 秒内）保留进新窗口
    const freshBaseline = JSON.stringify({ v: 1, upTo: '2026-10-05T02:59:45.000Z', win: [[42, '2026-10-05T02:59:30.000Z']] });
    const fresh = routeFetch(() => [{ number: 42, updated_at: '2026-10-05T02:59:30.000Z' }]);
    const freshResult = await compose(fresh.fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { baselineFingerprint: freshBaseline, maxPages: 1 }));
    expect(freshResult.changed).toBe(false);
    expect((JSON.parse(freshResult.fingerprint ?? '{}') as { win?: unknown[] }).win).toEqual([[42, '2026-10-05T02:59:30.000Z']]);

    const edited = routeFetch(() => [{ number: 42, updated_at: '2026-10-05T01:59:45.000Z' }]);
    expect((await compose(edited.fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { baselineFingerprint: baseline, maxPages: 1 }))).changed).toBe(true);

    const unrecorded = routeFetch(() => [{ number: 99, updated_at: '2026-10-05T01:59:50.000Z' }]);
    expect((await compose(unrecorded.fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { baselineFingerprint: baseline, maxPages: 1 }))).changed).toBe(true);
  });

  it('probe：预算耗尽（分页未完成）不得宣布无变化', async () => {
    const fullPage = Array.from({ length: 100 }, (_item, index) => ({ number: index + 1, updated_at: '2026-10-05T01:59:30.000Z' }));
    const baseline = JSON.stringify({ v: 1, upTo, win: fullPage.map((item) => [item.number, item.updated_at]) });
    const { fetchImpl, calls } = routeFetch(() => fullPage);

    const result = await compose(fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { baselineFingerprint: baseline, maxPages: 1 }));

    expect(result.checkComplete).toBe(false);
    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('reread：PR 专有字段（草稿/分支）变化独立被发现', async () => {
    const issuesPath = '/repos/octo/demo/issues?state=all&sort=updated&direction=desc&per_page=100&page=1';
    const pullsPath = '/repos/octo/demo/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1';
    const pullBody = (draft: boolean) => ({
      number: 57, state: 'open', title: 'pr', updated_at: '2026-10-05T01:00:00.000Z',
      draft, merged_at: null, head: { ref: 'feature' }, base: { ref: 'main' },
    });
    const baselineDigest = JSON.stringify([
      [],
      [[57, 'open', 'pr', '2026-10-05T01:00:00.000Z', false, null, 'feature', 'main']],
    ]);
    const baseline = JSON.stringify({ v: 1, upTo, win: [], reread: { pages: 1, digest: baselineDigest } });

    const changedRoute = routeFetch((path) => path === issuesPath ? [] : path === pullsPath ? [pullBody(true)] : httpStatus(404));
    const changed = await compose(changedRoute.fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { mode: 'reread', maxPages: 1, baselineFingerprint: baseline }));
    expect(changed.changed).toBe(true);
    expect(changed.checkComplete).toBe(true);
    expect(changedRoute.calls).toEqual([issuesPath, pullsPath]); // PR 走独立端点验证

    const sameRoute = routeFetch((path) => path === issuesPath ? [] : path === pullsPath ? [pullBody(false)] : httpStatus(404));
    const same = await compose(sameRoute.fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { mode: 'reread', maxPages: 1, baselineFingerprint: baseline }));
    expect(same.changed).toBe(false);
    expect(same.checkComplete).toBe(true);
  });

  it('reread：任一来源失败 → 检查未完成，不宣布无变化', async () => {
    const baseline = JSON.stringify({ v: 1, upTo, win: [], reread: { pages: 1, digest: '[]' } });
    const { fetchImpl } = routeFetch((path) => path.includes('/pulls?') ? new TypeError('fetch failed') : []);
    const result = await compose(fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { mode: 'reread', maxPages: 1, baselineFingerprint: baseline }));
    expect(result.checkComplete).toBe(false);
    expect(result.changed).toBe(false);
  });
});

describe('构建验证（verifyScopes）', () => {
  const runsPath = '/repos/octo/demo/actions/runs?per_page=30&page=1';
  const runPath = (id: string) => `/repos/octo/demo/actions/runs/${id}`;
  const runBody = (id: number, attempt: number, status: string, conclusion: string | null) => ({
    id, run_attempt: attempt, status, conclusion, name: 'ci', html_url: `https://github.com/octo/demo/actions/runs/${id}`, updated_at: '2026-10-05T02:30:00.000Z',
  });

  it('已知未完成运行被跟踪：结束时发现变化；HEAD 不参与（不变也检查）', async () => {
    const baseline = JSON.stringify({ v: 1, recent: [['456', 1, 'in_progress', null]], tracked: [['456', 1, 'in_progress', null]] });
    const { fetchImpl, calls } = routeFetch((path) => {
      if (path === runsPath) return { workflow_runs: [runBody(456, 1, 'completed', 'success')] };
      if (path === runPath('456')) return runBody(456, 1, 'completed', 'success');
      return httpStatus(404);
    });
    const result = await compose(fetchImpl).verifyScopes('ghp', verifyRequest('builds', { baselineFingerprint: baseline }));

    expect(result.changed).toBe(true);
    expect(result.checkComplete).toBe(true);
    expect(calls.some((path) => path.includes('/git/ref/'))).toBe(false); // 不因 HEAD 跳过构建检查
  });

  it('重跑（attempt 变化）被发现', async () => {
    const recent = [['900', 1, 'completed', 'neutral']];
    const baseline = JSON.stringify({ v: 1, recent, tracked: [['456', 1, 'in_progress', null]] });
    const { fetchImpl } = routeFetch((path) => {
      if (path === runsPath) return { workflow_runs: [runBody(900, 1, 'completed', 'neutral')] };
      if (path === runPath('456')) return runBody(456, 2, 'queued', null);
      return httpStatus(404);
    });
    const result = await compose(fetchImpl).verifyScopes('ghp', verifyRequest('builds', { baselineFingerprint: baseline }));
    expect(result.changed).toBe(true);
    expect(result.checkComplete).toBe(true);
  });

  it('预算不足重读全部未完成运行时未完成，不宣布无变化', async () => {
    const recent = [['900', 2, 'in_progress', null]];
    const tracked = [['456', 1, 'in_progress', null], ['457', 1, 'in_progress', null], ['458', 1, 'in_progress', null]];
    const baseline = JSON.stringify({ v: 1, recent, tracked });
    const { fetchImpl, calls } = routeFetch((path) => {
      if (path === runsPath) return { workflow_runs: [runBody(900, 2, 'in_progress', null)] };
      if (path === runPath('456')) return runBody(456, 1, 'in_progress', null);
      return httpStatus(404);
    });
    const result = await compose(fetchImpl).verifyScopes('ghp', verifyRequest('builds', { baselineFingerprint: baseline, maxPages: 2 }));

    expect(result.checkComplete).toBe(false);
    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(2); // 近期页 1 + 跟踪运行 1（预算 maxPages-1）
  });
});

describe('HTTP 层并发、取消与资源释放', () => {
  it('并发上限 3：请求排队而不是丢弃，完成后释放', async () => {
    let active = 0;
    let started = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const fetchImpl = (async () => {
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve();
        });
      });
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createGitHubHttpClient(fetchImpl, 10_000, Date.now, 3);
    const tasks = Array.from({ length: 6 }, () => client.request('ghp', '/user', () => 'ok'));
    await flush();
    expect(started).toBe(3); // 闸门生效：只放行 3 个

    while (releases.length > 0) {
      releases.splice(0).forEach((release) => release());
      await flush();
    }
    await expect(Promise.all(tasks)).resolves.toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(started).toBe(6); // 排队后全部执行，没有被丢弃
    expect(maxActive).toBe(3);
  });

  it('取消中止请求并释放闸门，后续请求可继续', async () => {
    let hanging = true;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!hanging) return jsonResponse({});
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;

    const client = createGitHubHttpClient(fetchImpl, 10_000);
    const controller = new AbortController();
    const pending = client.request('ghp', '/user', () => 'late', undefined, { signal: controller.signal });
    await flush(); // 等请求真正进入 fetch（信号监听已挂上）
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'network' });

    hanging = false;
    await expect(client.request('ghp', '/user', () => 'done')).resolves.toBe('done');
  });

  it('超时中止并归一为网络失败；超时后名额释放', async () => {
    let hanging = true;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!hanging) return jsonResponse({});
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;

    const client = createGitHubHttpClient(fetchImpl, 20);
    await expect(client.request('ghp', '/user', () => 'x')).rejects.toMatchObject({ kind: 'network' });

    hanging = false;
    await expect(client.request('ghp', '/user', () => 'ok')).resolves.toBe('ok');
  });
});


describe('适配器审查回归', () => {
  it.each(['commits', 'releases', 'builds'] as const)('范围 %s 的数字游标续读第二页', async (scope) => {
    const route = routeFetch((path) => {
      const url = new URL('https://api.github.com' + path);
      const page = Number(url.searchParams.get('page'));
      if (scope === 'commits') return [{ sha: 'sha-' + page, commit: { message: '提交 ' + page } }];
      if (scope === 'releases') return [{ tag_name: 'v' + page, name: '发版 ' + page }];
      return { workflow_runs: [{ id: page, name: 'ci', status: 'completed', conclusion: 'success' }] };
    });
    const github = compose(route.fetchImpl);
    const request = { fullName: 'octo/demo', scope, defaultBranch: 'main', cursor: null, limit: 1, accessContextRevision: 5, observedAt: '2026-10-05T03:00:00.000Z' };
    const first = await github.fetchScope('ghp', request);
    expect(first.nextCursor).toBe('2');
    const second = await github.fetchScope('ghp', { ...request, cursor: first.nextCursor });
    expect(route.calls[1]).toContain('page=2');
    expect(second.items).not.toEqual(first.items);
  });

  it('探测第一页已发现变化，即使分页预算耗尽也保留变化证据', async () => {
    const upTo = '2026-10-05T02:00:00.000Z';
    const baseline = JSON.stringify({ v: 1, upTo, win: [] });
    const fullPage = Array.from({ length: 100 }, (_item, index) => ({ number: index + 1, updated_at: '2026-10-05T02:10:00.000Z' }));
    const route = routeFetch(() => fullPage);
    const result = await compose(route.fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { baselineFingerprint: baseline, maxPages: 1 }));
    expect(result.changed).toBe(true);
    expect(result.checkComplete).toBe(false);
    expect(result.fingerprint).toBeUndefined();
    expect(route.calls).toHaveLength(1);
  });

  it('同一运行连续验证不重复累积追踪记录或耗尽预算', async () => {
    const tuple = ['456', 1, 'in_progress', null];
    const route = routeFetch((path) => path.includes('/actions/runs?')
      ? { workflow_runs: [{ id: 456, run_attempt: 1, status: 'in_progress', conclusion: null }] }
      : { id: 456, run_attempt: 1, status: 'in_progress', conclusion: null });
    const github = compose(route.fetchImpl);
    let baseline = JSON.stringify({ v: 1, recent: [tuple], tracked: [tuple, tuple] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await github.verifyScopes('ghp', verifyRequest('builds', { baselineFingerprint: baseline, maxPages: 2 }));
      expect(result.checkComplete).toBe(true);
      expect(result.changed).toBe(false);
      expect(JSON.parse(result.fingerprint ?? '{}').tracked).toEqual([tuple]);
      baseline = result.fingerprint as string;
    }
    expect(route.calls).toHaveLength(6);
  });

  it('排队中的取消立即结束等待，并且不启动已取消的 HTTP 请求', async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => { throw new Error('首个请求未启动'); };
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      if (calls.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const client = createGitHubHttpClient(fetchImpl, 10_000, Date.now, 1);
    const first = client.request('ghp', '/first', () => 'first');
    await flush();
    const controller = new AbortController();
    const queued = client.request('ghp', '/cancelled', () => 'cancelled', undefined, { signal: controller.signal });
    const rejected = expect(queued).rejects.toMatchObject({ kind: 'network' });
    controller.abort();
    try {
      await rejected;
      expect(calls).toEqual(['https://api.github.com/first']);
    } finally { releaseFirst(); }
    await expect(first).resolves.toBe('first');
    await expect(client.request('ghp', '/next', () => 'next')).resolves.toBe('next');
    expect(calls).toEqual(['https://api.github.com/first', 'https://api.github.com/next']);
  });

  it('已经取消的请求不进入 fetch', async () => {
    const route = routeFetch(() => ({}));
    const controller = new AbortController();
    controller.abort();
    const client = createGitHubHttpClient(route.fetchImpl);
    await expect(client.request('ghp', '/user', () => 'ok', undefined, { signal: controller.signal })).rejects.toMatchObject({ kind: 'network' });
    expect(route.calls).toEqual([]);
  });

  it('README 与树读取使用目标分支，远端截断的树不确认完整覆盖', async () => {
    const route = routeFetch((path) => path.includes('/git/trees/')
      ? { truncated: true, tree: [{ path: 'README.md', type: 'blob', size: 20 }] }
      : [{ name: 'README.md', path: 'README.md', type: 'file' }]);
    const github = compose(route.fetchImpl);
    const request = { fullName: 'octo/demo', defaultBranch: 'feature/topic', cursor: null, limit: 30, accessContextRevision: 5, observedAt: '2026-10-05T03:00:00.000Z' };
    await github.fetchScope('ghp', { ...request, scope: 'readme' });
    const tree = await github.fetchScope('ghp', { ...request, scope: 'tree' });
    expect(route.calls).toEqual(['/repos/octo/demo/contents?ref=feature%2Ftopic', '/repos/octo/demo/git/trees/feature%2Ftopic?recursive=1']);
    expect(tree.coverageComplete).toBe(false);
  });
});


describe('构建验证的部分覆盖', () => {
  it('已有变化但其他运行未读或失败时不宣布检查完整', async () => {
    const recent = [['900', 1, 'completed', 'success']];
    const tracked = [['456', 1, 'in_progress', null], ['457', 1, 'in_progress', null]];
    const baseline = JSON.stringify({ v: 1, recent, tracked });
    for (const mode of ['recent-budget', 'tracked-budget', 'tracked-error']) {
      const route = routeFetch((path) => {
        if (path.includes('/actions/runs?')) return { workflow_runs: [{ id: 900, run_attempt: mode === 'recent-budget' ? 2 : 1, status: 'completed', conclusion: 'success' }] };
        if (path.endsWith('/456')) return { id: 456, run_attempt: 1, status: 'completed', conclusion: 'failure' };
        return new TypeError('运行读取失败');
      });
      const maxPages = mode === 'recent-budget' ? 1 : mode === 'tracked-budget' ? 2 : 3;
      const result = await compose(route.fetchImpl).verifyScopes('ghp', verifyRequest('builds', { baselineFingerprint: baseline, maxPages }));
      expect(result.changed).toBe(true);
      expect(result.checkComplete).toBe(false);
      expect(result.fingerprint).toBeUndefined();
    }
  });
});
