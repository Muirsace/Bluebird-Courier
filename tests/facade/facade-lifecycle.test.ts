import { afterEach, describe, expect, it } from 'vitest';
import type { RepoChangeSet } from '../../src/domain/types';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';

let harness: Harness | undefined;
afterEach(() => { harness?.destroy(); harness = undefined; });

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

async function readyWithRepos(fullNames: readonly string[]): Promise<void> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  for (const fullName of fullNames) {
    h().github.addRepo(makeRepoData({ meta: { ...makeRepoData().meta, fullName }, observation: { head: 'sha-a' } }));
    const added = await h().facade.addRepository(fullName);
    if (!added.ok) throw new Error(`setup failed for ${fullName}: ${added.error?.message}`);
  }
  await h().facade.refreshGlance(); // 建立观察基线
}

function scopeRow(id: number, scope: string): Record<string, unknown> {
  return h().db.prepare('SELECT * FROM detail_scope_state WHERE repository_id = ? AND scope = ? ORDER BY access_context_revision DESC').get(id, scope) as Record<string, unknown>;
}

function changeSet(id: number, affectedScopes: RepoChangeSet['affectedScopes']): RepoChangeSet {
  return { repoId: id, starsChanged: false, forksChanged: false, headChanged: true, releaseChanged: false,
    tagChanged: false, issuesChanged: false, buildsChanged: false, defaultBranchChanged: false,
    previousHeadRevision: 'a', currentHeadRevision: 'b', affectedScopes, detectedAt: '2026-09-26T01:00:00.000Z' };
}

/** 直接写入一条待交接观察（不经过轻量检查），用于构造分页与不合法观察。 */
function queueHandoff(id: number, observationId: string, detectedAt: string, affectedScopes: RepoChangeSet['affectedScopes']): void {
  h().db.prepare('INSERT INTO observation_handoff (observation_id, repository_id, detected_at, access_context_revision, change_set) VALUES (?, ?, ?, 0, ?)')
    .run(observationId, id, detectedAt, JSON.stringify({ ...changeSet(id, affectedScopes), detectedAt }));
}

/** 注入一次交接应用中断，使轻量检查产生的交接保留在待交接队列。 */
async function refreshKeepingHandoffs(): Promise<void> {
  const original = h().repositoryDetail.applyObservation;
  h().repositoryDetail.applyObservation = () => { throw new Error('注入的交接应用中断'); };
  try { await h().facade.refreshGlance(); } finally { h().repositoryDetail.applyObservation = original; }
}

describe('启动维护：本地重放待交接观察', () => {
  it('离线 / 无 Token 跨仓库重放并确认，不发网络、不触发 Full Fetch、重复调用幂等', async () => {
    await readyWithRepos(['octo-demo/hello-world', 'acme/second']);
    const ids = new Map((await h().facade.listRepositories()).map((repo) => [repo.fullName, repo.id]));
    for (const fullName of ids.keys()) h().github.repos.get(fullName)!.observation = { head: 'sha-b' };
    h().clock.advanceMs(60_000);
    await refreshKeepingHandoffs();
    expect(h().repositoryList.pendingObservations()).toHaveLength(2);

    // 模拟重启 + 无 Token（离线）：启动维护在 UI 依赖 freshness 之前本地恢复
    const reopened = h().reopen();
    reopened.db.prepare("DELETE FROM setting WHERE key = 'access_token'").run();
    reopened.github.resetCalls();

    reopened.facade.startupMaintenance();

    expect(reopened.repositoryList.pendingObservations()).toEqual([]);
    for (const id of ids.values()) {
      expect(scopeRow(id, 'commits')).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale' });
      // 未受影响的范围不被标记：轻量检查只留 dirty，不冒充其他范围的同步状态
      expect(scopeRow(id, 'releases')?.detected_revision ?? 0).toBe(0);
    }
    expect(reopened.github.calls).toEqual({}); // 恢复是本地写入：不发 HTTP、不抓详情

    // 重复启动维护幂等：不重复应用、不重复增加序号
    const before = ids.get('octo-demo/hello-world')!;
    const snapshot = reopened.db.prepare('SELECT detected_revision, important_revision FROM detail_scope_state WHERE repository_id = ? AND scope = ?').get(before, 'commits');
    reopened.facade.startupMaintenance();
    expect(reopened.db.prepare('SELECT detected_revision, important_revision FROM detail_scope_state WHERE repository_id = ? AND scope = ?').get(before, 'commits')).toEqual(snapshot);
    expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM detail_observation_apply').get()).toEqual({ n: 2 });
  });

  it('分页与不合法观察不阻塞后续有效项：坏观察被隔离，其余有效观察有界消费', async () => {
    await readyWithRepos(['octo-demo/hello-world']);
    const id = (await h().facade.listRepositories())[0]!.id;

    // 最早一条是不可修复的损坏观察（合法 JSON 但 affectedScopes 不是数组）：隔离后不再占用预算
    queueHandoff(id, 'invalid-0', '2026-09-26T00:00:00.000Z', {} as RepoChangeSet['affectedScopes']);
    for (let i = 1; i <= 205; i += 1) {
      const minute = String(i % 60).padStart(2, '0');
      const hour = String(1 + Math.floor(i / 60)).padStart(2, '0');
      queueHandoff(id, `valid-${i}`, `2026-09-26T${hour}:${minute}:00.000Z`, ['commits']);
    }
    h().github.resetCalls();

    h().facade.startupMaintenance();

    expect(scopeRow(id, 'commits')!.detected_revision).toBe(205); // 越过坏观察继续消费全部有效项
    // 不可修复的损坏记录被隔离：既不再阻塞重放，也不会被反复重试
    expect(h().db.prepare("SELECT quarantined_at FROM observation_handoff WHERE observation_id = 'invalid-0'").get()).toMatchObject({ quarantined_at: expect.any(String) });
    expect(h().repositoryList.pendingObservations()).toEqual([]);
    expect(h().github.calls).toEqual({});
  });

  it('故障前缀不再饿死后续有效观察：5000 条损坏记录之后的第 5001 条最终可被消费', async () => {
    await readyWithRepos(['octo-demo/hello-world']);
    const id = (await h().facade.listRepositories())[0]!.id;
    // 5000 条不可修复记录 + 1 条有效观察：单次重放预算 50×100=5000，恰好覆盖坏前缀。
    const insert = h().db.prepare('INSERT INTO observation_handoff (observation_id, repository_id, detected_at, access_context_revision, change_set) VALUES (?, ?, ?, 0, ?)');
    const broken = JSON.stringify({ ...changeSet(id, ['commits']), affectedScopes: {} });
    const valid = JSON.stringify(changeSet(id, ['commits']));
    h().db.transaction(() => {
      for (let i = 0; i < 5000; i += 1) insert.run(`corrupt-${i}`, id, '2026-09-26T00:00:00.000Z', broken);
      insert.run('reachable', id, '2026-09-26T02:00:00.000Z', valid);
    })();
    h().github.resetCalls();

    // 第一次启动隔离坏前缀；重复启动即可推进到其后的有效项（不会永久不可达）
    h().facade.startupMaintenance();
    h().facade.startupMaintenance();

    expect(h().repositoryList.pendingObservations()).toEqual([]);
    expect(h().db.prepare("SELECT quarantined_at FROM observation_handoff WHERE observation_id = 'corrupt-0'").get()).toMatchObject({ quarantined_at: expect.any(String) });
    expect(scopeRow(id, 'commits')).toMatchObject({ detected_revision: 1, freshness: 'stale' });
    expect(h().github.calls).toEqual({});
  });

  it('轻量检查成功即及时交接：只留 dirty，不自动批量 Full Fetch', async () => {
    await readyWithRepos(['octo-demo/hello-world']);
    const id = (await h().facade.listRepositories())[0]!.id;
    h().github.resetCalls();
    h().github.repos.get('octo-demo/hello-world')!.observation = { head: 'sha-b' };
    h().clock.advanceMs(60_000);

    const result = await h().facade.refreshGlance();

    expect(result.errors).toEqual([]);
    expect(h().repositoryList.pendingObservations()).toEqual([]);
    expect(scopeRow(id, 'commits')).toMatchObject({ detected_revision: 1, freshness: 'stale' });
    expect(h().github.count('observeSummary')).toBe(1);
    for (const method of ['listReleases', 'listCommits', 'listIssues', 'getLatestBuild', 'verifyScopes', 'fetchScope']) {
      expect(h().github.count(method), method).toBe(0);
    }
  });
});

describe('删除与同名重添的身份保护', () => {
  it('旧 id 的延迟任务不回写，旧观察与暂存不复活，新 id 不串结果', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');
    h().github.addRepo(makeRepoData({ observation: { head: 'sha-a' } }));
    const first = await h().facade.addRepository('octo-demo/hello-world');
    const oldId = first.repository!.id;
    await h().facade.fetchDetail(oldId);
    queueHandoff(oldId, 'old-handoff', '2026-09-26T01:00:00.000Z', ['commits']);
    h().db.prepare('INSERT INTO cache_query_page (repository_id, scope, query_key, access_context_revision, schema_version, payload, saved_at) VALUES (?, ?, ?, 0, 1, ?, ?)')
      .run(oldId, 'commits', 'default|30', '[]', h().clock.now().toISOString());

    // 旧 id 在途强制同步
    const release = h().github.holdNext('listReleases');
    const forced = h().facade.refreshRepository!(oldId, true);
    for (let i = 0; i < 100 && h().github.count('listReleases') === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    await h().facade.removeRepository(oldId);
    h().github.addRepo(makeRepoData({ observation: { head: 'sha-new' } }));
    const second = await h().facade.addRepository('octo-demo/hello-world');
    const newId = second.repository!.id;
    expect(newId).not.toBe(oldId);

    release();
    const late = await forced;
    expect(late.detail).toBeNull();
    expect(late.error).toMatchObject({ kind: 'unknown' });

    // 旧 id 无任何残留（外键级联 + 自有清理）
    for (const table of ['detail_cache', 'detail_column', 'detail_scope_state', 'detail_view_state', 'detail_observation_apply', 'cache_query_page', 'snapshot', 'snapshot_pending', 'observation_handoff'] as const) {
      expect(h().db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repository_id = ?`).get(oldId), table).toEqual({ n: 0 });
    }
    // 新 id 不继承旧观察与暂存
    for (const table of ['detail_scope_state', 'observation_handoff', 'cache_query_page', 'detail_observation_apply'] as const) {
      expect(h().db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repository_id = ?`).get(newId), table).toEqual({ n: 0 });
    }
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM repository').get()).toEqual({ n: 1 });
  });
});

describe('新增仓库：身份与访问上下文保护', () => {
  /** 等待挂起的 getRepositoryMeta 真正被调用（闸门只拦下一次调用）。 */
  async function waitForMeta(): Promise<void> {
    for (let i = 0; i < 100 && h().github.count('getRepositoryMeta') === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('旧令牌的在途新增回包不写入新访问上下文，也不产生采样', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');
    h().github.addRepo(makeRepoData());
    const release = h().github.holdNext('getRepositoryMeta');
    const adding = h().facade.addRepository('octo-demo/hello-world');
    await waitForMeta();

    // 回包仍在途时更换令牌：上下文推进到 1，且清理因真实 DELETE 失败而持久待清理
    h().github.validAccessToken = 'ghp_replaced_token';
    h().db.exec("CREATE TRIGGER block_repository_delete BEFORE DELETE ON repository BEGIN SELECT RAISE(ABORT, '注入的清理失败'); END");
    await h().facade.beginTokenReplacement!();
    expect(await h().facade.confirmTokenReplacement!('ghp_replaced_token')).toMatchObject({ tokenCommitted: true, cleanupPending: true });

    release();
    const delayed = await adding;

    // 旧回包被身份 / 上下文守卫拒绝：摘要、采样与趋势都不得落库
    expect(delayed.ok).toBe(false);
    expect(delayed.repository).toBeNull();
    expect(h().db.prepare('SELECT stars, fetched_at FROM repository').get()).toEqual({ stars: null, fetched_at: null });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 0 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
  });

  it('删除后同名重添：旧 id 的延迟回包不复活资料，也不覆盖新仓库的观察', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');
    h().github.addRepo(makeRepoData());
    const release = h().github.holdNext('getRepositoryMeta');
    const adding = h().facade.addRepository('octo-demo/hello-world');
    await waitForMeta();
    const oldId = (h().db.prepare('SELECT id FROM repository').get() as { id: number }).id;

    await h().facade.removeRepository(oldId);
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM repository').get()).toEqual({ n: 0 });
    // 同名重添：新 id 观察到不同的数值
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 2000;
    const second = await h().facade.addRepository('octo-demo/hello-world');
    expect(second.ok).toBe(true);
    const newId = second.repository!.id;
    expect(newId).not.toBe(oldId);
    // 释放旧回包时把远端数值改成第三种，旧回包若写入就会污染新仓库
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 3000;
    release();

    const delayed = await adding;
    expect(delayed.ok).toBe(false);
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM repository').get()).toEqual({ n: 1 });
    expect(h().db.prepare('SELECT id, stars FROM repository').get()).toEqual({ id: newId, stars: 2000 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending WHERE repository_id = ?').get(oldId)).toEqual({ n: 0 });
  });
});
