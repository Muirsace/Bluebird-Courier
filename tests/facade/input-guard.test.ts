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

async function hWithRepo(): Promise<Harness> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData());
  const added = await h().facade.addRepository('octo-demo/hello-world');
  if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
  return h();
}

/**
 * 渲染层传来的入参在运行期不可信（TS 类型擦除后什么都可能传进来）。
 * 错型入参不得让 better-sqlite3 的 RangeError 或 String 方法的 TypeError 穿出主进程。
 */
describe('门面入参守卫（错型入参不穿出原始引擎错误）', () => {
  it('加入清单：非字符串入参按格式错误拒绝，不落库', async () => {
    harness = createHarness();

    const result = await h().facade.addRepository({ fullName: 'octo-demo/hello-world' } as unknown as string);

    expect(result.ok).toBe(false);
    expect(result.repository).toBeNull();
    expect(result.error).toMatchObject({
      kind: 'not_found',
      message: '仓库名格式应为 owner/repo 或 GitHub 仓库网址',
    });
    const count = h().db.prepare('SELECT COUNT(*) AS n FROM repository').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('删除仓库：非数值标识不触碰数据库', async () => {
    await hWithRepo();

    await expect(h().facade.removeRepository({} as unknown as number)).resolves.toBeUndefined();

    const count = h().db.prepare('SELECT COUNT(*) AS n FROM repository').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('全量抓取：非数值标识按「监控仓库不存在」返回', async () => {
    harness = createHarness();

    const result = await h().facade.fetchDetail({} as unknown as number);

    expect(result).toMatchObject({
      detail: null,
      error: { kind: 'not_found', message: '监控仓库不存在' },
    });
  });

  it('偏好项：值非字符串的补丁整批拒绝，已有偏好不被污染', async () => {
    harness = createHarness();
    await h().facade.updateSettings({ theme: 'dark' });

    const view = await h().facade.updateSettings({
      theme: {},
      locale: 'zh-CN',
    } as unknown as Record<string, string>);

    expect(view.preferences).toEqual({ theme: 'dark' });
    expect((await h().facade.getSettings()).preferences).toEqual({ theme: 'dark' });
  });

  it('偏好项：非对象的补丁整批拒绝，不抛错', async () => {
    harness = createHarness();
    await h().facade.updateSettings({ theme: 'dark' });

    const view = await h().facade.updateSettings('theme=dark' as unknown as Record<string, string>);

    expect(view.preferences).toEqual({ theme: 'dark' });
  });
});
