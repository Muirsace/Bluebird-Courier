import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';

let harness: Harness | null = null;

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

afterEach(() => {
  harness?.destroy();
  harness = null;
});

async function ready(): Promise<Harness> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  return h();
}

describe('仓库清单 feature', () => {
  it('加入清单：立即抓取轻量信息并落库，同时记一档历史快照', async () => {
    await ready();
    h().github.addRepo(makeRepoData());

    const result = await h().facade.addRepository('octo-demo/hello-world');
    expect(result.ok).toBe(true);
    expect(result.repository).toMatchObject({
      owner: 'octo-demo',
      name: 'hello-world',
      fullName: 'octo-demo/hello-world',
      stars: 1284,
      forks: 96,
      openIssues: 23,
      pushedAt: '2026-09-25T08:30:00.000Z',
      latestReleaseTag: 'v2.4.0',
      fetchedAt: h().clock.now().toISOString(),
    });

    const row = h()
      .db.prepare("SELECT * FROM repository WHERE full_name = 'octo-demo/hello-world'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({ owner: 'octo-demo', name: 'hello-world', stars: 1284, latest_release_tag: 'v2.4.0' });

    const snapshot = h().db.prepare('SELECT * FROM snapshot').get() as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      stars: 1284,
      forks: 96,
      open_issues: 23,
      latest_release_tag: 'v2.4.0',
      day: '2026-09-26',
    });
  });

  it('列举返回轻量信息（star、最近动态时间、最新发版标签）', async () => {
    await ready();
    h().github.addRepo(makeRepoData());
    await h().facade.addRepository('octo-demo/hello-world');

    const listed = await h().facade.listRepositories();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      fullName: 'octo-demo/hello-world',
      stars: 1284,
      pushedAt: '2026-09-25T08:30:00.000Z',
      latestReleaseTag: 'v2.4.0',
    });
  });

  it('按最近添加优先排序；同时间由 id 决胜，重复、刷新与重启都保持顺序', async () => {
    await ready();
    const base = makeRepoData();
    const names = ['acme/first', 'acme/second', 'acme/third'];

    for (const [index, fullName] of names.entries()) {
      h().github.addRepo({ ...base, meta: { ...base.meta, fullName } });
      const result = await h().facade.addRepository(fullName);
      expect(result.ok).toBe(true);
      if (index === 1) h().clock.advanceMs(1000);
    }

    const expected = ['acme/third', 'acme/second', 'acme/first'];
    const orderedNames = async (): Promise<string[]> =>
      (await h().facade.listRepositories()).map((repository) => repository.fullName);

    expect(await orderedNames()).toEqual(expected);

    const duplicate = await h().facade.addRepository('acme/second');
    expect(duplicate.ok).toBe(false);
    expect(await orderedNames()).toEqual(expected);

    await h().facade.refreshGlance();
    expect(await orderedNames()).toEqual(expected);

    h().reopen();
    expect(await orderedNames()).toEqual(expected);
  });

  it('加入不存在或无权访问的仓库（404）保留失败卡片供重试', async () => {
    await ready();

    const result = await h().facade.addRepository('octo-demo/ghost');
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: 'not_found', fullName: 'octo-demo/ghost' });
    expect(await h().facade.listRepositories()).toMatchObject([
      { fullName: 'octo-demo/ghost', stars: null, failure: { kind: 'not_found' } },
    ]);
    const row = h().db.prepare('SELECT COUNT(*) AS n FROM repository').get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('加入时网络失败保留失败卡片供单仓库重试', async () => {
    await ready();
    h().github.networkDown = true;

    const result = await h().facade.addRepository('octo-demo/hello-world');
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: 'network' });
    expect(await h().facade.listRepositories()).toMatchObject([
      { fullName: 'octo-demo/hello-world', stars: null, failure: { kind: 'network' } },
    ]);
  });

  it.each([
    ['裸仓库名', 'not-a-repo'],
    ['网址缺仓库名', 'https://github.com/only-owner'],
    ['夹空格的脏输入', ' octo demo/hello '],
  ])('格式不识别（%s）报错文案涵盖两种输入形态', async (_label, input) => {
    await ready();

    const result = await h().facade.addRepository(input);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('not_found');
    expect(result.error?.message).toContain('owner/repo');
    expect(result.error?.message).toContain('网址');
  });

  it('重复加入同一仓库报错，清单不重复', async () => {
    await ready();
    h().github.addRepo(makeRepoData());
    await h().facade.addRepository('octo-demo/hello-world');

    const again = await h().facade.addRepository('octo-demo/hello-world');
    expect(again.ok).toBe(false);
    expect(await h().facade.listRepositories()).toHaveLength(1);
  });

  it('大小写不同的同一仓库重复加入被拒，清单不重复', async () => {
    await ready();
    h().github.addRepo(makeRepoData());
    await h().facade.addRepository('octo-demo/hello-world');

    const again = await h().facade.addRepository('https://github.com/Octo-Demo/Hello-World');
    expect(again.ok).toBe(false);
    expect(await h().facade.listRepositories()).toHaveLength(1);
  });

  it('落库使用 GitHub 返回的规范 full_name', async () => {
    await ready();
    h().github.addRepo(makeRepoData({ meta: { ...makeRepoData().meta, fullName: 'Octo-Demo/Hello-World' } }));

    const result = await h().facade.addRepository('octo-demo/hello-world');
    expect(result.ok).toBe(true);
    const listed = await h().facade.listRepositories();
    expect(listed[0]).toMatchObject({
      owner: 'Octo-Demo',
      name: 'Hello-World',
      fullName: 'Octo-Demo/Hello-World',
    });
  });

  it('从清单删除监控仓库', async () => {
    await ready();
    h().github.addRepo(makeRepoData());
    const added = await h().facade.addRepository('octo-demo/hello-world');

    await h().facade.removeRepository(added.repository!.id);
    expect(await h().facade.listRepositories()).toEqual([]);
  });

  it('清单关闭重开后依然存在（持久化）', async () => {
    await ready();
    h().github.addRepo(makeRepoData());
    await h().facade.addRepository('octo-demo/hello-world');

    const reopened = h().reopen();
    const listed = await reopened.facade.listRepositories();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ fullName: 'octo-demo/hello-world', stars: 1284 });
    expect(await reopened.facade.accessTokenState()).toEqual({ configured: true });
  });

  it('加入清单：GitHub 网址加入成功并归一为 owner/name', async () => {
    await ready();
    h().github.addRepo(makeRepoData());

    const result = await h().facade.addRepository('https://github.com/octo-demo/hello-world');
    expect(result.ok).toBe(true);
    expect(result.repository).toMatchObject({
      owner: 'octo-demo',
      name: 'hello-world',
      fullName: 'octo-demo/hello-world',
    });
  });

  it.each([
    ['根路径', 'https://github.com/octo-demo/hello-world'],
    ['尾斜杠', 'https://github.com/octo-demo/hello-world/'],
    ['.git 后缀', 'https://github.com/octo-demo/hello-world.git'],
    ['根路径重复', 'https://github.com/octo-demo/hello-world'],
    ['http 与 www', 'http://www.github.com/octo-demo/hello-world'],
  ])('加入清单：网址变体（%s）归一为同一仓库', async (_label, input) => {
    await ready();
    h().github.addRepo(makeRepoData());

    const result = await h().facade.addRepository(input);
    expect(result.ok).toBe(true);
    expect(result.repository).toMatchObject({ fullName: 'octo-demo/hello-world' });
  });

  it('加入清单：git@ SSH 形态归一为 owner/name', async () => {
    await ready();
    h().github.addRepo(makeRepoData());

    const result = await h().facade.addRepository('git@github.com:octo-demo/hello-world.git');
    expect(result.ok).toBe(true);
    expect(result.repository).toMatchObject({ fullName: 'octo-demo/hello-world' });
  });

  it.each([
    ['非 GitHub 网址', 'https://gitee.com/octo-demo/hello-world'],
    ['非 GitHub SSH', 'git@gitlab.com:octo-demo/hello-world.git'],
  ])('%s：明确报错且不入列', async (_label, input) => {
    await ready();

    const result = await h().facade.addRepository(input);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('github.com');
    expect(await h().facade.listRepositories()).toEqual([]);
  });
});
