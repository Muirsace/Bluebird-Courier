import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData } from '../helpers/fake-github';

let harness: Harness | null = null;

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

afterEach(() => {
  harness?.destroy();
  harness = null;
});

async function readyWithRepos(fullNames: string[]): Promise<Harness> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  for (const fullName of fullNames) {
    h().github.addRepo(makeRepoData({ meta: { ...makeRepoData().meta, fullName } }));
    await h().facade.addRepository(fullName);
  }
  return h();
}

describe('轻量信息抓取（清单页）', () => {
  it('重新抓取所有监控仓库的轻量信息并更新落库', async () => {
    await readyWithRepos(['octo-demo/hello-world']);
    const data = h().github.repos.get('octo-demo/hello-world')!;
    data.meta.stars = 2000;
    data.latestRelease = { tagName: 'v3.0.0', title: 'v3.0.0', publishedAt: '2026-09-26T09:00:00.000Z' };

    h().clock.advanceMs(60_000);
    const result = await h().facade.refreshGlance();

    expect(result.errors).toEqual([]);
    expect(result.repositories[0]).toMatchObject({
      fullName: 'octo-demo/hello-world',
      stars: 2000,
      latestReleaseTag: 'v3.0.0',
      fetchedAt: h().clock.now().toISOString(),
    });
  });

  it('网络失败：保留上次数据并附网络失败错误', async () => {
    await readyWithRepos(['octo-demo/hello-world']);
    const fetchedAtBefore = h().clock.now().toISOString();
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 2000;
    h().github.networkDown = true;

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ kind: 'network', fullName: 'octo-demo/hello-world' });
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]).toMatchObject({ stars: 1284, fetchedAt: fetchedAtBefore });
  });

  it('限流：只报一次限流且带恢复时间，其余仓库保留上次数据', async () => {
    const resetAt = new Date('2026-09-26T13:00:00.000Z');
    await readyWithRepos(['octo-demo/hello-world', 'octo-demo/second-repo']);
    h().github.fail('*', 'getRepositoryMeta', fixtures.rateLimited(resetAt));

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      kind: 'rate_limited',
      resetAt: resetAt.toISOString(),
    });
    expect(result.repositories).toHaveLength(2);
    expect(result.repositories.every((r) => r.stars === 1284)).toBe(true);
  });

  it('令牌失效（401）：只报一次令牌无效并引导设置', async () => {
    await readyWithRepos(['octo-demo/hello-world', 'octo-demo/second-repo']);
    h().github.accessTokenInvalid = true;

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ kind: 'access_token_invalid' });
    expect(result.repositories).toHaveLength(2);
  });

  it('部分仓库抓取失败不影响其他仓库', async () => {
    await readyWithRepos(['octo-demo/hello-world', 'octo-demo/second-repo']);
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 2000;
    h().github.fail('octo-demo/second-repo', 'getRepositoryMeta', fixtures.notFound());

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ kind: 'not_found', fullName: 'octo-demo/second-repo' });
    expect(result.repositories.find((r) => r.fullName === 'octo-demo/hello-world')).toMatchObject({ stars: 2000 });
    expect(result.repositories.find((r) => r.fullName === 'octo-demo/second-repo')).toMatchObject({ stars: 1284 });
  });

  it('没有监控仓库时返回空清单且无错误', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');

    const result = await h().facade.refreshGlance();
    expect(result).toEqual({ repositories: [], errors: [] });
  });

  it('未配置令牌时提示先配置访问令牌', async () => {
    harness = createHarness();
    const result = await h().facade.refreshGlance();
    expect(result).toEqual({ repositories: [], errors: [] });
  });
});
