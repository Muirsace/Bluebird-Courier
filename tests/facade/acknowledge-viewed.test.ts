import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';

/**
 * 展示确认闭环（任务 01）：确认只推进实际已同步的重要基线，
 * 待同步的新变化保留未查看；旧版本 / 跨上下文 / 跨仓库 / 无效输入保守忽略；
 * 确认无网络副作用、无 Token 要求，也不改写详情视图版本（不制造反馈循环）。
 */

const NAME = 'octo-demo/hello-world';

let harness: Harness | null = null;
function h(): Harness { if (!harness) throw new Error('测试台未初始化'); return harness; }
afterEach(() => { vi.restoreAllMocks(); harness?.destroy(); harness = null; });

async function readyWithCache(): Promise<{ id: number }> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData({ observation: { head: 'sha-a' } }));
  const added = await h().facade.addRepository(NAME);
  if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
  const id = (await h().facade.listRepositories())[0]!.id;
  const fetched = await h().facade.fetchDetail(id);
  if (!fetched.detail) throw new Error('detail setup failed');
  h().github.resetCalls();
  return { id };
}

/** 制造真实交接：先建立观察基线，再推进 HEAD，第二次轻量检查产生待交接记录。 */
async function produceHeadHandoff(): Promise<void> {
  await h().facade.refreshGlance();
  h().github.repos.get(NAME)!.observation!.head = 'sha-b';
  h().clock.advanceMs(60_000);
  await h().facade.refreshGlance();
}

async function waitTaskSettled(id: number): Promise<void> {
  await vi.waitFor(async () => {
    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.task).toBeNull();
  });
}

function scopeRow(id: number, scope: string): Record<string, unknown> {
  return h().db.prepare('SELECT * FROM detail_scope_state WHERE repository_id = ? AND scope = ? ORDER BY access_context_revision DESC').get(id, scope) as Record<string, unknown>;
}

/** 直接改写详情缓存中的栏目内容（不触碰视图版本，用于构造损坏/长列表内容）。 */
function setValues(id: number, patch: Record<string, unknown>): void {
  const row = h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string };
  const cache = JSON.parse(row.payload) as { values: Record<string, unknown> };
  Object.assign(cache.values, patch);
  h().db.prepare('UPDATE detail_cache SET payload = ? WHERE repository_id = ?').run(JSON.stringify(cache), id);
}

/** 造出"已同步 1 个重要版本但尚未查看"的账本，用于验证确认范围。 */
function markSyncedUnseen(id: number, scopes: readonly string[]): void {
  for (const scope of scopes) {
    h().db.prepare("UPDATE detail_scope_state SET detected_revision = 1, synced_revision = 1, important_revision = 1, viewed_revision = 0 WHERE repository_id = ? AND scope = ?").run(id, scope);
  }
}

describe('展示确认：只推进已同步基线', () => {
  it('旧缓存A看到后B未同步仍未看；B 同步完成后再次确认才清除', async () => {
    const { id } = await readyWithCache();
    await produceHeadHandoff();
    h().github.repos.get(NAME)!.commits[0]!.sha = 'sha-b'; // 远端已提供B，本地仍是A；后续只确认实际抓到的B。
    const release = h().github.holdNext('listReleases'); // 挂住后台同步，先完成确认
    const opened = await h().facade.fetchDetail(id);
    expect(opened.detail).not.toBeNull();
    expect(opened.detailViewVersion).toBeGreaterThanOrEqual(1);

    const acked = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: opened.detailViewVersion!,
      accessContextRevision: opened.accessContextRevision!,
      scopes: ['overview', 'commits', 'builds', 'readme', 'tree'],
    });
    // B 的重要版本仍未查看：确认只到 min(synced=0, important=1)
    expect(acked).toEqual({ ok: true, seenRevision: 1 });
    expect(scopeRow(id, 'commits')).toMatchObject({ detected_revision: 1, synced_revision: 0, important_revision: 1, viewed_revision: 0 });

    release();
    await waitTaskSettled(id);
    const synced = await h().facade.readLocalDetail(id, { scopes: ['commits'] });
    const cleared = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: synced.detailViewVersion,
      accessContextRevision: synced.accessContextRevision,
      scopes: ['overview', 'commits', 'builds', 'readme', 'tree'],
    });
    expect(cleared).toEqual({ ok: true, seenRevision: 0 });
    expect(scopeRow(id, 'commits')).toMatchObject({ detected_revision: 1, synced_revision: 1, viewed_revision: 1 });
  });

  it('确认上限为 syncedRevision 与 importantRevision 的较小者：未同步变化保留', async () => {
    const { id } = await readyWithCache();
    h().db.prepare("UPDATE detail_scope_state SET detected_revision = 3, synced_revision = 2, important_revision = 3, viewed_revision = 0, freshness = 'stale' WHERE repository_id = ? AND scope = 'commits'").run(id);
    const read = await h().facade.readLocalDetail(id, { scopes: ['commits'] });

    const acked = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: read.detailViewVersion,
      accessContextRevision: read.accessContextRevision,
      scopes: ['commits'],
    });

    expect(acked).toEqual({ ok: true, seenRevision: 3 }); // 2 已看；3 仍未查看
    expect(scopeRow(id, 'commits')).toMatchObject({ viewed_revision: 2, synced_revision: 2, important_revision: 3 });
  });

  it('只推进确认范围内的已同步范围；重复确认幂等且不改写视图版本', async () => {
    const { id } = await readyWithCache();
    // 两个完整同步但未查看的范围：commits（版本1）与 releases（版本2）
    h().db.prepare("UPDATE detail_scope_state SET detected_revision = 1, synced_revision = 1, important_revision = 1, viewed_revision = 0 WHERE repository_id = ? AND scope = 'commits'").run(id);
    h().db.prepare("UPDATE detail_scope_state SET detected_revision = 2, synced_revision = 2, important_revision = 2, viewed_revision = 0 WHERE repository_id = ? AND scope = 'releases'").run(id);
    const read = await h().facade.readLocalDetail(id, { mode: 'status' });
    const acknowledgment = {
      detailViewVersion: read.detailViewVersion,
      accessContextRevision: read.accessContextRevision,
      scopes: ['commits'] as const,
    };
    const versionBefore = read.viewVersion;

    const first = await h().facade.acknowledgeRepositoryViewed(id, acknowledgment);
    expect(first).toEqual({ ok: true, seenRevision: 2 }); // releases 仍未查看
    const advanced = h().db.prepare('SELECT scope, viewed_revision FROM detail_scope_state WHERE repository_id = ? AND viewed_revision > 0 ORDER BY scope').all(id);
    expect(advanced).toEqual([{ scope: 'commits', viewed_revision: 1 }]); // 未确认的 releases 保持 0

    // 重复确认：数值不再推进时不得写库——注入写触发器，若发生 UPDATE 会直接失败。
    h().db.exec("CREATE TRIGGER ack_repeat BEFORE UPDATE ON detail_scope_state BEGIN SELECT RAISE(ABORT, '重复确认不应写库'); END");
    const repeat = await h().facade.acknowledgeRepositoryViewed(id, acknowledgment);
    expect(repeat).toEqual(first);
    h().db.exec('DROP TRIGGER ack_repeat');

    // 确认不改写详情视图版本（组合版本也不变）：不制造确认→版本变化→重复确认循环。
    const versionAfter = (await h().facade.readLocalDetail(id, { mode: 'status' })).viewVersion;
    expect(versionAfter).toBe(versionBefore);

    // 确认其余范围后全部已看
    const released = await h().facade.acknowledgeRepositoryViewed(id, { ...acknowledgment, scopes: ['releases'] as const });
    expect(released).toEqual({ ok: true, seenRevision: 0 });
  });

  it('趋势采样使组合版本变化但不使详情确认失效', async () => {
    const { id } = await readyWithCache();
    const before = await h().facade.readLocalDetail(id, { scopes: ['commits'] });
    h().github.repos.get(NAME)!.meta.stars = 2000;
    h().clock.advanceMs(60_000);
    await h().facade.refreshGlance(); // 仅指标变化：轻量成功并采样趋势
    const after = await h().facade.readLocalDetail(id, { scopes: ['commits'] });

    expect(after.viewVersion).toBeGreaterThan(before.viewVersion); // 组合版本随趋势变化
    expect(after.detailViewVersion).toBe(before.detailViewVersion); // 详情权威版本不动

    const acked = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: before.detailViewVersion,
      accessContextRevision: before.accessContextRevision,
      scopes: ['commits'],
    });
    expect(acked.ok).toBe(true);
  });

  it('无 Token 也可确认本地实际展示：零网络、零任务', async () => {
    const { id } = await readyWithCache();
    h().db.prepare("UPDATE detail_scope_state SET detected_revision = 1, synced_revision = 1, important_revision = 1, viewed_revision = 0 WHERE repository_id = ? AND scope = 'commits'").run(id);
    const read = await h().facade.readLocalDetail(id, { scopes: ['commits'] });
    h().db.prepare("DELETE FROM setting WHERE key = 'access_token'").run();
    h().github.resetCalls();

    const acked = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: read.detailViewVersion,
      accessContextRevision: read.accessContextRevision,
      scopes: ['commits'],
    });

    expect(acked).toEqual({ ok: true, seenRevision: 0 });
    expect(h().github.calls).toEqual({});
    expect(scopeRow(id, 'commits')).toMatchObject({ viewed_revision: 1 });
  });
});

describe('展示确认：保守忽略场景', () => {
  it('旧版本、跨仓库与不可展示缓存的确认不推进任何 viewedRevision', async () => {
    const { id } = await readyWithCache();
    await produceHeadHandoff();
    const release = h().github.holdNext('listReleases');
    const opened = await h().facade.fetchDetail(id);

    // 旧版本（对应旧页面的 token）保守忽略
    const staleVersion = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: opened.detailViewVersion! + 1,
      accessContextRevision: opened.accessContextRevision!,
      scopes: ['commits'],
    });
    expect(staleVersion.ok).toBe(false);

    // 跨仓库：把 A 的展示版本送给没有缓存的 B，忽略且不触碰 B 的账本
    const other = h().repositoryList.createPending('acme/other');
    const foreign = await h().facade.acknowledgeRepositoryViewed(other.id, {
      detailViewVersion: opened.detailViewVersion!,
      accessContextRevision: opened.accessContextRevision!,
      scopes: ['commits'],
    });
    expect(foreign.ok).toBe(false);
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state WHERE repository_id = ?').get(other.id)).toEqual({ n: 0 });

    // 缓存损坏：不再算"实际展示过"，忽略
    h().db.prepare("UPDATE detail_cache SET payload = '{broken' WHERE repository_id = ?").run(id);
    const corrupted = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: opened.detailViewVersion!,
      accessContextRevision: opened.accessContextRevision!,
      scopes: ['commits'],
    });
    expect(corrupted.ok).toBe(false);

    expect(scopeRow(id, 'commits')).toMatchObject({ viewed_revision: 0 });
    release();
    await waitTaskSettled(id);
  });

  it('跨访问上下文的确认保守忽略，不写入新上下文账本', async () => {
    const { id } = await readyWithCache();
    await produceHeadHandoff();
    const release = h().github.holdNext('listReleases');
    const opened = await h().facade.fetchDetail(id);

    h().tokenSettings.advanceAccessContext(h().clock.now().toISOString());
    const crossContext = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: opened.detailViewVersion!,
      accessContextRevision: opened.accessContextRevision!,
      scopes: ['commits'],
    });

    expect(crossContext.ok).toBe(false);
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state WHERE repository_id = ? AND access_context_revision = 1').get(id)).toEqual({ n: 0 });
    expect(scopeRow(id, 'commits')).toMatchObject({ viewed_revision: 0 });

    release();
    await waitTaskSettled(id);
  });
});

describe('展示确认：损坏范围隔离（R1 返工）', () => {
  it('首屏内损坏的范围不确认 viewedRevision，结论与内容读取一致', async () => {
    const { id } = await readyWithCache();
    markSyncedUnseen(id, ['commits']);
    setValues(id, { commits: [{ bad: 'unreadable' }] }); // 首屏条目结构损坏
    h().github.resetCalls();

    // 内容读取结论：该范围 invalid
    const read = await h().facade.readLocalDetail(id, { scopes: ['commits'] });
    expect(read.syncState.commits?.cacheStatus).toBe('invalid');
    expect(read.error?.message).toContain('commits');

    const acked = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: read.detailViewVersion,
      accessContextRevision: read.accessContextRevision,
      scopes: ['commits'],
    });

    // 不宣示损坏内容被看过：不接受、不写库，重要版本仍未查看
    expect(acked).toEqual({ ok: false, seenRevision: 1 });
    expect(scopeRow(id, 'commits')).toMatchObject({ synced_revision: 1, important_revision: 1, viewed_revision: 0 });
    expect(h().github.calls).toEqual({});
  });

  it('组合 scope 一侧损坏时该范围不可确认，同请求的有效范围仍独立确认', async () => {
    const { id } = await readyWithCache();
    markSyncedUnseen(id, ['issuesAndPr', 'commits']);
    setValues(id, { pullRequests: [{ bad: 'unreadable' }] }); // issuesAndPr 的一侧损坏
    h().github.resetCalls();

    const read = await h().facade.readLocalDetail(id, { scopes: ['issuesAndPr', 'commits'] });
    expect(read.syncState.issuesAndPr?.cacheStatus).toBe('invalid');
    expect(read.syncState.commits?.cacheStatus).toBe('valid');

    // 仅请求损坏范围：明示不接受
    const onlyBroken = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: read.detailViewVersion,
      accessContextRevision: read.accessContextRevision,
      scopes: ['issuesAndPr'],
    });
    expect(onlyBroken).toEqual({ ok: false, seenRevision: 1 });

    // 同一请求含有效范围：有效范围独立确认，损坏范围不写
    const mixed = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: read.detailViewVersion,
      accessContextRevision: read.accessContextRevision,
      scopes: ['issuesAndPr', 'commits'],
    });
    expect(mixed).toEqual({ ok: true, seenRevision: 1 }); // issuesAndPr 的重要版本仍未查看
    expect(scopeRow(id, 'commits')).toMatchObject({ viewed_revision: 1 });
    expect(scopeRow(id, 'issuesAndPr')).toMatchObject({ viewed_revision: 0 });
    expect(h().github.calls).toEqual({});
  });

  it('旧 schema 与跨上下文：确认与内容读取一致地判定不可展示，不写 viewedRevision', async () => {
    const { id } = await readyWithCache();
    markSyncedUnseen(id, ['commits']);
    const read = await h().facade.readLocalDetail(id, { scopes: ['commits'] });
    const acknowledgment = {
      detailViewVersion: read.detailViewVersion,
      accessContextRevision: read.accessContextRevision,
      scopes: ['commits'] as const,
    };

    // 旧 schema：内容读取明示不可展示，确认不被接受
    h().db.prepare('UPDATE detail_cache SET schema_version = 99 WHERE repository_id = ?').run(id);
    const incompatible = await h().facade.readLocalDetail(id, { scopes: ['commits'] });
    expect(incompatible.error?.message).toContain('schema');
    expect(incompatible.syncState.commits?.cacheStatus).toBe('invalid');
    expect((await h().facade.acknowledgeRepositoryViewed(id, acknowledgment)).ok).toBe(false);
    h().db.prepare('UPDATE detail_cache SET schema_version = 1 WHERE repository_id = ?').run(id);

    // 跨上下文：旧上下文的确认不被接受，新上下文账本不被写入
    h().tokenSettings.advanceAccessContext(h().clock.now().toISOString());
    expect((await h().facade.acknowledgeRepositoryViewed(id, acknowledgment)).ok).toBe(false);

    expect(h().db.prepare("SELECT viewed_revision FROM detail_scope_state WHERE repository_id = ? AND scope = 'commits' AND access_context_revision = 0").get(id)).toEqual({ viewed_revision: 0 });
    expect(h().db.prepare("SELECT COUNT(*) AS n FROM detail_scope_state WHERE repository_id = ? AND access_context_revision = 1").get(id)).toEqual({ n: 0 });
    expect(h().github.calls).toEqual({});
  });

  it('只审计首屏：下一页损坏不阻塞确认，且确认不整份解析详情', async () => {
    const { id } = await readyWithCache();
    markSyncedUnseen(id, ['commits']);
    const commits = Array.from({ length: 31 }, (_, i) => ({ sha: 's' + i, message: 'm', authorName: null, committedAt: '2026-09-26T00:00:00.000Z' }));
    commits[30] = { bad: 'unreadable' } as unknown as (typeof commits)[number]; // 第二页条目损坏
    setValues(id, { commits });
    h().github.resetCalls();

    const read = await h().facade.readLocalDetail(id, { scopes: ['commits'] });
    expect(read.syncState.commits?.cacheStatus).toBe('valid'); // 首屏有效，与读取结论一致

    const parse = vi.spyOn(JSON, 'parse');
    const acked = await h().facade.acknowledgeRepositoryViewed(id, {
      detailViewVersion: read.detailViewVersion,
      accessContextRevision: read.accessContextRevision,
      scopes: ['commits'],
    });

    expect(acked).toEqual({ ok: true, seenRevision: 0 });
    expect(scopeRow(id, 'commits')).toMatchObject({ viewed_revision: 1 });
    // 有界：确认只读回首页条目，不解析整份 values
    expect(parse.mock.calls.some(([input]) => String(input).includes('"values"'))).toBe(false);
    expect(h().github.calls).toEqual({});
  });
});
