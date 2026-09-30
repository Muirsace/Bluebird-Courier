import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData, type FakeRepoData } from '../helpers/fake-github';

let harness: Harness | null = null;

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

afterEach(() => {
  harness?.destroy();
  harness = null;
});

async function readyWithRepo(overrides: Partial<FakeRepoData> = {}): Promise<Harness> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData(overrides));
  const added = await h().facade.addRepository('octo-demo/hello-world');
  if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
  return h();
}

describe('全量信息抓取（详情页）', () => {
  it('返回五类更新的完整内容：发版 / 提交 / 议题与合并请求 / 构建状态 / 星标趋势', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;

    const result = await h().facade.fetchDetail(id);
    expect(result.error).toBeNull();
    const detail = result.detail!;
    expect(detail.repository).toMatchObject({ fullName: 'octo-demo/hello-world', stars: 1284 });
    expect(detail.releases).toEqual([
      { tagName: 'v2.4.0', title: 'v2.4.0 — 稳定性修复', publishedAt: '2026-09-20T12:00:00.000Z' },
      { tagName: 'v2.3.1', title: 'v2.3.1 — 补丁', publishedAt: '2026-08-11T09:00:00.000Z' },
    ]);
    expect(detail.commits).toEqual([
      { sha: 'a1b2c3d', message: '修复快照当日重复记档', authorName: 'octo-dev', committedAt: '2026-09-25T08:30:00.000Z' },
      { sha: 'e4f5a6b', message: '补充限流错误归一', authorName: 'octo-dev', committedAt: '2026-09-24T15:10:00.000Z' },
    ]);
    expect(detail.build).toMatchObject({ status: 'success', conclusion: 'success', workflowName: 'ci' });
    expect(detail.trend.length).toBeGreaterThanOrEqual(1);
  });

  it('议题与合并请求按 pull_request 标记拆分，分开展示', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;

    const detail = (await h().facade.fetchDetail(id)).detail!;
    expect(detail.issues).toEqual([
      { number: 42, title: '清单页刷新按钮无反馈', body: '刷新按钮应该显示进行中的状态。', state: 'open', authorName: 'user-a', updatedAt: '2026-09-25T02:00:00.000Z' },
    ]);
    expect(detail.pullRequests).toEqual([
      { number: 57, title: 'feat: 详情页构建徽章', body: '为详情页增加构建状态展示。', state: 'open', authorName: 'user-b', updatedAt: '2026-09-25T07:20:00.000Z' },
    ]);
  });

  it('构建结论归一为构建状态徽章', async () => {
    const cases: Array<{ resultDescription: string | null; status: 'success' | 'failure' | 'pending' | 'neutral'; expected: string }> = [
      { resultDescription: 'success', status: 'success', expected: 'success' },
      { resultDescription: 'failure', status: 'failure', expected: 'failure' },
      { resultDescription: 'timed_out', status: 'failure', expected: 'failure' },
      { resultDescription: 'cancelled', status: 'neutral', expected: 'neutral' },
      { resultDescription: null, status: 'pending', expected: 'pending' },
    ];
    for (const testCase of cases) {
      harness?.destroy();
      await readyWithRepo({
        build: {
          workflowName: 'ci',
          status: testCase.status,
          resultDescription: testCase.resultDescription,
          url: null,
          finishedAt: null,
        },
      });
      const id = (await h().facade.listRepositories())[0]!.id;
      const detail = (await h().facade.fetchDetail(id)).detail!;
      expect(detail.build.status).toBe(testCase.expected);
    }
  });

  it('没有构建的仓库显示"无构建"空态', async () => {
    await readyWithRepo({ build: null });
    const id = (await h().facade.listRepositories())[0]!.id;

    const detail = (await h().facade.fetchDetail(id)).detail!;
    expect(detail.build).toEqual({ status: 'none', conclusion: null, workflowName: null, url: null, finishedAt: null });
  });

  it('无发版时返回空发版列表（空态不报错）', async () => {
    await readyWithRepo({ releases: [], latestRelease: null });
    const id = (await h().facade.listRepositories())[0]!.id;

    const result = await h().facade.fetchDetail(id);
    expect(result.error).toBeNull();
    expect(result.detail!.releases).toEqual([]);
  });

  it('成功抓取记入历史快照（手动刷新同样记档），并更新最新发版标签', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;

    const data = h().github.repos.get('octo-demo/hello-world')!;
    data.releases = [
      { tagName: 'v3.0.0', title: 'v3.0.0', publishedAt: '2026-09-27T09:00:00.000Z' },
      ...data.releases,
    ];
    h().clock.set(new Date(2026, 8, 27, 12, 0, 0));
    await h().facade.fetchDetail(id);

    const rows = h().db.prepare('SELECT * FROM snapshot ORDER BY captured_at ASC').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ day: '2026-09-27', latest_release_tag: 'v3.0.0', stars: 1284 });

    const listed = await h().facade.listRepositories();
    expect(listed[0]).toMatchObject({
      latestReleaseTag: 'v3.0.0',
      fetchedAt: h().clock.now().toISOString(),
    });
  });

  it('趋势由历史快照序列构成并按时间升序', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 2000;
    h().clock.set(new Date(2026, 8, 27, 12, 0, 0));
    await h().facade.refreshGlance();

    const detail = (await h().facade.fetchDetail(id)).detail!;
    expect(detail.trend.map((s) => s.stars)).toEqual([1284, 2000]);
    const captured = detail.trend.map((s) => s.capturedAt);
    expect([...captured].sort()).toEqual(captured);
  });

  it('抓取失败：返回错误且不记档', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;
    h().github.networkDown = true;

    const result = await h().facade.fetchDetail(id);
    expect(result.detail).toBeNull();
    expect(result.error).toMatchObject({ kind: 'network', fullName: 'octo-demo/hello-world' });

    const count = h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('错误归一：404 → 不存在/无权限；限流带恢复时间；401 → 令牌无效', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;

    h().github.fail('octo-demo/hello-world', 'listReleases', fixtures.notFound());
    expect((await h().facade.fetchDetail(id)).error).toMatchObject({ kind: 'not_found' });

    const resetAt = new Date('2026-09-26T13:00:00.000Z');
    h().github.failures.clear();
    h().github.fail('octo-demo/hello-world', 'listCommits', fixtures.rateLimited(resetAt));
    expect((await h().facade.fetchDetail(id)).error).toMatchObject({
      kind: 'rate_limited',
      resetAt: resetAt.toISOString(),
    });

    h().github.failures.clear();
    h().github.accessTokenInvalid = true;
    expect((await h().facade.fetchDetail(id)).error).toMatchObject({ kind: 'access_token_invalid' });
  });

  it('限流归一不依赖恢复时间头（无 reset/retry-after 也报限流）', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;

    h().github.fail('octo-demo/hello-world', 'listReleases', fixtures.rateLimitedNoReset());
    const first = await h().facade.fetchDetail(id);
    expect(first.error?.kind).toBe('rate_limited');
    expect(first.error?.resetAt).toBeUndefined();

    h().github.failures.clear();
    h().github.fail('octo-demo/hello-world', 'listReleases', fixtures.tooManyRequests());
    const second = await h().facade.fetchDetail(id);
    expect(second.error?.kind).toBe('rate_limited');
  });
});
