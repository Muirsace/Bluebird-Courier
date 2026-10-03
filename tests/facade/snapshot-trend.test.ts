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

async function readyWithRepo(): Promise<Harness> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData());
  await h().facade.addRepository('octo-demo/hello-world');
  return h();
}

function snapshotRows(): Array<Record<string, unknown>> {
  return h()
    .db.prepare('SELECT * FROM snapshot ORDER BY captured_at ASC')
    .all() as Array<Record<string, unknown>>;
}

describe('快照趋势 feature', () => {
  it('同一天多次抓取只留一档，手动刷新覆盖为最新值', async () => {
    await readyWithRepo();
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 2000;

    h().clock.advanceMs(2 * 3600_000); // 当天晚些时候手动刷新
    const refreshed = await h().facade.refreshGlance();
    expect(refreshed.errors).toEqual([]);

    const rows = snapshotRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: '2026-09-26',
      stars: 2000,
      captured_at: h().clock.now().toISOString(),
    });
  });

  it('第二天抓取新增一档，趋势按时间升序', async () => {
    await readyWithRepo();
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 2000;

    h().clock.set(new Date(2026, 8, 27, 12, 0, 0));
    await h().facade.refreshGlance();

    const rows = snapshotRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.day)).toEqual(['2026-09-26', '2026-09-27']);
    expect(rows.map((r) => r.stars)).toEqual([1284, 2000]);
  });

  it('缺省值记空（无发版 → 空标签）', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');
    h().github.addRepo(makeRepoData({ latestRelease: null, releases: [] }));
    await h().facade.addRepository('octo-demo/hello-world');

    const rows = snapshotRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: '2026-09-26', latest_release_tag: null });
  });

  it('抓取失败不记档', async () => {
    await readyWithRepo();
    h().github.networkDown = true;

    h().clock.advanceMs(2 * 3600_000);
    const result = await h().facade.refreshGlance();
    expect(result.errors).toHaveLength(1);

    const rows = snapshotRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stars: 1284, captured_at: rows[0]!.captured_at });
  });

  it('历史快照随使用自然积累（多次抓取跨多天）', async () => {
    await readyWithRepo();
    for (const day of [27, 28, 30]) {
      h().clock.set(new Date(2026, 8, day, 12, 0, 0));
      await h().facade.refreshGlance();
    }
    expect(snapshotRows()).toHaveLength(4);
  });
});
