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

async function hWithRepo(): Promise<{ harness: Harness; id: number }> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData());
  const added = await h().facade.addRepository('octo-demo/hello-world');
  if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
  const id = (await h().facade.listRepositories())[0]!.id;
  return { harness: h(), id };
}

/**
 * 展示字段与当日快照必须同进同退。用「丢掉 snapshot 表」注入记档失败：
 * 若两条语句不在同一事务里，展示字段会被单独提交，留下"已标记抓取成功、当日却缺一档"的中间态。
 */
describe('抓取落库的原子性（展示字段与当日快照同进同退）', () => {
  it('轻量抓取：记档失败时展示字段一并回滚', async () => {
    const { id } = await hWithRepo();
    const before = h().db.prepare('SELECT stars, fetched_at FROM repository WHERE id = ?').get(id);
    h().db.exec('DROP TABLE snapshot');
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 9999;

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(h().db.prepare('SELECT stars, fetched_at FROM repository WHERE id = ?').get(id)).toEqual(before);
  });

  it('全量抓取：记档失败时发版标签一并回滚', async () => {
    const { id } = await hWithRepo();
    const before = h().db.prepare('SELECT latest_release_tag, fetched_at FROM repository WHERE id = ?').get(id);
    h().db.exec('DROP TABLE snapshot');
    h().github.repos.get('octo-demo/hello-world')!.releases = [
      { tagName: 'v9.9.9', title: 'v9.9.9', publishedAt: '2026-09-27T09:00:00.000Z' },
    ];

    const result = await h().facade.fetchDetail(id);

    expect(result.detail).toBeNull();
    expect(result.error).not.toBeNull();
    expect(h().db.prepare('SELECT latest_release_tag, fetched_at FROM repository WHERE id = ?').get(id)).toEqual(before);
  });
});
