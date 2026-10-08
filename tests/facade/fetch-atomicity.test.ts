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
 * - 分级提交（步骤 8B）：成功范围的数据、确认与错误记录共用同一事务；
 *   任一步骤失败都整体回滚，不产生半套写入。
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

  it('分级提交共用单一事务：后写范围失败时，先前范围的内容与确认一并回滚', async () => {
    const { id } = await hWithRepo();
    await h().facade.fetchDetail(id); // 建立缓存与全部范围基线
    const before = h().db.prepare('SELECT fetched_at, payload FROM detail_cache WHERE repository_id = ?').get(id);
    const beforeCommits = h().db.prepare("SELECT synced_fingerprint, synced_revision, last_synced_at FROM detail_scope_state WHERE repository_id = ? AND scope = 'commits'").get(id);

    // 远端发版前进（releases 范围会先于构建写入）；构建栏目写入注入失败
    const data = h().github.repos.get('octo-demo/hello-world')!;
    data.releases = [{ tagName: 'v9.9.9', title: 'v9.9.9', publishedAt: null }, ...data.releases];
    h().db.exec("CREATE TRIGGER fail_builds_column BEFORE UPDATE ON detail_column WHEN NEW.column_name = 'builds' BEGIN SELECT RAISE(ABORT, '注入的栏目写入失败'); END");

    const forced = await h().facade.refreshRepository!(id, true);

    expect(forced.detail).not.toBeNull(); // 旧内容继续展示
    expect(forced.error?.message).toContain('注入的栏目写入失败');
    expect(h().db.prepare('SELECT fetched_at, payload FROM detail_cache WHERE repository_id = ?').get(id)).toEqual(before); // 先前写入的范围内容一并回滚
    expect(h().db.prepare("SELECT synced_fingerprint, synced_revision, last_synced_at FROM detail_scope_state WHERE repository_id = ? AND scope = 'commits'").get(id)).toEqual(beforeCommits); // 确认与数据同进同退
  });

  it('供应商阻塞后的部分提交同样共用一个事务：账本写入失败时已成功范围一起回滚', async () => {
    const { id } = await hWithRepo();
    await h().facade.fetchDetail(id); // 建立缓存与全部范围基线
    const data = h().github.repos.get('octo-demo/hello-world')!;
    data.releases = [{ tagName: 'v9.9.9', title: 'v9.9.9', publishedAt: null }, ...data.releases];
    // 树范围被限流：本轮按部分结果提交（发版已成功取得），但账本写入失败时不得留下半套
    h().github.setScopeFetch('octo-demo/hello-world', 'tree', async () => { throw fixtures.rateLimited(new Date('2026-09-26T09:00:00.000Z')); });
    const before = h().db.prepare('SELECT fetched_at, payload FROM detail_cache WHERE repository_id = ?').get(id);
    h().db.exec("CREATE TRIGGER fail_scope_update BEFORE UPDATE ON detail_scope_state BEGIN SELECT RAISE(ABORT, '注入的账本写入失败'); END");

    const forced = await h().facade.refreshRepository!(id, true);

    expect(forced.error).not.toBeNull();
    expect(h().db.prepare('SELECT fetched_at, payload FROM detail_cache WHERE repository_id = ?').get(id)).toEqual(before); // 已取得的发版内容也随确认一起回滚
    expect((JSON.parse((before as { payload: string }).payload) as { values: { releases: Array<{ tagName: string }> } }).values.releases.map(entry => entry.tagName)).not.toContain('v9.9.9');
  });
});
