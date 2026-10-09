import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';

let harness: Harness | undefined;
afterEach(() => { vi.restoreAllMocks(); harness?.destroy(); harness = undefined; });

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

const CLEARED_TABLES = [
  'repository', 'observation_handoff', 'detail_cache', 'detail_column', 'detail_scope_state',
  'detail_view_state', 'detail_observation_apply', 'cache_query_page', 'sync_task_target',
  'snapshot', 'snapshot_view_state', 'snapshot_pending',
] as const;

function count(table: (typeof CLEARED_TABLES)[number]): number {
  return (h().db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function remaining(): Record<string, number> {
  return Object.fromEntries(CLEARED_TABLES.map((table) => [table, count(table)]));
}

const ZERO = Object.fromEntries(CLEARED_TABLES.map((table) => [table, 0]));

/** 用真实的 SQLite 触发器让仓库清理在 DELETE 阶段中止（覆盖"令牌已提交、清理失败"窗口）。 */
function blockRepositoryDelete(): void {
  h().db.exec("CREATE TRIGGER block_repository_delete BEFORE DELETE ON repository BEGIN SELECT RAISE(ABORT, '注入的清理失败'); END");
}

function dropRepositoryDeleteBlocker(): void {
  h().db.exec('DROP TRIGGER block_repository_delete');
}

function cleanupIntent(): string | undefined {
  return (h().db.prepare("SELECT value FROM setting WHERE key = 'token_cleanup_pending'").get() as { value: string } | undefined)?.value;
}

/** 旧上下文资料全量就位：清单 / 详情 / 趋势 / 未交接 / 暂存 / 应用记账 / 待补偿意图。 */
function seedAuxiliaryRecords(id: number): void {
  const at = h().clock.now().toISOString();
  const changeSet = { repoId: id, starsChanged: false, forksChanged: false, headChanged: true, releaseChanged: false,
    tagChanged: false, issuesChanged: false, buildsChanged: false, defaultBranchChanged: false,
    previousHeadRevision: 'a', currentHeadRevision: 'b', affectedScopes: ['commits'], detectedAt: at };
  h().db.prepare('INSERT INTO observation_handoff (observation_id, repository_id, detected_at, access_context_revision, change_set) VALUES (?, ?, ?, 0, ?)')
    .run('handoff-1', id, at, JSON.stringify(changeSet));
  h().db.prepare('INSERT INTO cache_query_page (repository_id, scope, query_key, access_context_revision, schema_version, payload, saved_at) VALUES (?, ?, ?, 0, 1, ?, ?)')
    .run(id, 'commits', 'default|30', '[]', at);
  h().db.prepare('INSERT INTO detail_observation_apply (observation_id, repository_id, applied_at, access_context_revision, affected_scopes) VALUES (?, ?, ?, 0, ?)')
    .run('apply-1', id, at, '["commits"]');
  h().db.prepare("INSERT INTO sync_task_target (task_id, repository_id, scope, kind, status, target_revision, baseline_fingerprint, access_context_revision, task_version, started_at) VALUES ('task-1', ?, 'commits', 'open', 'running', 1, NULL, 0, 1, ?)")
    .run(id, at);
  h().db.prepare('INSERT INTO snapshot_pending (identity, repository_id, access_context_revision, observed_at, payload, created_at) VALUES (?, ?, 0, ?, ?, ?)')
    .run(`${id}|${at}`, id, at, '{"stars":1}', at);
}

async function ready(): Promise<{ id: number }> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData());
  const added = await h().facade.addRepository('octo-demo/hello-world');
  if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
  const id = added.repository!.id;
  await h().facade.fetchDetail(id);
  seedAuxiliaryRecords(id);
  h().github.resetCalls();
  h().github.validAccessToken = 'ghp_replaced_token';
  return { id };
}

describe('Token 更换：跨 feature 清理与失败恢复', () => {
  it.each([false, true])('在途轻量检查跨Token更换不返回旧清单（清理失败=%s）', async (failedCleanup) => {
    await ready();
    const release = h().github.holdNextObservation();
    const refreshing = h().facade.refreshGlance();
    await vi.waitFor(() => expect(h().github.count('observeSummary')).toBeGreaterThan(0));
    if (failedCleanup) blockRepositoryDelete();
    await h().facade.beginTokenReplacement!();
    await h().facade.confirmTokenReplacement!('ghp_replaced_token');
    release();
    const result = await refreshing;
    expect(result.repositories).toEqual([]);
    expect(result.stopped).toBe(true);
    expect(result.errors).toHaveLength(failedCleanup ? 1 : 0);
    expect(await h().facade.accessTokenState()).toMatchObject({ accessContextRevision: 1, cleanupPending: failedCleanup });
  });

  it('清除完成标志失败也返回已提交事实，重启维护不抛错且可重试', async () => {
    await ready();
    h().db.exec("CREATE TRIGGER block_cleanup_marker BEFORE DELETE ON setting WHEN OLD.key='token_cleanup_pending' BEGIN SELECT RAISE(ABORT, '完成标志失败'); END");
    await h().facade.beginTokenReplacement!();
    const result = await h().facade.confirmTokenReplacement!('ghp_replaced_token');
    expect(result).toMatchObject({ ok: false, tokenCommitted: true, cleanupPending: true, accessContextRevision: 1 });
    expect(count('repository')).toBe(0);
    expect(cleanupIntent()).toBe('1');
    h().reopen();
    expect(() => h().facade.startupMaintenance()).not.toThrow();
    expect(cleanupIntent()).toBe('1');
    h().db.exec('DROP TRIGGER block_cleanup_marker');
    expect(await h().facade.confirmTokenReplacement!('')).toMatchObject({ ok: true, tokenCommitted: true, cleanupPending: false, accessContextRevision: 1 });
    expect(cleanupIntent()).toBeUndefined();
  });

  it('成功更换：上下文只推进一次，清单/详情/趋势/未交接/暂存/应用记账全部清理', async () => {
    const { id } = await ready();
    expect(count('repository')).toBe(1);
    expect(count('detail_cache')).toBe(1);
    expect(count('snapshot')).toBeGreaterThan(0);
    expect(count('snapshot_pending')).toBe(1);

    expect((await h().facade.beginTokenReplacement!()).ok).toBe(true);
    const result = await h().facade.confirmTokenReplacement!('ghp_replaced_token');

    expect(result).toEqual({ ok: true, state: 'completed', error: null, tokenCommitted: true, cleanupPending: false, accessContextRevision: 1 });
    expect(h().tokenSettings.accessContextRevision()).toBe(1); // 0 → 1，只推进一次
    expect(h().tokenSettings.readAccessToken()).toBe('ghp_replaced_token');
    expect(remaining()).toEqual(ZERO);
    expect(await h().facade.listRepositories()).toEqual([]);
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state WHERE repository_id = ?').get(id)).toEqual({ n: 0 });

    // 已完成后再次确认不重复清理、也不重复推进上下文
    const again = await h().facade.confirmTokenReplacement!('ghp_replaced_token');
    expect(again.ok).toBe(false);
    expect(h().tokenSettings.accessContextRevision()).toBe(1);
    expect(remaining()).toEqual(ZERO);
  });

  it('清理失败不报告 completed：结果如实给出已提交与待清理事实', async () => {
    await ready();
    const original = h().repositoryList.clear;
    h().repositoryList.clear = () => { throw new Error('注入的清理失败'); };

    expect((await h().facade.beginTokenReplacement!()).ok).toBe(true);
    const failed = await h().facade.confirmTokenReplacement!('ghp_replaced_token');

    expect(failed.ok).toBe(false);
    expect(failed.state).toBe('failed');
    expect(failed.error?.message).toContain('清理');
    // 令牌与上下文已经提交（tokenCommitted），只是清理未完成（cleanupPending）
    expect(failed).toMatchObject({ tokenCommitted: true, cleanupPending: true, accessContextRevision: 1 });
    expect(h().tokenSettings.accessContextRevision()).toBe(1);
    expect(h().tokenSettings.readAccessToken()).toBe('ghp_replaced_token');
    expect(count('repository')).toBe(1);

    // 重试路径：空令牌 + 持久清理意图 = 只重做清理，不再次推进上下文，也不再次验证令牌
    h().repositoryList.clear = original;
    const retried = await h().facade.confirmTokenReplacement!('');
    expect(retried).toEqual({ ok: true, state: 'completed', error: null, tokenCommitted: true, cleanupPending: false, accessContextRevision: 1 });
    expect(h().tokenSettings.accessContextRevision()).toBe(1);
    expect(remaining()).toEqual(ZERO);
    expect(h().github.count('validateAccessToken')).toBe(1); // 重试没有重新校验
  });

  it('清理事务部分后失败仍可恢复：已提交步骤不回滚、剩余步骤补齐', async () => {
    await ready();
    const original = h().repositoryDetail.clear;
    h().repositoryDetail.clear = () => { throw new Error('注入的详情清理失败'); };

    expect((await h().facade.beginTokenReplacement!()).ok).toBe(true);
    const failed = await h().facade.confirmTokenReplacement!('ghp_replaced_token');
    expect(failed.ok).toBe(false);
    // 清单已清理（级联带走全部仓库归属资料），详情清理失败但重试可补齐
    expect(count('repository')).toBe(0);
    expect(count('detail_cache')).toBe(0);

    h().repositoryDetail.clear = original;
    expect((await h().facade.confirmTokenReplacement!('')).ok).toBe(true);
    expect(h().tokenSettings.accessContextRevision()).toBe(1);
    expect(remaining()).toEqual(ZERO);
  });

  it('验证失败或取消保留旧资料，不推进上下文、不清理', async () => {
    const { id } = await ready();
    h().github.validAccessToken = 'ghp_other_token';

    expect((await h().facade.beginTokenReplacement!()).ok).toBe(true);
    const failed = await h().facade.confirmTokenReplacement!('ghp_wrong_token');
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatchObject({ kind: 'access_token_invalid' });
    expect(h().tokenSettings.accessContextRevision()).toBe(0);
    expect(h().tokenSettings.readAccessToken()).toBe('ghp_valid_token');
    expect(count('repository')).toBe(1);
    expect(count('detail_cache')).toBe(1);
    expect(count('snapshot')).toBeGreaterThan(0);
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state WHERE repository_id = ?').get(id)).toEqual({ n: 6 });

    // 取消后确认被拒：同样不清理
    expect((await h().facade.beginTokenReplacement!()).ok).toBe(true);
    expect((await h().facade.cancelTokenReplacement!()).ok).toBe(true);
    expect((await h().facade.confirmTokenReplacement!('ghp_valid_token')).ok).toBe(false);
    expect(h().tokenSettings.accessContextRevision()).toBe(0);
    expect(count('repository')).toBe(1);
    expect(count('snapshot_pending')).toBe(1);
  });
});

describe('Token 更换：旧任务与旧暂存不回填', () => {
  it('更换期间仍在途的强制任务结果不写回，旧上下文资料不复活', async () => {
    const { id } = await ready();
    // 旧上下文下启动强制同步，挂住发版读取
    const release = h().github.holdNext('listReleases');
    const forced = h().facade.refreshRepository!(id, true);
    for (let i = 0; i < 100 && h().github.count('listReleases') === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await h().facade.beginTokenReplacement!()).ok).toBe(true);
    expect((await h().facade.confirmTokenReplacement!('ghp_replaced_token')).ok).toBe(true);
    expect(h().tokenSettings.accessContextRevision()).toBe(1);

    // 放行旧任务：结果因仓库已删 / 上下文已变被放弃
    release();
    const late = await forced;
    expect(late.detail).toBeNull();
    expect(late.error).toMatchObject({ kind: 'unknown' });

    expect(remaining()).toEqual(ZERO);
    expect(await h().facade.listRepositories()).toEqual([]);
  });
});

describe('Token 更换：持久清理意图与跨重启恢复', () => {
  it('清理意图与令牌/上下文同事务提交：真实 DELETE 失败时保留义务、旧资料不作为当前内容', async () => {
    const { id } = await ready();
    blockRepositoryDelete();

    expect((await h().facade.beginTokenReplacement!()).ok).toBe(true);
    const result = await h().facade.confirmTokenReplacement!('ghp_replaced_token');

    // 令牌与上下文已提交（tokenCommitted），清理失败不报告 completed（cleanupPending）
    expect(result).toMatchObject({ ok: false, state: 'failed', tokenCommitted: true, cleanupPending: true, accessContextRevision: 1 });
    expect(h().tokenSettings.accessContextRevision()).toBe(1);
    expect(h().tokenSettings.readAccessToken()).toBe('ghp_replaced_token');
    // 清理意图持久化在 token-settings 自有存储，不依赖内存标志
    expect(cleanupIntent()).toBe('1');
    expect(await h().facade.accessTokenState()).toEqual({ configured: true, accessContextRevision: 1, cleanupPending: true });

    // 旧清单 / 详情 / 趋势 / 历史不作为当前内容展示，均以可恢复错误与权威上下文表达
    expect(await h().facade.listRepositories()).toEqual([]);
    const local = await h().facade.readLocalDetail(id);
    expect(local.detail).toBeNull();
    expect(local.error?.message).toContain('清理');
    expect(local.accessContextRevision).toBe(1);
    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.detail).toBeNull();
    expect(status.task).toBeNull();
    expect(status.error?.message).toContain('清理');
    expect((await h().facade.fetchDetail(id)).error?.message).toContain('清理');
    expect((await h().facade.refreshRepository!(id, true)).error?.message).toContain('清理');
    expect((await h().facade.loadHistory!(id, 'commits')).items).toEqual([]);
    expect((await h().facade.trend!(id)).points).toEqual([]);
    expect((await h().facade.acknowledgeRepositoryViewed!(id, { detailViewVersion: 1, accessContextRevision: 1, scopes: ['commits'] })).ok).toBe(false);

    // 网络入口不再新增写入 / 启动任务
    h().github.resetCalls();
    const glance = await h().facade.refreshGlance();
    expect(glance.repositories).toEqual([]);
    expect(glance.errors[0]!.message).toContain('清理');
    expect((await h().facade.addRepository('octo-demo/hello-world')).ok).toBe(false);
    expect(h().github.calls).toEqual({});

    // 旧资料物理上仍在，只是不被展示；清理义务未被撤销
    expect(count('repository')).toBe(1);
    expect(cleanupIntent()).toBe('1');
  });

  it('启动维护先恢复清理：重建服务与门面后清空旧资料，上下文不再增加', async () => {
    await ready();
    blockRepositoryDelete();
    await h().facade.beginTokenReplacement!();
    expect(await h().facade.confirmTokenReplacement!('ghp_replaced_token')).toMatchObject({ ok: false, cleanupPending: true });

    dropRepositoryDeleteBlocker();
    const reopened = h().reopen(); // 模拟重启：没有内存标志，义务只能来自持久意图

    expect(await reopened.facade.accessTokenState()).toEqual({ configured: true, accessContextRevision: 1, cleanupPending: true });
    reopened.facade.startupMaintenance();

    expect(await reopened.facade.accessTokenState()).toEqual({ configured: true, accessContextRevision: 1, cleanupPending: false });
    expect(reopened.tokenSettings.accessContextRevision()).toBe(1); // 不重复推进上下文
    expect(remaining()).toEqual(ZERO);
  });

  it('空令牌确认是清理重试入口：只重做清理、不重新验证与推进上下文；无 pending 时空值不能绕过验证', async () => {
    await ready();
    blockRepositoryDelete();
    await h().facade.beginTokenReplacement!();
    await h().facade.confirmTokenReplacement!('ghp_replaced_token');
    expect(h().github.count('validateAccessToken')).toBe(1);

    dropRepositoryDeleteBlocker();
    const retried = await h().facade.confirmTokenReplacement!('');
    expect(retried).toEqual({ ok: true, state: 'completed', error: null, tokenCommitted: true, cleanupPending: false, accessContextRevision: 1 });
    expect(h().github.count('validateAccessToken')).toBe(1); // 重试未再验证
    expect(h().tokenSettings.accessContextRevision()).toBe(1);

    // 没有持久意图时，空令牌走普通确认并因验证失败被拒（不能绕过）
    const empty = await h().facade.confirmTokenReplacement!('');
    expect(empty.ok).toBe(false);
    expect(empty.tokenCommitted).toBe(false);
    expect(empty.cleanupPending).toBe(false);
  });

  it('begin / cancel / 验证失败不清除持久清理义务', async () => {
    await ready();
    blockRepositoryDelete();
    await h().facade.beginTokenReplacement!();
    await h().facade.confirmTokenReplacement!('ghp_replaced_token');
    expect(cleanupIntent()).toBe('1');

    await h().facade.beginTokenReplacement!();
    await h().facade.cancelTokenReplacement!();
    await h().facade.validateAccessToken('ghp_wrong_token');

    expect(cleanupIntent()).toBe('1');
    expect(await h().facade.accessTokenState()).toMatchObject({ cleanupPending: true });

    dropRepositoryDeleteBlocker();
    expect((await h().facade.confirmTokenReplacement!('')).ok).toBe(true);
    expect(h().tokenSettings.accessContextRevision()).toBe(1);
  });

  it('已提交但门面清理前崩溃：仅调用令牌确认后重建，启动维护补齐清理', async () => {
    await ready();
    // 只走 token-settings 的确认事务（等价于提交后立即崩溃，facade 清理从未执行）
    h().tokenSettings.beginReplace();
    expect((await h().tokenSettings.confirmReplace('ghp_replaced_token')).ok).toBe(true);
    expect(h().tokenSettings.accessContextRevision()).toBe(1);
    expect(count('repository')).toBe(1); // 尚未清理

    const reopened = h().reopen();
    expect(await reopened.facade.accessTokenState()).toEqual({ configured: true, accessContextRevision: 1, cleanupPending: true });
    reopened.facade.startupMaintenance();

    expect(await reopened.facade.accessTokenState()).toEqual({ configured: true, accessContextRevision: 1, cleanupPending: false });
    expect(remaining()).toEqual(ZERO);
    expect(reopened.tokenSettings.accessContextRevision()).toBe(1);
  });

  it('新一次更换与旧清理并发：旧 revision 的完成请求不清除新版意图，也不误清新资料', async () => {
    await ready();
    blockRepositoryDelete();
    await h().facade.beginTokenReplacement!();
    await h().facade.confirmTokenReplacement!('ghp_replaced_token'); // revision 1 待清理

    h().github.validAccessToken = 'ghp_third_token';
    expect((await h().facade.beginTokenReplacement!()).ok).toBe(true);
    const second = await h().facade.confirmTokenReplacement!('ghp_third_token'); // revision 2
    expect(second).toMatchObject({ ok: false, tokenCommitted: true, cleanupPending: true, accessContextRevision: 2 });

    // 旧上下文版本的完成请求是空操作：不会清除新版 marker
    expect(h().tokenSettings.completeCleanup(1)).toBe(false);
    expect(cleanupIntent()).toBe('2');
    expect(await h().facade.accessTokenState()).toMatchObject({ cleanupPending: true, accessContextRevision: 2 });

    // 新版清理完成后上下文保持不变，没有第二次推进
    dropRepositoryDeleteBlocker();
    expect((await h().facade.confirmTokenReplacement!('')).ok).toBe(true);
    expect(h().tokenSettings.accessContextRevision()).toBe(2);
    expect(cleanupIntent()).toBeUndefined();
  });
});
