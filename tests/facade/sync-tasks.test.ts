import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData, type FakeGitHub, type FakeRepoData } from '../helpers/fake-github';
import type { ObservationHandoff, RepoChangeSet } from '../../src/domain/types';

let harness: Harness | null = null;

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

afterEach(() => {
  harness?.destroy();
  harness = null;
});

const NAME = 'octo-demo/hello-world';

async function ready(overrides: Partial<FakeRepoData> = {}): Promise<{ id: number }> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData(overrides));
  const added = await h().facade.addRepository(NAME);
  if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
  return { id: (await h().facade.listRepositories())[0]!.id };
}

/** 带有效缓存的仓库：首次获取会同时写入缓存与全部远端范围的覆盖基线。 */
async function readyWithCache(overrides: Partial<FakeRepoData> = {}): Promise<{ id: number }> {
  const { id } = await ready(overrides);
  const fetched = await h().facade.fetchDetail(id);
  if (!fetched.detail) throw new Error('detail setup failed');
  h().github.resetCalls();
  return { id };
}

/** 制造真实交接：先建立观察基线，再推进 HEAD 并经检查产生待交接记录。 */
async function produceHeadHandoff(): Promise<void> {
  await h().facade.refreshGlance();
  h().github.repos.get(NAME)!.observation!.head = 'sha-b';
  h().clock.advanceMs(60_000);
  await h().facade.refreshGlance();
}

/** 直接写入一条构建变化交接（轻量检查当前不产生构建信号，构建脏由验证或范围抓取产生）。 */
function queueBuildsHandoff(id: number, observationId: string): ObservationHandoff {
  const changeSet: RepoChangeSet = { repoId: id, starsChanged: false, forksChanged: false, headChanged: false, releaseChanged: false,
    tagChanged: false, issuesChanged: false, buildsChanged: true, defaultBranchChanged: false,
    previousHeadRevision: null, currentHeadRevision: null, affectedScopes: ['overview', 'builds'], detectedAt: '2026-09-26T02:00:00.000Z' };
  h().db.prepare('INSERT INTO observation_handoff (observation_id, repository_id, detected_at, access_context_revision, change_set) VALUES (?, ?, ?, ?, ?)')
    .run(observationId, id, changeSet.detectedAt, 0, JSON.stringify(changeSet));
  const handoff: ObservationHandoff = { observationId, repoId: id, detectedAt: changeSet.detectedAt, accessContextRevision: 0, changeSet };
  return handoff;
}

async function waitTaskSettled(id: number): Promise<void> {
  await vi.waitFor(async () => {
    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.task).toBeNull();
  });
}

function scopeRow(id: number, scope: string): Record<string, unknown> | undefined {
  return h().db.prepare('SELECT * FROM detail_scope_state WHERE repository_id = ? AND scope = ? ORDER BY access_context_revision DESC').get(id, scope) as Record<string, unknown> | undefined;
}

async function waitForReleases(): Promise<void> {
  for (let i = 0; i < 100 && h().github.count('listReleases') === 0; i++) await new Promise(resolve => setTimeout(resolve, 0));
  if (h().github.count('listReleases') === 0) throw new Error('发版读取没有开始');
}

describe('后台计划与受保护执行（步骤 7B/8A）', () => {
  it('延迟网络：本地缓存先返回，后台同步完成后新内容与本地版本可读', async () => {
    const { id } = await readyWithCache({ observation: { head: 'sha-a' } });
    await produceHeadHandoff();
    h().github.resetCalls();
    const snapshotsBefore = (h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;

    const release = h().github.holdNext('listReleases');
    const opened = await h().facade.fetchDetail(id);

    // 缓存立即返回：仍是旧内容，任务真实在途；缓存复用不采样
    expect(opened.cached).toBe(true);
    expect(opened.error).toBeNull();
    expect(opened.detail!.releases.map((entry) => entry.tagName)).toEqual(['v2.4.0', 'v2.3.1']);
    expect(opened.task).toMatchObject({ kind: 'open', status: 'running' });
    expect(opened.task!.targetRevisions).toMatchObject({ overview: 1, commits: 1, builds: 1, readme: 1, tree: 1 });
    await waitForReleases();
    expect(h().github.count('listReleases')).toBe(1); // 先读真实概览，再进入发版窗口；此时仍被闸门阻塞
    expect((h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n).toBe(snapshotsBefore);

    // 远端内容变化后释放网络，后台完成写入
    h().github.repos.get(NAME)!.releases = [
      { tagName: 'v3.0.0', title: 'v3.0.0', publishedAt: '2026-09-26T03:00:00.000Z' },
      ...h().github.repos.get(NAME)!.releases,
    ];
    release();
    await waitTaskSettled(id);

    const after = await h().facade.readLocalDetail(id, { scopes: ['releases'] });
    expect(after.detail!.releases.map((entry) => entry.tagName)).toEqual(['v3.0.0', 'v2.4.0', 'v2.3.1']);
    expect(after.viewVersion).toBeGreaterThan(opened.viewVersion!);
    const row = scopeRow(id, 'releases');
    expect(row).toMatchObject({ detected_revision: 0, synced_revision: 0 });
    expect((h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n).toBe(snapshotsBefore); // 同日真实观察仍按自然日upsert，不增加快照行
  });

  it('无有效缓存：打开等待必要的首次获取，同事务写入数据与覆盖基线', async () => {
    const { id } = await ready();
    h().github.resetCalls();

    const opened = await h().facade.fetchDetail(id);
    expect(opened.cached).toBe(false); // 本次是真实首次获取
    expect(opened.detail).not.toBeNull();
    expect(opened.task).toBeNull(); // 首次获取完成后没有在途任务
    expect(opened.viewVersion).toBeGreaterThanOrEqual(1);
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state').get()).toEqual({ n: 7 });
    expect(opened.syncState!.commits).toMatchObject({ cacheStatus: 'valid', detectedRevision: 0, syncedRevision: 0 });
  });

  it('纯状态与内容读取：零网络、零写入、不改变任何时间与账本', async () => {
    const { id } = await readyWithCache();
    const before = {
      cache: h().db.prepare('SELECT fetched_at, access_context_revision FROM detail_cache WHERE repository_id = ?').get(id),
      scopes: h().db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state').get(),
      snapshots: h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get(),
      repository: h().db.prepare('SELECT fetched_at, observation_json FROM repository WHERE id = ?').get(id),
    };

    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.error).toBeNull();
    expect(status.task).toBeNull();
    const view = await h().facade.readLocalDetail(id);
    expect(view.detail).not.toBeNull();
    const direct = h().repositoryDetail.readLocal(id);
    expect(direct!.task).toBeNull();

    expect(h().github.calls).toEqual({}); // 零网络
    expect({
      cache: h().db.prepare('SELECT fetched_at, access_context_revision FROM detail_cache WHERE repository_id = ?').get(id),
      scopes: h().db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state').get(),
      snapshots: h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get(),
      repository: h().db.prepare('SELECT fetched_at, observation_json FROM repository WHERE id = ?').get(id),
    }).toEqual(before); // 零写入：不刷新抓取 / 观察 / 采样时间
  });

  it('重复打开复用同一在途任务；重复强制操作只执行一次', async () => {
    const { id } = await readyWithCache({ observation: { head: 'sha-a' } });
    await produceHeadHandoff();
    h().github.resetCalls();

    const release = h().github.holdNext('listReleases');
    const first = await h().facade.fetchDetail(id);
    const second = await h().facade.fetchDetail(id);
    expect(first.task!.taskId).toBe(second.task!.taskId);
    await waitForReleases();
    expect(h().github.count('listReleases')).toBe(1);
    release();
    await waitTaskSettled(id);
    h().github.resetCalls();

    const releaseForce = h().github.holdNext('listReleases');
    const forceA = h().facade.refreshRepository!(id, true);
    const forceB = h().facade.refreshRepository!(id, true);
    if (!forceA || !forceB) throw new Error('force unavailable');
    await waitForReleases();
    expect(h().github.count('listReleases')).toBe(1); // 同一强制任务
    releaseForce();
    const [resultA, resultB] = await Promise.all([forceA, forceB]);
    expect(resultA.detail).not.toBeNull();
    expect(resultB.detail).not.toBeNull();
    expect(h().github.count('listReleases')).toBe(1);
  });

  it('无访问令牌：打开返回可展示缓存并停止网络计划', async () => {
    harness = createHarness();
    h().db.prepare(
      'INSERT INTO repository (owner, name, full_name, added_at, stars, forks, open_issues) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('octo-demo', 'hello-world', NAME, '2026-09-26T12:00:00.000Z', 10, 2, 3);
    const payload = JSON.stringify({
      repositoryId: 1, fullName: NAME,
      values: { releases: [{ tagName: 'v1', title: 'v1', publishedAt: null }], commits: [], issues: [], pullRequests: [],
        build: { status: 'success', workflowName: null, url: null, finishedAt: null, resultDescription: 'success' } },
      columns: {}, fetchedAt: '2026-09-26T12:00:00.000Z', source: 'fresh',
    });
    h().db.prepare('INSERT INTO detail_cache (repository_id, payload, fetched_at, source_updated_at, schema_version, access_context_revision) VALUES (1, ?, ?, NULL, 1, 0)')
      .run(payload, '2026-09-26T12:00:00.000Z');

    const opened = await h().facade.fetchDetail(1);
    expect(opened.error).toBeNull();
    expect(opened.detail!.releases).toEqual([{ tagName: 'v1', title: 'v1', publishedAt: null }]);
    expect(opened.task).toBeNull(); // 仅停止网络计划
    expect(h().github.calls).toEqual({});

    // 强制同步仍需要令牌：保持既有错误语义
    const forced = await h().facade.refreshRepository!(1, true);
    expect(forced.detail).toBeNull();
    expect(forced.error).toMatchObject({ kind: 'access_token_invalid' });
  });

  it('同步中新变化不被旧任务确认：只推进任务启动时的目标序号', async () => {
    const { id } = await readyWithCache({ observation: { head: 'sha-a' } });
    await produceHeadHandoff();
    const [handoff1] = h().repositoryList.pendingObservations();
    h().repositoryDetail.applyObservation(handoff1!, h().clock.now().toISOString());
    h().github.resetCalls();

    const release = h().github.holdNext('listReleases');
    const opened = await h().facade.fetchDetail(id); // drain 确认 handoff1；后台同步在途
    expect(opened.task).toMatchObject({ kind: 'open' });
    expect(opened.task!.targetRevisions.commits).toBe(1);

    // 同步期间又检测到新变化（sha-c）并应用
    h().github.repos.get(NAME)!.observation!.head = 'sha-c';
    h().clock.advanceMs(60_000);
    await h().facade.refreshGlance();
    const pending = h().repositoryList.pendingObservations();
    expect(pending).toHaveLength(1);
    expect(h().repositoryDetail.applyObservation(pending[0]!, h().clock.now().toISOString())).toMatchObject({ applied: true });

    release();
    await waitTaskSettled(id);

    const row = scopeRow(id, 'commits')!;
    expect(row.detected_revision).toBe(2);
    expect(row.synced_revision).toBe(1); // 只确认启动时的目标；同步中的新变化继续待同步
    expect(JSON.parse(row.dirty_reasons as string)).toContain('head');
    expect(row.freshness).toBe('stale');
  });

  it('部分失败与事务失败：保留旧内容与 dirty，回滚不产生半套写入', async () => {
    // 部分失败：一次栏目请求失败 → 任务失败、缓存与账本原样保留
    const { id } = await readyWithCache({ observation: { head: 'sha-a' } });
    await produceHeadHandoff();
    const [handoff] = h().repositoryList.pendingObservations();
    h().repositoryDetail.applyObservation(handoff!, h().clock.now().toISOString());
    h().github.resetCalls();
    const before = h().db.prepare('SELECT fetched_at, payload FROM detail_cache WHERE repository_id = ?').get(id);
    const beforeCommits = scopeRow(id, 'commits')!;

    h().github.fail(NAME, 'listCommits', fixtures.networkError());
    const opened = await h().facade.fetchDetail(id);
    expect(opened.detail).not.toBeNull(); // 旧缓存继续展示
    await waitTaskSettled(id);
    expect(h().db.prepare('SELECT fetched_at, payload FROM detail_cache WHERE repository_id = ?').get(id)).toEqual(before);
    expect(scopeRow(id, 'commits')).toMatchObject({ ...beforeCommits, sync_status: 'error', last_sync_error: expect.any(String) }); // 数据、序号和基线保留，只增加可读错误
    h().github.failures.clear();
    h().github.resetCalls();

    // 事务失败：账本写入被拒 → 数据与确认一起回滚
    const { id: second } = await readyWithCache();
    const secondBefore = h().db.prepare('SELECT fetched_at, payload FROM detail_cache WHERE repository_id = ?').get(second);
    h().db.exec("CREATE TRIGGER fail_scope_insert BEFORE INSERT ON detail_scope_state BEGIN SELECT RAISE(ABORT, '注入的账本写入失败'); END");
    h().db.exec("CREATE TRIGGER fail_scope_update BEFORE UPDATE ON detail_scope_state BEGIN SELECT RAISE(ABORT, '注入的账本写入失败'); END");
    const forced = await h().facade.refreshRepository!(second, true);
    expect(forced.detail).not.toBeNull(); // 有旧内容时继续保留展示
    expect(forced.error?.message).toContain('注入的账本写入失败');
    expect(h().db.prepare('SELECT fetched_at, payload FROM detail_cache WHERE repository_id = ?').get(second)).toEqual(secondBefore);
    const row = scopeRow(second, 'commits')!;
    expect(row).toMatchObject({ detected_revision: 0, synced_revision: 0 });
  });

  it('删除仓库、访问上下文切换与旧任务延迟返回都不能回写', async () => {
    // 删除仓库：在途任务完成后结果被丢弃，不复活已删数据
    const { id } = await readyWithCache({ observation: { head: 'sha-a' } });
    await produceHeadHandoff();
    h().github.resetCalls();
    const release = h().github.holdNext('listReleases');
    const pending = h().facade.refreshRepository!(id, true);
    await h().facade.removeRepository(id);
    release();
    const removed = await pending!;
    expect(removed.detail).toBeNull();
    expect(removed.error).not.toBeNull();
    expect((h().db.prepare('SELECT COUNT(*) AS n FROM detail_cache').get() as { n: number }).n).toBe(0);

    // 上下文切换：旧上下文任务完成后不得写入当前缓存
    const { id: second } = await readyWithCache();
    const before = h().db.prepare('SELECT fetched_at, payload, access_context_revision FROM detail_cache WHERE repository_id = ?').get(second);
    const releaseOld = h().github.holdNext('listReleases');
    const oldTask = h().facade.refreshRepository!(second, true); // 以旧上下文安排（体内同步执行到等待任务）
    h().tokenSettings.advanceAccessContext('2026-09-26T13:00:00.000Z');
    releaseOld();
    const dropped = await oldTask!;
    expect(dropped.detail).toBeNull(); // 新上下文读不到旧缓存
    expect(h().db.prepare('SELECT fetched_at, payload, access_context_revision FROM detail_cache WHERE repository_id = ?').get(second)).toEqual(before);
    // 新上下文的强制同步可以正常写入
    const refreshed = await h().facade.refreshRepository!(second, true);
    expect(refreshed.detail).not.toBeNull();
    expect(h().db.prepare('SELECT access_context_revision FROM detail_cache WHERE repository_id = ?').get(second)).toEqual({ access_context_revision: 1 });

    // 旧任务延迟返回：版本保护使旧结果不覆盖新任务写入
    const { id: third } = await readyWithCache({ observation: { head: 'sha-a' } });
    await produceHeadHandoff();
    const releaseOpen = h().github.holdNext('listReleases');
    const opened = await h().facade.fetchDetail(third); // 打开任务（版本 1）在途
    expect(opened.task).toMatchObject({ kind: 'open' });
    const force = h().facade.refreshRepository!(third, true); // 强制跟进等待在途普通任务，不并行覆盖
    releaseOpen();
    await force;
    h().github.repos.get(NAME)!.releases = [{ tagName: 'v9.9.9', title: 'v9.9.9', publishedAt: null }];
    await waitTaskSettled(third);
    const after = await h().facade.readLocalDetail(third, { scopes: ['releases'] });
    expect(after.detail!.releases.map((entry) => entry.tagName)).not.toContain('v9.9.9'); // 旧任务结果被放弃
  });

  it('重启后的中断任务不继续伪装 running，账本不残留运行状态', async () => {
    const { id } = await readyWithCache({ observation: { head: 'sha-a' } });
    await produceHeadHandoff();
    h().github.resetCalls();
    const release = h().github.holdNext('listReleases');
    const opened = await h().facade.fetchDetail(id);
    expect(opened.task).toMatchObject({ kind: 'open', status: 'running' });
    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.task).toMatchObject({ status: 'running', taskId: opened.task!.taskId });

    h().reopen(); // 模拟应用重启：在途登记随之清空
    release(); // 旧进程任务悬空返回，写入被保护拒绝
    const after = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(after.task).toBeNull();
    const rows = h().db.prepare('SELECT DISTINCT sync_status, check_status FROM detail_scope_state').all();
    expect(rows).toEqual([{ sync_status: 'idle', check_status: 'idle' }]);
  });
});

describe('构建范围独立更新与范围验证（步骤 8A）', () => {
  function buildsHandler(observed: { items: unknown[]; fingerprint: string; cursorCapture?: (cursor: string | null) => void }) {
    return async (request: Parameters<FakeGitHub['fetchScope']>[1]) => {
      observed.cursorCapture?.(request.cursor as string | null);
      return {
        scope: request.scope,
        items: observed.items,
        hasMore: false,
        nextCursor: null,
        coverageComplete: true,
        observedAt: request.observedAt,
        accessContextRevision: request.accessContextRevision,
        fingerprint: observed.fingerprint,
      };
    };
  }

  it('构建范围独立更新：fetchScope 实际执行、只确认构建组、不刷新完整抓取时间', async () => {
    const { id } = await readyWithCache();
    const handoff = queueBuildsHandoff(id, 'builds-1');
    expect(h().repositoryDetail.applyObservation(handoff, h().clock.now().toISOString())).toMatchObject({ applied: true, affectedScopes: ['overview', 'builds'] });
    const cacheBefore = h().db.prepare('SELECT fetched_at FROM detail_cache WHERE repository_id = ?').get(id);
    h().github.resetCalls();

    const seen: Array<string | null> = [];
    const items = [
      { status: 'failure', workflowName: 'ci', url: 'https://example.test/runs/9', finishedAt: '2026-09-26T03:10:00.000Z', resultDescription: 'failure', id: '9' },
      { status: 'success', workflowName: 'ci', url: 'https://example.test/runs/8', finishedAt: '2026-09-26T02:10:00.000Z', resultDescription: 'success', id: '8' },
    ];
    h().github.setScopeFetch(NAME, 'builds', buildsHandler({ items, fingerprint: 'fp-builds-1', cursorCapture: (cursor) => seen.push(cursor) }));

    const opened = await h().facade.fetchDetail(id);
    expect(opened.task).toMatchObject({ kind: 'scope', targetScopes: ['overview', 'builds'] });
    await waitTaskSettled(id);

    expect(h().github.count('fetchScope')).toBe(1);
    expect(h().github.count('listReleases')).toBe(0); // 未触发完整抓取
    expect(seen).toEqual([null]); // 首窗口从 page1 开始
    const read = await h().facade.readLocalDetail(id, { scopes: ['builds'] });
    expect(read.detail!.builds!.map((entry) => entry.id)).toEqual(['9', '8']);
    expect(read.detail!.build).toMatchObject({ status: 'failure' });
    expect(h().db.prepare('SELECT fetched_at FROM detail_cache WHERE repository_id = ?').get(id)).toEqual(cacheBefore);

    const builds = scopeRow(id, 'builds')!;
    expect(builds).toMatchObject({ detected_revision: 1, synced_revision: 1, cache_status: 'valid', freshness: 'unknown' });
    expect(builds.synced_fingerprint).toBe('fp-builds-1');
    expect(JSON.parse(builds.dirty_reasons as string)).toEqual([]);
    expect(JSON.parse(String((scopeRow(id, 'overview') as { dirty_reasons: string }).dirty_reasons))).toEqual([]); // 构建组随同修复
  });

  it('过期验证：完整检查无变化 → fresh；发现变化 → 标记构建待同步并在下次打开执行范围抓取', async () => {
    const { id } = await readyWithCache();
    const handoff = queueBuildsHandoff(id, 'builds-2');
    h().repositoryDetail.applyObservation(handoff, h().clock.now().toISOString());
    const firstItems = [{ status: 'success', workflowName: 'ci', url: null, finishedAt: null, resultDescription: 'success', id: '1' }];
    h().github.setScopeFetch(NAME, 'builds', buildsHandler({ items: firstItems, fingerprint: 'fp-builds-old' }));

    await h().facade.fetchDetail(id);
    await waitTaskSettled(id);
    h().github.resetCalls();

    // 超过验证 TTL：打开时调度再验证
    h().clock.advanceMs(31 * 60_000);
    h().db.prepare("UPDATE detail_scope_state SET last_checked_at = ? WHERE scope <> 'builds'").run(h().clock.now().toISOString()); // 本用例只让构建验证过期
    h().github.setScopeVerification(NAME, 'builds', { checkedAt: h().clock.now().toISOString(), checkComplete: true, changed: false, fingerprint: 'fp-builds-new' });
    const opened = await h().facade.fetchDetail(id);
    expect(opened.task).toMatchObject({ kind: 'check', targetScopes: ['builds'] });
    await waitTaskSettled(id);
    expect(h().github.count('verifyScopes')).toBe(1);
    let builds = scopeRow(id, 'builds')!;
    expect(builds).toMatchObject({ freshness: 'fresh', last_checked_at: h().clock.now().toISOString() });
    expect(builds.observed_fingerprint).toBe('fp-builds-new');
    expect(builds.synced_fingerprint).toBe('fp-builds-old'); // 验证不冒充同步基线

    // 验证发现变化：标记待同步（不直接抓取），下次打开才执行范围抓取
    h().github.resetCalls();
    h().clock.advanceMs(31 * 60_000);
    h().db.prepare("UPDATE detail_scope_state SET last_checked_at = ? WHERE scope <> 'builds'").run(h().clock.now().toISOString());
    h().github.setScopeVerification(NAME, 'builds', { checkedAt: h().clock.now().toISOString(), checkComplete: true, changed: true });
    const verifyTask = await h().facade.fetchDetail(id);
    expect(verifyTask.task).toMatchObject({ kind: 'check' });
    await waitTaskSettled(id);
    expect(h().github.count('fetchScope')).toBe(0);
    builds = scopeRow(id, 'builds')!;
    expect(builds.freshness).toBe('stale');
    expect(JSON.parse(builds.dirty_reasons as string)).toContain('build');
    expect(JSON.parse(String((scopeRow(id, 'overview') as { dirty_reasons: string }).dirty_reasons))).toContain('build');

    const secondItems = [{ status: 'failure', workflowName: 'ci', url: null, finishedAt: null, resultDescription: 'failure', id: '2' }];
    h().github.setScopeFetch(NAME, 'builds', buildsHandler({ items: secondItems, fingerprint: 'fp-builds-2' }));
    const syncTask = await h().facade.fetchDetail(id);
    expect(syncTask.task).toMatchObject({ kind: 'scope' });
    await waitTaskSettled(id);
    expect(h().github.count('fetchScope')).toBe(1);
    builds = scopeRow(id, 'builds')!;
    expect(builds).toMatchObject({ detected_revision: 2, synced_revision: 2, freshness: 'unknown' });
  });

  it('范围抓取失败（部分失败）保留旧构建内容与 dirty', async () => {
    const { id } = await readyWithCache();
    const handoff = queueBuildsHandoff(id, 'builds-3');
    h().repositoryDetail.applyObservation(handoff, h().clock.now().toISOString());
    const payloadBefore = h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id);

    h().github.setScopeFetch(NAME, 'builds', async () => { throw fixtures.networkError(); });
    await h().facade.fetchDetail(id);
    await waitTaskSettled(id);

    expect(h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id)).toEqual(payloadBefore);
    const builds = scopeRow(id, 'builds')!;
    expect(builds).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale' });
    expect(JSON.parse(builds.dirty_reasons as string)).toContain('build');
  });
});
