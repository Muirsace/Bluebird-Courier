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
 * 展开落库的原子性：
 * - 轻量检查：Summary、观察信号与待交接记录同事务保存（步骤 6）；趋势快照失败只记录，
 *   不回滚已成功保存的摘要、也不吞掉重要变化（设计 14.2）。
 * - 全量抓取：展示字段与当日快照仍同进同退（既有行为）。
 */
describe('抓取落库的原子性', () => {
  it('轻量检查：快照写失败不回滚摘要（设计 14.2：记录并继续）', async () => {
    const { id } = await hWithRepo();
    h().db.exec('DROP TABLE snapshot');
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 9999;

    const result = await h().facade.refreshGlance();

    expect(result.errors).toEqual([]);
    expect(h().db.prepare('SELECT stars FROM repository WHERE id = ?').get(id)).toEqual({ stars: 9999 });
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
