import { afterEach, describe, expect, it } from 'vitest';
import type { GlanceValues } from '../../src/domain/types';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';

let harness: Harness | undefined;
afterEach(() => { harness?.destroy(); harness = undefined; });

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

async function readyWithRepo(): Promise<{ id: number }> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData());
  const added = await h().facade.addRepository('octo-demo/hello-world');
  if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
  return { id: added.repository!.id };
}

function values(stars: number): GlanceValues {
  return { stars, forks: Math.floor(stars / 10), openIssues: 1, pushedAt: null, latestReleaseTag: null, latestTag: null, collaborationAt: null, status: 'active' };
}

/** 注入一次快照写入失败：真实观察被登记为待补偿，而摘要不受影响。 */
function failSnapshotWrites(): void {
  h().db.exec("CREATE TRIGGER snapshot_write_fail BEFORE INSERT ON snapshot BEGIN SELECT RAISE(ABORT, '注入的快照写入失败'); END");
}

function pendingRows(): Array<{ repository_id: number; access_context_revision: number; observed_at: string; payload: string; created_at: string }> {
  return h().db.prepare('SELECT repository_id, access_context_revision, observed_at, payload, created_at FROM snapshot_pending ORDER BY created_at ASC').all() as Array<{ repository_id: number; access_context_revision: number; observed_at: string; payload: string; created_at: string }>;
}

function queuePending(id: number, observedAt: Date, revision: number, payload: GlanceValues, createdAt: string): void {
  h().db.prepare('INSERT INTO snapshot_pending (identity, repository_id, access_context_revision, observed_at, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`${id}|${observedAt.toISOString()}`, id, revision, observedAt.toISOString(), JSON.stringify(payload), createdAt);
}

describe('真实观察采样：先意图后快照', () => {
  it('新增仓库先保存 Summary：快照写入失败不回滚摘要、不标抓取失败、不丢仓库', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');
    h().github.addRepo(makeRepoData());
    failSnapshotWrites();

    const result = await h().facade.addRepository('octo-demo/hello-world');

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.repository).toMatchObject({ fullName: 'octo-demo/hello-world', stars: 1284 });
    // Summary 已安全落库，失败状态为空
    expect(h().db.prepare('SELECT stars, last_error_kind, fetched_at FROM repository').get())
      .toMatchObject({ stars: 1284, last_error_kind: null, fetched_at: h().clock.now().toISOString() });
    // 真实采样意图已持久化：观察值与观察时间（不是调用时刻）
    const pending = pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ repository_id: 1, access_context_revision: 0, observed_at: h().clock.now().toISOString() });
    expect(JSON.parse(pending[0]!.payload)).toMatchObject({ stars: 1284 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
    // 清单仍展示该仓库，且不显示失败
    expect((await h().facade.listRepositories())[0]).toMatchObject({ stars: 1284, failure: null });
  });

  it('整库不可写（意图都无法落盘）时明确抛出，不声称已持久化', async () => {
    const { id } = await readyWithRepo();
    h().db.exec('DROP TABLE snapshot_pending');

    expect(() => h().snapshotTrend.recordObserved(id, values(1500), h().clock.now().toISOString())).toThrow();
  });

  it('轻量检查的采样失败只登记待补偿，摘要与 dirty 仍保存', async () => {
    const { id } = await readyWithRepo();
    await h().facade.refreshGlance();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    failSnapshotWrites();
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 4321;
    h().clock.advanceMs(60_000);

    const result = await h().facade.refreshGlance();

    expect(result.errors).toEqual([]);
    expect((await h().facade.listRepositories())[0]).toMatchObject({ stars: 4321 });
    const pending = pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.observed_at).toBe(h().clock.now().toISOString());
    expect(JSON.parse(pending[0]!.payload)).toMatchObject({ stars: 4321 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
    // dirty 与新观察一起保留
    expect(h().db.prepare("SELECT stars, last_error_kind FROM repository WHERE id = ?").get(id)).toMatchObject({ stars: 4321, last_error_kind: null });
  });
});

describe('待补偿采样的有界恢复', () => {
  it('重启后按真实数值与观察时间补偿，不发 HTTP、不刷新采样时间、重复恢复幂等', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');
    h().github.addRepo(makeRepoData());
    failSnapshotWrites();
    expect((await h().facade.addRepository('octo-demo/hello-world')).ok).toBe(true);
    const observedAt = h().clock.now().toISOString();

    // 补偿发生在很久以后；本机时钟已前进，但采样时间必须保持真实观察时间
    h().clock.advanceMs(6 * 3600_000);
    h().db.exec('DROP TRIGGER snapshot_write_fail');
    const reopened = h().reopen();
    h().github.resetCalls();

    reopened.facade.startupMaintenance();

    const rows = reopened.db.prepare('SELECT captured_at, day, stars, forks, access_context_revision FROM snapshot').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ captured_at: observedAt, stars: 1284, access_context_revision: 0 });
    expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 0 });
    expect(reopened.github.calls).toEqual({}); // 补偿不发 HTTP

    // 重复恢复幂等：不重复写、不新增快照行、不改变采样时间
    expect(reopened.snapshotTrend.recoverPendingSampling()).toEqual({ recovered: 0, failed: 0, discarded: 0, remaining: 0 });
    expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 1 });
    expect(reopened.db.prepare('SELECT captured_at FROM snapshot').get()).toEqual({ captured_at: observedAt });
    reopened.facade.startupMaintenance();
    expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 1 });
  });

  it('补偿清除意图与写入快照同事务：写入仍失败时意图保留，能再次恢复', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    failSnapshotWrites();
    const observedAt = new Date(2026, 8, 26, 5, 0, 0);
    queuePending(id, observedAt, 0, values(777), h().clock.now().toISOString());

    const failed = h().snapshotTrend.recoverPendingSampling();
    expect(failed).toMatchObject({ recovered: 0, failed: 1, remaining: 1 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });

    h().db.exec('DROP TRIGGER snapshot_write_fail');
    const recovered = h().snapshotTrend.recoverPendingSampling();
    expect(recovered).toMatchObject({ recovered: 1, failed: 0, remaining: 0 });
    expect(h().db.prepare('SELECT captured_at, stars FROM snapshot').get()).toEqual({ captured_at: observedAt.toISOString(), stars: 777 });
  });

  it('有界批次：单次恢复不超过预算，剩余留给下一次，不做无界重试', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    // 观察日期必须落在注入时钟当前时间的 30 个自然日窗口内，否则属于过期意图会被安全丢弃。
    for (let day = 21; day <= 25; day += 1) {
      queuePending(id, new Date(2026, 8, day, 12, 0, 0), 0, values(day * 10), new Date(2026, 8, day, 12, 0, 0).toISOString());
    }

    expect(h().snapshotTrend.recoverPendingSampling(2)).toMatchObject({ recovered: 2, failed: 0, remaining: 3 });
    expect(h().snapshotTrend.recoverPendingSampling(2)).toMatchObject({ recovered: 2, failed: 0, remaining: 1 });
    expect(h().snapshotTrend.recoverPendingSampling(2)).toMatchObject({ recovered: 1, failed: 0, remaining: 0 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 5 });
  });

  it('较早的待补偿样本不覆盖同日更新的真实样本', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    const older = new Date(2026, 8, 26, 1, 0, 0);
    const newer = new Date(2026, 8, 26, 5, 0, 0);
    queuePending(id, older, 0, values(100), older.toISOString());
    h().snapshotTrend.recordObserved(id, values(200), newer);
    expect(h().db.prepare('SELECT captured_at, stars FROM snapshot').get()).toEqual({ captured_at: newer.toISOString(), stars: 200 });

    const outcome = h().snapshotTrend.recoverPendingSampling();

    expect(outcome).toMatchObject({ recovered: 1, remaining: 0 });
    expect(h().db.prepare('SELECT captured_at, stars FROM snapshot').get()).toEqual({ captured_at: newer.toISOString(), stars: 200 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 1 });
  });

  it('换访问上下文或仓库已删的旧意图不回填', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    queuePending(id, new Date(2026, 8, 26, 2, 0, 0), 0, values(300), h().clock.now().toISOString());

    // 上下文推进后旧意图作废
    h().tokenSettings.advanceAccessContext(h().clock.now().toISOString());
    const acrossContext = h().snapshotTrend.recoverPendingSampling();
    expect(acrossContext).toMatchObject({ recovered: 0, discarded: 1, remaining: 0 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });

    // 删除仓库后意图随外键级联清除，恢复不产生任何回填
    queuePending(id, new Date(2026, 8, 26, 3, 0, 0), 1, values(400), h().clock.now().toISOString());
    await h().facade.removeRepository(id);
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 0 });
    expect(h().snapshotTrend.recoverPendingSampling()).toEqual({ recovered: 0, failed: 0, discarded: 0, remaining: 0 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
  });

  it('恢复被中断后重启继续：已恢复的不重复，剩余部分补齐', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    for (let day = 21; day <= 23; day += 1) {
      queuePending(id, new Date(2026, 8, day, 12, 0, 0), 0, values(day * 100), new Date(2026, 8, day, 12, 0, 0).toISOString());
    }

    // 只完成一批就"中断"
    expect(h().snapshotTrend.recoverPendingSampling(1)).toMatchObject({ recovered: 1, remaining: 2 });
    const reopened = h().reopen();

    reopened.facade.startupMaintenance();

    expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 3 });
    expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 0 });
    expect(reopened.db.prepare('SELECT DISTINCT day FROM snapshot ORDER BY day').all()).toEqual([{ day: '2026-09-21' }, { day: '2026-09-22' }, { day: '2026-09-23' }]);
    expect(reopened.db.prepare('SELECT stars FROM snapshot ORDER BY day').all()).toEqual([{ stars: 2100 }, { stars: 2200 }, { stars: 2300 }]);
  });

  it('结构损坏的意图不写入快照，按身份丢弃', async () => {    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    h().db.prepare('INSERT INTO snapshot_pending (identity, repository_id, access_context_revision, observed_at, payload, created_at) VALUES (?, ?, 0, ?, ?, ?)')
      .run(`${id}|broken`, id, new Date(2026, 8, 26, 4, 0, 0).toISOString(), '{broken', h().clock.now().toISOString());

    expect(h().snapshotTrend.recoverPendingSampling()).toEqual({ recovered: 0, failed: 0, discarded: 1, remaining: 0 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
  });
});

describe('采样身份与顺序：同毫秒、跨上下文与幂等', () => {
  it('同一毫秒的不同观察各自登记、按登记顺序确定性采用较新值；重复同一观察幂等', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    failSnapshotWrites();
    const at = h().clock.now(); // 与注入时钟同一毫秒

    h().snapshotTrend.recordObserved(id, values(100), at);
    h().snapshotTrend.recordObserved(id, values(100), at); // 同一次观察重复登记：幂等去重
    h().snapshotTrend.recordObserved(id, values(200), at); // 同一毫秒、不同实际观察：必须各自保留
    expect(pendingRows()).toHaveLength(2);

    h().db.exec('DROP TRIGGER snapshot_write_fail');
    expect(h().snapshotTrend.recoverPendingSampling()).toMatchObject({ recovered: 2, failed: 0, discarded: 0, remaining: 0 });
    // 正常提交与重放顺序一致：较新登记的值成为当天样本
    expect(h().db.prepare('SELECT captured_at, stars FROM snapshot').get()).toEqual({ captured_at: at.toISOString(), stars: 200 });
  });

  it('旧上下文失败后新上下文同一毫秒采样不碰撞：旧意图丢弃、新观察落库', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    failSnapshotWrites();
    const at = h().clock.now();

    h().snapshotTrend.recordObserved(id, values(100), at); // 旧上下文（0）登记失败
    h().tokenSettings.advanceAccessContext(h().clock.now().toISOString()); // 上下文 0 → 1
    h().snapshotTrend.recordObserved(id, values(300), at); // 新上下文同一毫秒

    // 身份含访问上下文：两条不互相顶掉
    expect(pendingRows()).toHaveLength(2);
    h().db.exec('DROP TRIGGER snapshot_write_fail');
    expect(h().snapshotTrend.recoverPendingSampling()).toMatchObject({ recovered: 1, failed: 0, discarded: 1, remaining: 0 });
    expect(h().db.prepare('SELECT captured_at, stars, access_context_revision FROM snapshot').get())
      .toEqual({ captured_at: at.toISOString(), stars: 300, access_context_revision: 1 });
  });
});

describe('采样保留窗口：按注入时钟的 30 个本地自然日', () => {
  it('过期意图安全丢弃：晚到旧样本不把过期日期带回，也不产生伪快照', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    // 当前时钟 2026-09-26；40 天前的观察已落在 30 日窗口之外
    queuePending(id, new Date(2026, 7, 17, 12, 0, 0), 0, values(999), h().clock.now().toISOString());

    expect(h().snapshotTrend.recoverPendingSampling()).toMatchObject({ recovered: 0, discarded: 1, remaining: 0 });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
  });

  it('保留按当前时间执行：窗口内历史保留，窗口外旧行被清理（观察时间只作样本事实）', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().snapshotTrend.recordObserved(id, values(1500), new Date(2026, 8, 20, 9, 0, 0));
    h().snapshotTrend.recordObserved(id, values(1600), new Date(2026, 8, 26, 9, 0, 0));
    // 陈旧行（2026-07-01）：保留窗口只能用注入时钟当前时间判定，不能用行内时间
    h().db.prepare('INSERT INTO snapshot (repository_id, captured_at, day, stars, forks, open_issues, latest_release_tag, pushed_at, access_context_revision) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0)')
      .run(id, '2026-07-01T00:00:00.000Z', '2026-07-01', 1, 1, 1);

    h().snapshotTrend.retain(id);

    expect(h().db.prepare('SELECT day FROM snapshot ORDER BY day').all()).toEqual([{ day: '2026-09-20' }, { day: '2026-09-26' }]);
  });
});

describe('采样载荷校验：损坏与临时失败分离', () => {
  it('数组 / 缺字段 / 错误类型 / 非法指标 / 非法日期按损坏丢弃，有效旧样本保持真实值', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    const at = '2026-09-26T05:00:00.000Z';
    const insert = h().db.prepare('INSERT INTO snapshot_pending (identity, repository_id, access_context_revision, observed_at, payload, created_at) VALUES (?, ?, 0, ?, ?, ?)');
    const metric = (patch: Record<string, unknown>) => JSON.stringify({ stars: 1, forks: 1, openIssues: 1, pushedAt: null, latestReleaseTag: null, ...patch });
    insert.run('array', id, at, JSON.stringify([1, 2, 3]), at);                       // 数组不是 GlanceValues
    insert.run('missing', id, at, JSON.stringify({ stars: 1 }), at);                  // 缺必需指标
    insert.run('string', id, at, metric({ stars: '1284' }), at);                      // 指标类型错误
    insert.run('null-metric', id, at, metric({ stars: null }), at);                   // 指标为空
    insert.run('non-finite', id, at, metric({ openIssues: -3 }), at);                 // 非法指标
    insert.run('optional-type', id, at, metric({ releasedAt: 1, latestTag: 7 }), at);  // 可选字段类型错误
    insert.run('unparseable', id, at, '{broken', at);                                 // 无法解析
    insert.run('bad-date', id, 'not-a-date', metric({ stars: 1000 }), at);            // 非法观察日期
    insert.run('valid', id, at, metric({ stars: 1000 }), at);                         // 有效旧样本

    const outcome = h().snapshotTrend.recoverPendingSampling();

    expect(outcome).toMatchObject({ recovered: 1, failed: 0, discarded: 8, remaining: 0 });
    expect(h().db.prepare('SELECT captured_at, stars FROM snapshot').all())
      .toEqual([{ captured_at: at, stars: 1000 }]);
  });
});

describe('有界补偿的公平性', () => {
  it('瞬时失败前缀不永久阻塞后续有效样本：游标越过故障前缀并在队尾回到起点重试', async () => {
    const { id } = await readyWithRepo();
    h().db.prepare('DELETE FROM snapshot').run();
    h().db.prepare('DELETE FROM snapshot_pending').run();
    // 只让 stars < 150 的样本写入失败：前两条是"永远失败"的前缀
    h().db.exec("CREATE TRIGGER snapshot_partial_fail BEFORE INSERT ON snapshot WHEN NEW.stars < 150 BEGIN SELECT RAISE(ABORT, '注入的快照写入失败'); END");
    const at = (day: number) => new Date(2026, 8, day, 6, 0, 0);
    queuePending(id, at(21), 0, values(100), at(21).toISOString());
    queuePending(id, at(22), 0, values(110), at(22).toISOString());
    queuePending(id, at(23), 0, values(200), at(23).toISOString());

    expect(h().snapshotTrend.recoverPendingSampling(2)).toMatchObject({ recovered: 0, failed: 2, remaining: 3 });
    // 第二次调用越过故障前缀，消费其后的有效样本
    expect(h().snapshotTrend.recoverPendingSampling(2)).toMatchObject({ recovered: 1, failed: 0, remaining: 2 });
    expect(h().db.prepare('SELECT stars FROM snapshot').all()).toEqual([{ stars: 200 }]);

    // 走到队尾后回到起点：故障解除后此前失败的意图仍可重试并补齐
    h().db.exec('DROP TRIGGER snapshot_partial_fail');
    expect(h().snapshotTrend.recoverPendingSampling(2)).toMatchObject({ recovered: 2, failed: 0, remaining: 0 });
    expect(h().db.prepare('SELECT stars FROM snapshot ORDER BY day').all()).toEqual([{ stars: 100 }, { stars: 110 }, { stars: 200 }]);
  });
});
