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
      [[57, 'open', 'pr', '2026-10-05T01:00:00.000Z', false, null, 'feature', 'main', null, null]],
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
      if (url.pathname.endsWith('/tags')) return [];
      if (scope === 'commits') return [{ sha: 'sha-' + page, commit: { message: '提交 ' + page } }];
      if (scope === 'releases') return [{ tag_name: 'v' + page, name: '发版 ' + page }];
      return { workflow_runs: [{ id: page, name: 'ci', status: 'completed', conclusion: 'success' }] };
    });
    const github = compose(route.fetchImpl);
    const request = { fullName: 'octo/demo', scope, defaultBranch: 'main', cursor: null, limit: 1, accessContextRevision: 5, observedAt: '2026-10-05T03:00:00.000Z' };
    const first = await github.fetchScope('ghp', request);
    // v2 游标为不透明 JSON：解析出对应来源的下一页页码（releases 用 r，其余用 p）
    const cursor = JSON.parse(first.nextCursor ?? '{}') as Record<string, unknown>;
    expect(scope === 'releases' ? cursor.r : cursor.p).toBe(2);
    const second = await github.fetchScope('ghp', { ...request, cursor: first.nextCursor });
    expect(route.calls.at(-1)).toContain('page=2');
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

// —— 步骤 4 补齐（R3）：采集基线、双栏目覆盖、有界分页与活动来源 ——

describe('步骤 4 补齐（R3）', () => {
  const headRoute = (sha: string) => routeFetch((path) => path === '/repos/octo/demo/git/ref/heads/main' ? { object: { sha } } : httpStatus(404));

  it('信号范围采集初始基线：提供可持久化指纹但不冒充"已验证无变化"', async () => {
    const collect = headRoute('sha-1');
    const first = await compose(collect.fetchImpl).verifyScopes('ghp', verifyRequest('commits', { baselineFingerprint: null }));
    expect(first.changed).toBe(false);
    expect(first.checkComplete).toBe(false); // 采集不是验证结论
    expect(first.version?.headRevision).toBe('sha-1');
    expect(typeof first.fingerprint).toBe('string');

    const stable = await compose(collect.fetchImpl).verifyScopes('ghp', verifyRequest('commits', { baselineFingerprint: first.fingerprint ?? null }));
    expect(stable).toMatchObject({ changed: false, checkComplete: true });

    const moved = headRoute('sha-2');
    const drifted = await compose(moved.fetchImpl).verifyScopes('ghp', verifyRequest('commits', { baselineFingerprint: first.fingerprint ?? null }));
    expect(drifted).toMatchObject({ changed: true, checkComplete: true });
  });

  it('reread 无基线时采集可持久化摘要，同预算再次检查即可验证', async () => {
    const issuesPath = '/repos/octo/demo/issues?state=all&sort=updated&direction=desc&per_page=100&page=1';
    const pullsPath = '/repos/octo/demo/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1';
    const routes = (draft: boolean) => routeFetch((path) => {
      if (path === issuesPath) return [{ number: 42, state: 'open', title: '议题', updated_at: '2026-10-05T01:00:00.000Z' }];
      if (path === pullsPath) return [{ number: 57, state: 'open', title: 'pr', updated_at: '2026-10-05T01:00:00.000Z', draft, head: { ref: 'f' }, base: { ref: 'main' } }];
      return httpStatus(404);
    });

    const collected = await compose(routes(false).fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { mode: 'reread', maxPages: 1 }));
    expect(collected.changed).toBe(false);
    expect(collected.checkComplete).toBe(false);
    expect(typeof collected.fingerprint).toBe('string');

    const stable = await compose(routes(false).fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { mode: 'reread', maxPages: 1, baselineFingerprint: collected.fingerprint ?? null }));
    expect(stable).toMatchObject({ changed: false, checkComplete: true });

    const drifted = await compose(routes(true).fetchImpl).verifyScopes('ghp', verifyRequest('issuesAndPr', { mode: 'reread', maxPages: 1, baselineFingerprint: collected.fingerprint ?? null }));
    expect(drifted.changed).toBe(true);
  });

  it('构建无基线时采集指纹（保留 attempt 等源字段），再次验证可发现新运行', async () => {
    const runsPath = '/repos/octo/demo/actions/runs?per_page=30&page=1';
    const runBody = (id: number, attempt: number, status: string, conclusion: string | null) => ({ id, run_attempt: attempt, status, conclusion, name: 'ci', html_url: null, updated_at: '2026-10-05T02:30:00.000Z' });
    const routes = (includeNew: boolean) => routeFetch((path) => path === runsPath
      ? { workflow_runs: [...(includeNew ? [runBody(901, 1, 'in_progress', null)] : []), runBody(900, 1, 'completed', 'success')] }
      : httpStatus(404));

    const collected = await compose(routes(false).fetchImpl).verifyScopes('ghp', verifyRequest('builds', { baselineFingerprint: null }));
    expect(collected.checkComplete).toBe(false);
    expect(typeof collected.fingerprint).toBe('string');
    const parsed = JSON.parse(collected.fingerprint ?? '{}') as { recent?: unknown[][] };
    expect(parsed.recent?.[0]).toEqual(['900', 1, 'completed', 'success']); // 源字段保留在指纹里

    const stable = await compose(routes(false).fetchImpl).verifyScopes('ghp', verifyRequest('builds', { baselineFingerprint: collected.fingerprint ?? null }));
    expect(stable).toMatchObject({ changed: false, checkComplete: true });

    const withNewRun = await compose(routes(true).fetchImpl).verifyScopes('ghp', verifyRequest('builds', { baselineFingerprint: collected.fingerprint ?? null }));
    expect(withNewRun.changed).toBe(true);
  });

  it('releases 范围同时覆盖 releases 与 tags：可区分栏目、各自成功与覆盖版本', async () => {
    const releaseBody = { tag_name: 'v2', name: 'v2', published_at: '2026-10-05T00:00:00.000Z' };
    const route = routeFetch((path) => {
      if (path === '/repos/octo/demo/releases/latest') return releaseBody;
      if (path.startsWith('/repos/octo/demo/releases?')) return [releaseBody];
      if (path.startsWith('/repos/octo/demo/tags?')) return [{ name: 'v2', commit: { sha: 'tag-sha-2' } }];
      return httpStatus(404);
    });
    const request = { fullName: 'octo/demo', scope: 'releases' as const, defaultBranch: 'main', cursor: null, limit: 30, accessContextRevision: 5, observedAt: 'T' };
    const outcome = await compose(route.fetchImpl).fetchScope('ghp', request);

    expect(outcome.items).toEqual([
      { kind: 'release', tagName: 'v2', title: 'v2', publishedAt: '2026-10-05T00:00:00.000Z' },
      { kind: 'tag', name: 'v2', committedAt: null },
    ]);
    expect(outcome.parts?.releases).toMatchObject({ ok: true, hasMore: false });
    expect(outcome.parts?.tags).toMatchObject({ ok: true, hasMore: false });
    expect(outcome.version).toEqual({
      defaultBranch: 'main', headRevision: null,
      releaseRevision: JSON.stringify(['v2', 'v2', '2026-10-05T00:00:00.000Z']),
      tagRevision: JSON.stringify(['v2', 'tag-sha-2']),
    });
    expect(outcome.coverageComplete).toBe(true);
    expect(typeof outcome.fingerprint).toBe('string');

    // 采集指纹直接用于验证：同数据无变化，tag 前进即发现
    const stable = await compose(route.fetchImpl).verifyScopes('ghp', verifyRequest('releases', { baselineFingerprint: outcome.fingerprint ?? null }));
    expect(stable).toMatchObject({ changed: false, checkComplete: true });
    const driftedRoute = routeFetch((path) => {
      if (path === '/repos/octo/demo/releases/latest') return releaseBody;
      if (path.startsWith('/repos/octo/demo/releases?')) return [releaseBody];
      if (path.startsWith('/repos/octo/demo/tags?')) return [{ name: 'v3', commit: { sha: 'tag-sha-3' } }];
      return httpStatus(404);
    });
    const drifted = await compose(driftedRoute.fetchImpl).verifyScopes('ghp', verifyRequest('releases', { baselineFingerprint: outcome.fingerprint ?? null }));
    expect(drifted.changed).toBe(true);
  });

  it('releases 部分失败：保留 Release 结果与重试游标，不确认完整覆盖', async () => {
    const route = routeFetch((path) => {
      if (path.startsWith('/repos/octo/demo/releases?')) return [{ tag_name: 'v2', name: 'v2', published_at: null }];
      if (path.startsWith('/repos/octo/demo/tags?')) return new TypeError('fetch failed');
      return httpStatus(404);
    });
    const outcome = await compose(route.fetchImpl).fetchScope('ghp', { fullName: 'octo/demo', scope: 'releases', defaultBranch: 'main', cursor: null, limit: 30, accessContextRevision: 5, observedAt: 'T' });

    expect(outcome.coverageComplete).toBe(false);
    expect(outcome.parts?.tags?.ok).toBe(false);
    expect(outcome.items).toHaveLength(1);
    expect(outcome.version?.tagRevision).toBeNull();
    expect(outcome.fingerprint).toBeUndefined(); // 采集不完整不冒充完整基线
    const cursor = JSON.parse(outcome.nextCursor ?? '{}') as { t?: number | null };
    expect(cursor.t).toBe(1); // tags 留在原页可重试
  });

  it('Issue/PR 有界输出：窗口内用 off 续读，不跳过任何条目', async () => {
    const issueBody = (number: number, updatedAt: string) => ({ number, title: `条目 ${number}`, state: 'open', updated_at: updatedAt });
    const route = routeFetch((path) => {
      const url = new URL('https://api.github.com' + path);
      const page = Number(url.searchParams.get('page'));
      if (path.includes('/issues?')) return page === 1 ? [1, 2].map((number) => issueBody(number, `2026-10-05T0${number}:00:00.000Z`)) : [];
      if (path.includes('/pulls?')) return page === 1 ? [3, 4].map((number) => issueBody(number, `2026-10-05T0${number}:00:00.000Z`)) : [];
      return httpStatus(404);
    });
    const github = compose(route.fetchImpl);
    const request = { fullName: 'octo/demo', scope: 'issuesAndPr' as const, defaultBranch: 'main', cursor: null, limit: 2, accessContextRevision: 5, observedAt: 'T' };
    const numbersOf = (outcome: { items: unknown[] }) => (outcome.items as Array<{ number: number }>).map((item) => item.number);

    const first = await github.fetchScope('ghp', request);
    expect(numbersOf(first)).toEqual([4, 3]);
    expect(first.hasMore).toBe(true);
    expect((JSON.parse(first.nextCursor ?? '{}') as { off?: number }).off).toBe(2);

    const second = await github.fetchScope('ghp', { ...request, cursor: first.nextCursor });
    expect(numbersOf(second)).toEqual([2, 1]);

    const third = await github.fetchScope('ghp', { ...request, cursor: second.nextCursor });
    expect(third.items).toEqual([]);
    expect(third.coverageComplete).toBe(true);
    expect(third.nextCursor).toBeNull();
  });

  it('超过平台单页上限：按 100 读取并保留"还有更多"', async () => {
    const route = routeFetch((path) => {
      if (path.includes('/issues?')) return Array.from({ length: 100 }, (_item, index) => ({ number: index + 1, title: `条目 ${index + 1}`, state: 'open', updated_at: '2026-10-05T00:00:00.000Z' }));
      if (path.includes('/pulls?')) return [];
      return httpStatus(404);
    });
    const outcome = await compose(route.fetchImpl).fetchScope('ghp', { fullName: 'octo/demo', scope: 'issuesAndPr', defaultBranch: 'main', cursor: null, limit: 150, accessContextRevision: 5, observedAt: 'T' });
    expect(route.calls[0]).toContain('per_page=100');
    expect(outcome.items).toHaveLength(100);
    expect(outcome.hasMore).toBe(true); // 满页不得误判"没有更多"
  });

  it('Pulls 失败：保留 Issues 结果与可恢复游标，不确认完整覆盖', async () => {
    const route = routeFetch((path) => {
      if (path.includes('/issues?')) return [{ number: 1, title: '条目 1', state: 'open', updated_at: '2026-10-05T01:00:00.000Z' }];
      if (path.includes('/pulls?')) return new TypeError('fetch failed');
      return httpStatus(404);
    });
    const outcome = await compose(route.fetchImpl).fetchScope('ghp', { fullName: 'octo/demo', scope: 'issuesAndPr', defaultBranch: 'main', cursor: null, limit: 30, accessContextRevision: 5, observedAt: 'T' });
    expect(outcome.coverageComplete).toBe(false);
    expect(outcome.parts?.pullRequests?.ok).toBe(false);
    expect(outcome.items).toHaveLength(1);
    expect((JSON.parse(outcome.nextCursor ?? '{}') as { p?: number | null }).p).toBe(1); // 失败来源留原页可恢复
  });

  it('tree 有界输出与续读：按 offset 分页，末尾确认覆盖', async () => {
    const treePath = '/repos/octo/demo/git/trees/main?recursive=1';
    const route = routeFetch((path) => path === treePath
      ? { sha: 'tree-sha-1', truncated: false, tree: Array.from({ length: 5 }, (_item, index) => ({ path: `file-${index}.ts`, type: 'blob', size: index })) }
      : httpStatus(404));
    const github = compose(route.fetchImpl);
    const request = { fullName: 'octo/demo', scope: 'tree' as const, defaultBranch: 'main', cursor: null, limit: 2, accessContextRevision: 5, observedAt: 'T' };
    const pathsOf = (outcome: { items: unknown[] }) => (outcome.items as Array<{ path: string }>).map((item) => item.path);

    const first = await github.fetchScope('ghp', request);
    expect(pathsOf(first)).toEqual(['file-0.ts', 'file-1.ts']);
    expect(first.hasMore).toBe(true);
    expect(typeof first.fingerprint).toBe('string');
    const second = await github.fetchScope('ghp', { ...request, cursor: first.nextCursor });
    expect(pathsOf(second)).toEqual(['file-2.ts', 'file-3.ts']);
    const third = await github.fetchScope('ghp', { ...request, cursor: second.nextCursor });
    expect(pathsOf(third)).toEqual(['file-4.ts']);
    expect(third.coverageComplete).toBe(true);
    expect(third.nextCursor).toBeNull();
  });

  it('commits 游标绑定查询身份：分支变化从第一页重新开始', async () => {
    const route = routeFetch((path) => {
      const url = new URL('https://api.github.com' + path);
      return [{ sha: `sha-${url.searchParams.get('page')}-${url.searchParams.get('sha')}`, commit: { message: 'm' } }];
    });
    const github = compose(route.fetchImpl);
    const baseRequest = { fullName: 'octo/demo', scope: 'commits' as const, cursor: null, limit: 1, accessContextRevision: 5, observedAt: 'T' };
    const first = await github.fetchScope('ghp', { ...baseRequest, defaultBranch: 'main' });
    expect((JSON.parse(first.nextCursor ?? '{}') as { b?: string }).b).toBe('main');

    const second = await github.fetchScope('ghp', { ...baseRequest, defaultBranch: 'dev', cursor: first.nextCursor });
    expect(route.calls.at(-1)).toContain('page=1');
    expect(route.calls.at(-1)).toContain('sha=dev');
    expect((second.items[0] as { sha?: string } | undefined)?.sha).toContain('dev');
  });

  it('活动来源：区分 Issue 与 PR 并保留状态；适配器不判定重要性', async () => {
    const observe = async (collaboration: unknown) => compose(routeFetch(observationRoutes({ collaboration })).fetchImpl)
      .observeSummary('ghp', 'octo/demo', '2026-10-05T03:00:00.000Z', 5);

    const pr = await observe([{ number: 7, state: 'closed', updated_at: '2026-10-05T02:00:00.000Z', pull_request: { url: 'x' } }]);
    expect(pr.activity.collaboration).toEqual({ kind: 'pull-request', at: '2026-10-05T02:00:00.000Z', verified: true, state: 'closed' });
    expect(pr.activity.collaboration.important).toBeUndefined(); // 重要性由 domain/feature 判定
    expect(pr.activity.code).toEqual({ kind: 'code', at: '2026-10-05T01:00:00.000Z', verified: false }); // pushedAt 只是线索
    expect(pr.activity.release).toEqual({ kind: 'release', at: '2026-10-01T00:00:00.000Z', verified: true });

    const issue = await observe([{ number: 8, state: 'open', updated_at: '2026-10-05T02:10:00.000Z' }]);
    expect(issue.activity.collaboration).toEqual({ kind: 'issue', at: '2026-10-05T02:10:00.000Z', verified: true, state: 'open' });

    const failed = await observe(new TypeError('fetch failed'));
    expect(failed.activity.collaboration).toEqual({ kind: 'issue', at: null, verified: false }); // 失败不提供候选，保留策略在调用方
  });
});


describe('适配器窗口一致性审查（R4）', () => {
  const request = (scope: ScopeVerifyRequest['scope'], limit = 2) => ({ fullName: 'octo/demo', scope, defaultBranch: 'main', cursor: null as string | null, limit, accessContextRevision: 5, observedAt: '2026-10-05T03:00:00.000Z' });
  const issue = (number: number) => ({ number, title: '条目 ' + number, state: 'open', updated_at: '2026-10-05T0' + (5 - number) + ':00:00.000Z' });
  const release = (number: number) => ({ tag_name: 'v' + number, name: '发版 ' + number, published_at: null });
  const tag = (number: number) => ({ name: 't' + number, commit: { sha: 'sha-' + number } });
  const keys = (items: unknown[]) => items.map((item) => { const row = item as { number?: number; kind?: string; tagName?: string; name?: string }; return row.number ?? row.tagName ?? row.name; });

  it('Release/Tag 合并窗口按 limit 交付，未交付的来源不能确认覆盖', async () => {
    const route = routeFetch((path) => {
      const page = Number(new URL('https://api.github.com' + path).searchParams.get('page'));
      return page === 1 ? path.includes('/releases?') ? [release(2), release(1)] : [tag(2), tag(1)] : [];
    });
    const github = compose(route.fetchImpl);
    const first = await github.fetchScope('ghp', request('releases'));
    expect(keys(first.items)).toEqual(['v2', 'v1']);
    expect(first.coverageComplete).toBe(false);
    expect(first.parts?.releases?.coverageComplete).toBe(true);
    expect(first.parts?.tags?.coverageComplete).toBe(false);
    expect(first.parts?.tags?.fingerprint).toBeUndefined();
    const second = await github.fetchScope('ghp', { ...request('releases'), cursor: first.nextCursor });
    expect(keys(second.items)).toEqual(['t2', 't1']);
    expect(second.coverageComplete).toBe(true);
    expect(second.parts?.tags?.coverageComplete).toBe(true);
  });

  it.each(['issuesAndPr', 'releases'] as const)('%s 窗口内续读失败后保留原窗口，恢复时不漏项', async (scope) => {
    let failFirstSource = false;
    const route = routeFetch((path) => {
      const url = new URL('https://api.github.com' + path);
      if (Number(url.searchParams.get('page')) !== 1) return [];
      const firstSource = scope === 'issuesAndPr' ? path.includes('/issues?') : path.includes('/releases?');
      if (firstSource && failFirstSource) return new TypeError('暂时不可用');
      return scope === 'issuesAndPr' ? firstSource ? [issue(1), issue(2)] : [issue(3), issue(4)] : firstSource ? [release(2), release(1)] : [tag(2), tag(1)];
    });
    const github = compose(route.fetchImpl);
    const first = await github.fetchScope('ghp', request(scope));
    failFirstSource = true;
    const partial = await github.fetchScope('ghp', { ...request(scope), cursor: first.nextCursor });
    expect(partial.items).toHaveLength(2);
    expect(partial.coverageComplete).toBe(false);
    expect(partial.fingerprint).toBeUndefined();
    expect(partial.nextCursor).toBe(first.nextCursor);
    failFirstSource = false;
    const recovered = await github.fetchScope('ghp', { ...request(scope), cursor: partial.nextCursor });
    expect(keys(recovered.items)).toEqual(scope === 'issuesAndPr' ? [3, 4] : ['t2', 't1']);
    expect(recovered.coverageComplete).toBe(true);
    expect(new Set(keys([...first.items, ...recovered.items])).size).toBe(4);
  });

  it('首次 probe 采集双来源指纹，但不冒充验证旧缓存', async () => {
    const route = routeFetch((path) => path.includes('since=') || path.includes('/pulls?') ? [] : [issue(1)]);
    const github = compose(route.fetchImpl);
    const first = await github.verifyScopes('ghp', verifyRequest('issuesAndPr', { mode: 'probe', maxPages: 1 }));
    expect(first.checkComplete).toBe(false);
    expect(first.changed).toBe(false);
    expect(typeof first.fingerprint).toBe('string');
    expect(route.calls).toHaveLength(2);
  });

  it('构建窗口删除已完成记录时报告变化，不静默遗忘旧基线', async () => {
    let removed = false;
    const route = routeFetch(() => ({ workflow_runs: removed ? [] : [{ id: 1, run_attempt: 1, status: 'completed', conclusion: 'success' }] }));
    const github = compose(route.fetchImpl);
    const fetched = await github.fetchScope('ghp', request('builds'));
    removed = true;
    const result = await github.verifyScopes('ghp', verifyRequest('builds', { baselineFingerprint: fetched.fingerprint ?? null }));
    expect(result.changed).toBe(true);
    expect(result.checkComplete).toBe(true);
  });

  it('构建验证使用采集窗口大小，不把扩窗后的旧运行当作新增', async () => {
    const route = routeFetch((path) => {
      const size = Number(new URL('https://api.github.com' + path).searchParams.get('per_page'));
      return { workflow_runs: Array.from({ length: size }, (_value, index) => ({ id: index + 1, run_attempt: 1, status: 'completed', conclusion: 'success' })) };
    });
    const github = compose(route.fetchImpl);
    const fetched = await github.fetchScope('ghp', request('builds'));
    const result = await github.verifyScopes('ghp', verifyRequest('builds', { baselineFingerprint: fetched.fingerprint ?? null }));
    expect(result.changed).toBe(false);
    expect(result.checkComplete).toBe(true);
    expect(route.calls.at(-1)).toContain('per_page=2');
  });

  it.each(['commits', 'builds', 'releases'] as const)('%s 的分页大小改变后按新查询从首页开始', async (scope) => {
    const route = routeFetch((path) => {
      if (path.includes('/tags?')) return [];
      const url = new URL('https://api.github.com' + path);
      const size = Number(url.searchParams.get('per_page'));
      const page = Number(url.searchParams.get('page'));
      const numbers = Array.from({ length: size }, (_value, index) => (page - 1) * size + index + 1);
      if (scope === 'commits') return numbers.map((number) => ({ sha: 'sha-' + number, commit: { message: '提交 ' + number } }));
      if (scope === 'builds') return { workflow_runs: numbers.map((number) => ({ id: number, status: 'completed', conclusion: 'success' })) };
      return numbers.map(release);
    });
    const github = compose(route.fetchImpl);
    const first = await github.fetchScope('ghp', request(scope, 2));
    const resized = await github.fetchScope('ghp', { ...request(scope, 3), cursor: first.nextCursor });
    expect(resized.items).toHaveLength(3);
    expect(route.calls.at(-1)).toContain('page=1');
    expect(route.calls.at(-1)).toContain('per_page=3');
  });

  it.each(['builds', 'releases'] as const)('%s 仍接受旧数字字符串游标', async (scope) => {
    const route = routeFetch((path) => {
      if (path.includes('/tags?')) return [];
      const page = Number(new URL('https://api.github.com' + path).searchParams.get('page'));
      return scope === 'builds' ? { workflow_runs: [{ id: page, status: 'completed', conclusion: 'success' }] } : [release(page)];
    });
    const result = await compose(route.fetchImpl).fetchScope('ghp', { ...request(scope), cursor: '2' });
    expect(result.items).toHaveLength(1);
    expect(route.calls.every((path) => path.includes('page=2'))).toBe(true);
  });

  it('概览元数据编辑会改变指纹，单独摘要指标与推送线索不会', async () => {
    for (const patch of [{ description: '修改说明' }, { homepage: 'https://new.example' }, { license: { spdx_id: 'Apache-2.0' } }]) {
      let repo = { ...REPO_BODY, description: '说明', homepage: 'https://old.example', license: { spdx_id: 'MIT' } };
      const route = routeFetch((path) => path === '/repos/octo/demo' ? repo : observationRoutes()(path));
      const github = compose(route.fetchImpl);
      const fetched = await github.fetchScope('ghp', request('overview', 30));
      repo = { ...repo, ...patch };
      const result = await github.verifyScopes('ghp', verifyRequest('overview', { baselineFingerprint: fetched.fingerprint ?? null }));
      expect(result.changed).toBe(true);
    }
    let repo = { ...REPO_BODY };
    const route = routeFetch((path) => path === '/repos/octo/demo' ? repo : observationRoutes()(path));
    const github = compose(route.fetchImpl);
    const fetched = await github.fetchScope('ghp', request('overview', 30));
    repo = { ...repo, stargazers_count: 99, forks_count: 88, pushed_at: '2026-10-05T02:00:00.000Z' };
    const result = await github.verifyScopes('ghp', verifyRequest('overview', { baselineFingerprint: fetched.fingerprint ?? null }));
    expect(result.changed).toBe(false);
  });

  it.each(['release-edit', 'release-delete', 'tag-delete'])('发版窗口检测 %s，最新条目保持不变', async (mode) => {
    let edited = false;
    const route = routeFetch((path) => {
      if (path.includes('/releases?')) return [release(2), ...(edited && mode === 'release-delete' ? [] : [{ ...release(1), name: edited && mode === 'release-edit' ? '改名' : '发版 1' }])];
      if (path.includes('/tags?')) return [tag(2), ...(edited && mode === 'tag-delete' ? [] : [tag(1)])];
      return httpStatus(404);
    });
    const github = compose(route.fetchImpl);
    const fetched = await github.fetchScope('ghp', request('releases', 10));
    const stable = await github.verifyScopes('ghp', verifyRequest('releases', { baselineFingerprint: fetched.fingerprint ?? null }));
    expect(stable.changed).toBe(false);
    edited = true;
    const result = await github.verifyScopes('ghp', verifyRequest('releases', { baselineFingerprint: stable.fingerprint ?? null }));
    expect(result.changed).toBe(true);
    expect(result.checkComplete).toBe(true);
    expect(route.calls.at(-1)).toContain('per_page=10');
  });

  it('README 未交付完不确认覆盖，截断树的末尾不生成重复游标', async () => {
    const route = routeFetch((path) => path.includes('/contents')
      ? [1, 2].map((number) => ({ name: 'README.' + number, path: 'README.' + number, type: 'file', sha: 'sha-' + number }))
      : { sha: 'tree', truncated: true, tree: [{ path: 'file', type: 'blob' }] });
    const github = compose(route.fetchImpl);
    const readme = await github.fetchScope('ghp', request('readme', 1));
    expect(readme.coverageComplete).toBe(false);
    const tail = await github.fetchScope('ghp', { ...request('readme', 1), cursor: readme.nextCursor });
    expect(tail.coverageComplete).toBe(true);
    const tree = await github.fetchScope('ghp', request('tree', 1));
    expect(tree.coverageComplete).toBe(false);
    expect(tree.hasMore).toBe(true);
    expect(tree.nextCursor).toBeNull();
  });
});


describe('续读窗口变化与采集验证闭环', () => {
  const request = (scope: ScopeVerifyRequest['scope']) => ({ fullName: 'octo/demo', scope, defaultBranch: 'main', cursor: null as string | null, limit: 2, accessContextRevision: 5, observedAt: '2026-10-05T03:00:00.000Z' });

  it.each(['issuesAndPr', 'releases', 'readme', 'tree'] as const)('%s 窗口中删除条目后明确重启，不能沿旧 offset 漏项', async (scope) => {
    let removed = false;
    const route = routeFetch((path) => {
      const url = new URL('https://api.github.com' + path);
      if (url.searchParams.has('page') && url.searchParams.get('page') !== '1') return [];
      if (scope === 'issuesAndPr') {
        const numbers = path.includes('/issues?') ? removed ? [2] : [1, 2] : [3, 4];
        return numbers.map((number) => ({ number, title: '条目 ' + number, state: 'open', updated_at: '2026-10-05T0' + (5 - number) + ':00:00.000Z' }));
      }
      if (scope === 'releases') return path.includes('/releases?')
        ? (removed ? [2] : [2, 1]).map((number) => ({ tag_name: 'v' + number, name: '发版 ' + number }))
        : [2, 1].map((number) => ({ name: 't' + number, commit: { sha: 'sha-' + number } }));
      if (scope === 'readme') return (removed ? [2, 3] : [1, 2, 3]).map((number) => ({ name: 'README.' + number, path: 'README.' + number, type: 'file', sha: 'sha-' + number }));
      return { sha: removed ? 'tree-B' : 'tree-A', truncated: false, tree: (removed ? [2, 3] : [1, 2, 3]).map((number) => ({ path: 'file-' + number, type: 'blob' })) };
    });
    const github = compose(route.fetchImpl);
    const first = await github.fetchScope('ghp', request(scope));
    expect(first.nextCursor).not.toBeNull();
    removed = true;
    const restarted = await github.fetchScope('ghp', { ...request(scope), cursor: first.nextCursor });
    expect(restarted.windowRestarted).toBe(true);
    expect(restarted.coverageComplete).toBe(false);
    expect(restarted.items).toEqual([]);
    expect(restarted.fingerprint).toBeUndefined();
    let cursor = restarted.nextCursor;
    const assembled: unknown[] = [];
    for (let read = 0; read < 3; read += 1) {
      const next = await github.fetchScope('ghp', { ...request(scope), cursor });
      assembled.push(...next.items);
      if (next.coverageComplete) break;
      cursor = next.nextCursor;
    }
    const keys = assembled.map((item) => { const value = item as { number?: number; tagName?: string; name?: string; content?: string; path?: string }; return value.number ?? value.tagName ?? value.name ?? value.content ?? value.path; });
    expect(keys).toEqual(scope === 'issuesAndPr' ? [2, 3, 4] : scope === 'releases' ? ['v2', 't2', 't1'] : scope === 'readme' ? ['README.2', 'README.3'] : ['file-2', 'file-3']);
  });

  it.each(['issue-body', 'pull-fields'])('实际抓取指纹可直接验证同窗口，并检测同秒的 %s 变化', async (mode) => {
    let edited = false;
    const route = routeFetch((path) => {
      const pull = { number: 2, title: 'PR', body: 'PR 内容', state: 'open', user: { login: 'author' }, updated_at: '2026-10-05T02:00:00.000Z', draft: edited && mode === 'pull-fields', merged_at: null, head: { ref: edited && mode === 'pull-fields' ? 'changed' : 'feature' }, base: { ref: 'main' } };
      return path.includes('/issues?')
        ? [{ number: 1, title: 'Issue', body: edited && mode === 'issue-body' ? '更新内容' : '旧内容', state: 'open', user: { login: 'author' }, updated_at: '2026-10-05T02:00:00.000Z' }, { ...pull, pull_request: { url: 'pull' } }]
        : [pull];
    });
    const github = compose(route.fetchImpl);
    const fetched = await github.fetchScope('ghp', request('issuesAndPr'));
    expect(fetched.coverageComplete).toBe(true);
    expect(fetched.items[0]).toMatchObject({ kind: 'pull', draft: false, headBranch: 'feature', baseBranch: 'main' });
    const stable = await github.verifyScopes('ghp', verifyRequest('issuesAndPr', { mode: 'reread', maxPages: 3, baselineFingerprint: fetched.fingerprint ?? null }));
    expect(stable).toMatchObject({ changed: false, checkComplete: true });
    expect(route.calls.at(-1)).toContain('per_page=2');
    edited = true;
    const changed = await github.verifyScopes('ghp', verifyRequest('issuesAndPr', { mode: 'reread', maxPages: 3, baselineFingerprint: stable.fingerprint ?? null }));
    expect(changed).toMatchObject({ changed: true, checkComplete: true });
  });
});
