import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';

/**
 * 历史续读游标（任务 01）：绑定仓库、访问上下文、内容版本与栏目；
 * 裸 offset 旧格式不被接受；后台换版后旧游标不能继续消费新列表；
 * 读取在 SQLite 内按栏目有界取回本页，不整份解析 payload。
 */

const NAME = 'octo-demo/hello-world';

let harness: Harness | null = null;
function h(): Harness { if (!harness) throw new Error('测试台未初始化'); return harness; }
afterEach(() => { harness?.destroy(); harness = null; });

async function cached(): Promise<number> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData());
  const added = await h().facade.addRepository(NAME);
  if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
  const id = (await h().facade.listRepositories())[0]!.id;
  if (!(await h().facade.fetchDetail(id)).detail) throw new Error('detail setup failed');
  h().github.resetCalls();
  return id;
}

/** 直接替换详情缓存中的提交列表（不触碰视图版本，用于构造长历史）。 */
function setCommits(id: number, count: number): void {
  const row = h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string };
  const cache = JSON.parse(row.payload) as { values: Record<string, unknown> };
  cache.values.commits = Array.from({ length: count }, (_, i) => ({ sha: 's' + i, message: 'm' + i, authorName: null, committedAt: '2026-09-26T00:00:00.000Z' }));
  h().db.prepare('UPDATE detail_cache SET payload = ? WHERE repository_id = ?').run(JSON.stringify(cache), id);
}

describe('历史续读游标：版本隔离与有界读取', () => {
  it('游标绑定仓库、栏目与内容版本；旧裸 offset 不被接受，续读完整无重复', async () => {
    const id = await cached();
    setCommits(id, 45);

    const first = await h().facade.loadHistory!(id, 'commits');
    expect(first.items).toHaveLength(30);
    expect(first.hasMore).toBe(true);
    const cursor = JSON.parse(first.nextCursor!) as Record<string, unknown>;
    expect(cursor).toMatchObject({ repositoryId: id, kind: 'commits', offset: 30 });
    expect(typeof cursor.viewVersion).toBe('number');

    // 旧格式（裸 offset 字符串）不是当前安全游标：不得当 offset=30 继续消费
    const legacy = await h().facade.loadHistory!(id, 'commits', '30');
    expect(legacy).toEqual({ items: [], nextCursor: null, hasMore: false });

    // 换栏目：同一游标不能用于其他栏目
    const wrongKind = await h().facade.loadHistory!(id, 'issues', first.nextCursor!);
    expect(wrongKind).toEqual({ items: [], nextCursor: null, hasMore: false });

    // 正常续读到底：不漏项、不重复，到底后无游标
    const second = await h().facade.loadHistory!(id, 'commits', first.nextCursor!);
    expect(second.items).toHaveLength(15);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    const shas = [...first.items, ...second.items].map(item => (item as { sha: string }).sha);
    expect(shas).toHaveLength(45);
    expect(new Set(shas).size).toBe(45);
  });

  it('后台换版后旧游标不能继续消费新列表', async () => {
    const id = await cached();
    setCommits(id, 45);
    const first = await h().facade.loadHistory!(id, 'commits');
    expect(first.items).toHaveLength(30);

    // 强制同步重写内容：内容版本与完整抓取时间都变化
    await h().facade.refreshRepository!(id, true);

    const stale = await h().facade.loadHistory!(id, 'commits', first.nextCursor!);
    expect(stale).toEqual({ items: [], nextCursor: null, hasMore: false });
    // 新一轮从头读取使用新内容（fixture 只有 2 条提交），不是旧窗口的续页
    const fresh = await h().facade.loadHistory!(id, 'commits');
    expect(fresh.items).toHaveLength(2);
    expect(fresh.hasMore).toBe(false);
  });

  it('观察应用等账本写入也递增内容版本，同样使旧游标失效', async () => {
    const id = await cached();
    setCommits(id, 45);
    const first = await h().facade.loadHistory!(id, 'commits');

    h().repositoryDetail.applyObservation({
      repoId: id, observationId: 'history-version', accessContextRevision: 0, detectedAt: '2026-09-26T01:00:00.000Z',
      changeSet: { repoId: id, starsChanged: false, forksChanged: false, headChanged: true, releaseChanged: false,
        tagChanged: false, issuesChanged: false, buildsChanged: false, defaultBranchChanged: false,
        previousHeadRevision: 'a', currentHeadRevision: 'b', affectedScopes: ['commits'], detectedAt: '2026-09-26T01:00:00.000Z' },
    }, h().clock.now().toISOString());

    const stale = await h().facade.loadHistory!(id, 'commits', first.nextCursor!);
    expect(stale.items).toEqual([]);
  });

  it('跨仓库与跨访问上下文的游标不能继续消费', async () => {
    const id = await cached();
    setCommits(id, 45);
    const first = await h().facade.loadHistory!(id, 'commits');

    // 跨仓库：B 有同构缓存，但游标绑定 A 的标识
    const other = h().repositoryList.createPending('acme/other');
    const payload = h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string };
    const otherCache = JSON.parse(payload.payload) as { repositoryId: number };
    otherCache.repositoryId = other.id;
    h().db.prepare('INSERT INTO detail_cache (repository_id, payload, fetched_at, schema_version, access_context_revision) VALUES (?, ?, ?, 1, 0)')
      .run(other.id, JSON.stringify(otherCache), h().clock.now().toISOString());
    const foreign = await h().facade.loadHistory!(other.id, 'commits', first.nextCursor!);
    expect(foreign.items).toEqual([]);

    // 跨上下文：推进访问上下文后旧游标失效
    h().tokenSettings.advanceAccessContext(h().clock.now().toISOString());
    const crossed = await h().facade.loadHistory!(id, 'commits', first.nextCursor!);
    expect(crossed.items).toEqual([]);
  });

  it('长列表读取在 SQLite 内按栏目取回本页，不整份解析 payload', async () => {
    const id = await cached();
    setCommits(id, 5000);
    const parse = vi.spyOn(JSON, 'parse');
    const page = await h().facade.loadHistory!(id, 'commits');
    expect(page.items).toHaveLength(30);
    // 只解析本页条目（及既有元信息），不得出现整份 values 的 JSON.parse
    expect(parse.mock.calls.some(([input]) => String(input).includes('"values"'))).toBe(false);
    expect(h().github.calls).toEqual({});
  });
});
