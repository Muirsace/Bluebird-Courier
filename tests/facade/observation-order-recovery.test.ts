import { afterEach, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';

let h: Harness;
afterEach(() => h?.destroy());
const values = (stars: number) => ({ stars, forks: 10, openIssues: 1, pushedAt: null, latestReleaseTag: null });
async function ready() {
  h = createHarness();
  await h.facade.saveAccessToken('ghp_valid_token');
  h.github.addRepo(makeRepoData());
  const result = await h.facade.addRepository('octo-demo/hello-world');
  h.db.exec('DELETE FROM snapshot; DELETE FROM snapshot_pending; DELETE FROM snapshot_view_state');
  return result.repository!.id;
}
const fail = () => h.db.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON snapshot BEGIN SELECT RAISE(ABORT, '采样失败'); END");

it('V8旧意图兼容重试沿用原载荷和未知序号，不重登记或丢样本', async () => {
  const id = await ready();
  const at = h.clock.now().toISOString();
  const identity = `${id}|${at}|0|${JSON.stringify([100, 10, 1, null, null, null, null, null])}`;
  h.db.prepare('INSERT INTO snapshot_pending (identity, repository_id, access_context_revision, observed_at, payload, created_at) VALUES (?, ?, 0, ?, ?, ?)').run(identity, id, at, JSON.stringify(values(100)), at);
  expect(() => h.snapshotTrend.recordObserved(id, values(100), at)).not.toThrow();
  expect(h.db.prepare('SELECT stars, observation_sequence FROM snapshot').get()).toEqual({ stars: 100, observation_sequence: 0 });
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 0 });
});

it('保留窗口跨午夜即使数据库版本未变也拒旧趋势游标，重新读取不跳样本', async () => {
  const id = await ready();
  for (const [index, day] of ['28', '29', '30'].entries()) {
    h.snapshotTrend.recordObserved(id, values(index + 1), `2026-08-${day}T04:00:00.000Z`, `boundary-${day}`);
  }
  const first = await h.facade.readLocalDetail(id, { scopes: ['trends'], itemLimit: 1 });
  expect(first.detail!.trend[0]!.stars).toBe(1);
  const savedVersion = h.db.prepare('SELECT view_version FROM snapshot_view_state WHERE repository_id = ?').get(id);
  h.clock.advanceMs(86400000);
  const obsolete = await h.facade.readLocalDetail(id, { scopes: ['trends'], itemLimit: 1, cursors: { trends: first.cursors!.trends } });
  expect(obsolete.error?.message).toContain('游标已失效');
  expect(obsolete.trendWindow).not.toBe(first.trendWindow);
  expect(h.db.prepare('SELECT view_version FROM snapshot_view_state WHERE repository_id = ?').get(id)).toEqual(savedVersion);
  const fresh = await h.facade.readLocalDetail(id, { scopes: ['trends'], itemLimit: 1 });
  expect(fresh.detail!.trend[0]!.stars).toBe(2);
  const next = await h.facade.readLocalDetail(id, { scopes: ['trends'], itemLimit: 1, cursors: { trends: fresh.cursors!.trends } });
  expect(next.detail!.trend[0]!.stars).toBe(3);
});

it('意图INSERT被忽略必须原子回滚身份，重启后同源可重试', async () => {
  const id = await ready();
  h.db.exec("CREATE TRIGGER ignore_pending BEFORE INSERT ON snapshot_pending BEGIN SELECT RAISE(IGNORE); END");
  expect(() => h.snapshotTrend.recordObserved(id, values(100), h.clock.now(), 'ignored-registration')).toThrow();
  expect(h.db.prepare("SELECT COUNT(*) AS n FROM snapshot_observation WHERE identity LIKE '%ignored-registration%'").get()).toEqual({ n: 0 });
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 0 });
  h.db.exec('DROP TRIGGER ignore_pending');
  h.reopen().snapshotTrend.recordObserved(id, values(100), h.clock.now(), 'ignored-registration');
  expect(h.db.prepare('SELECT stars FROM snapshot').get()).toEqual({ stars: 100 });
});

it('意图DELETE被忽略算失败，样本与版本一起回滚且恢复可重试', async () => {
  const id = await ready();
  h.snapshotTrend.stageObserved(id, values(100), h.clock.now(), 'delete-ignored');
  h.db.exec("CREATE TRIGGER ignore_pending_delete BEFORE DELETE ON snapshot_pending BEGIN SELECT RAISE(IGNORE); END");
  expect(h.snapshotTrend.recoverPendingSampling()).toEqual({ recovered: 0, discarded: 0, failed: 1, remaining: 1 });
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(0);
  h.db.exec('DROP TRIGGER ignore_pending_delete');
  expect(h.reopen().snapshotTrend.recoverPendingSampling()).toMatchObject({ recovered: 1, remaining: 0 });
});

it('保留DELETE被忽略不伪增版本，过期资料不可见，解除故障后再删除', async () => {
  const id = await ready();
  h.snapshotTrend.recordObserved(id, values(100), h.clock.now(), 'retention-ignore');
  const version = h.snapshotTrend.localCacheState(id).viewVersion;
  h.clock.advanceMs(40 * 86400000);
  h.db.exec("CREATE TRIGGER ignore_expired_delete BEFORE DELETE ON snapshot BEGIN SELECT RAISE(IGNORE); END");
  h.facade.startupMaintenance();
  h.facade.startupMaintenance();
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version);
  expect((await h.facade.trend!(id)).points).toEqual([]);
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 1 });
  h.db.exec('DROP TRIGGER ignore_expired_delete');
  h.reopen().facade.startupMaintenance();
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version + 1);
});

it('提前登记失败不能在批次迟到时补造新顺序覆盖较新详情', async () => {
  await ready();
  const second = makeRepoData();
  second.meta.fullName = 'acme/second';
  h.github.addRepo(second);
  await h.facade.addRepository('acme/second');
  const [victim, delayed] = h.repositoryList.list();
  h.db.exec('DELETE FROM snapshot; DELETE FROM snapshot_pending; DELETE FROM snapshot_view_state');
  h.github.repos.get(victim!.fullName)!.meta.stars = 100;
  let release = (): void => {}, started = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const observe = h.github.observeSummary.bind(h.github);
  h.github.observeSummary = async (...args) => {
    if (args[1] === delayed!.fullName) { started(); await gate; }
    return observe(...args);
  };
  h.db.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON snapshot_pending WHEN json_extract(NEW.payload, '$.stars') = 100 BEGIN SELECT RAISE(ABORT, '登记失败'); END");
  const checking = h.facade.refreshGlance();
  await waiting;
  h.db.exec('DROP TRIGGER fail_registration');
  h.github.repos.get(victim!.fullName)!.meta.stars = 200;
  await h.facade.fetchDetail(victim!.id);
  release();
  const result = await checking;
  expect(h.db.prepare('SELECT stars FROM snapshot WHERE repository_id = ?').get(victim!.id)).toEqual({ stars: 200 });
  expect(result.errors.some(error => error.source === 'persistence')).toBe(true);
});

it('同毫秒旧失败补偿不能覆盖已成功新观察，跨 reopen 保留顺序与版本', async () => {
  const id = await ready();
  fail();
  h.snapshotTrend.recordObserved(id, values(100), h.clock.now());
  h.db.exec('DROP TRIGGER fail_snapshot');
  h.snapshotTrend.recordObserved(id, values(200), h.clock.now());
  const version = h.snapshotTrend.localCacheState(id).viewVersion;
  h.reopen().facade.startupMaintenance();
  expect(h.db.prepare('SELECT stars FROM snapshot').get()).toEqual({ stars: 200 });
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version);
});

it('重复与旧观察拒绝不增加内容版本', async () => {
  const id = await ready();
  const at = h.clock.now();
  h.snapshotTrend.recordObserved(id, values(200), at);
  const version = h.snapshotTrend.localCacheState(id).viewVersion;
  h.snapshotTrend.recordObserved(id, values(200), at);
  h.snapshotTrend.recordObserved(id, values(100), new Date(at.getTime() - 1000));
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version);
});

it('三个独立同毫秒100→200→100观察保留三条；重复交付复用身份及序号', async () => {
  const id = await ready();
  const at = h.clock.now();
  fail();
  for (const [index, stars] of [100, 200, 100].entries()) h.snapshotTrend.recordObserved(id, values(stars), at, `source-${index}`);
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 3 });
  h.snapshotTrend.recordObserved(id, values(999), at, 'source-0');
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 3 });
  const sequences = h.db.prepare('SELECT observation_sequence FROM snapshot_pending ORDER BY observation_sequence').all();
  h.reopen();
  expect(h.db.prepare('SELECT observation_sequence FROM snapshot_pending ORDER BY observation_sequence').all()).toEqual(sequences);
  h.db.exec('DROP TRIGGER fail_snapshot');
  expect(h.snapshotTrend.recoverPendingSampling()).toMatchObject({ recovered: 3, remaining: 0 });
  expect(h.db.prepare('SELECT stars FROM snapshot').get()).toEqual({ stars: 100 });
  const version = h.snapshotTrend.localCacheState(id).viewVersion;
  h.reopen().snapshotTrend.recordObserved(id, values(999), at, 'source-0');
  expect(h.db.prepare('SELECT stars FROM snapshot').get()).toEqual({ stars: 100 });
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version);
});

it('同值新观察只推进仲裁记账，不伪造展示事实；更老补偿仍被拒绝', async () => {
  const id = await ready();
  const at = h.clock.now();
  h.snapshotTrend.recordObserved(id, values(200), at, 'first');
  const version = h.snapshotTrend.localCacheState(id).viewVersion;
  h.snapshotTrend.recordObserved(id, values(200), new Date(at.getTime() + 2000), 'same-newer');
  h.snapshotTrend.recordObserved(id, values(100), new Date(at.getTime() + 1000), 'late-older');
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version);
  expect(h.db.prepare('SELECT captured_at, observation_at, stars FROM snapshot').get()).toEqual({ captured_at: at.toISOString(), observation_at: new Date(at.getTime() + 2000).toISOString(), stars: 200 });
});

it('新增、清单观察和详情通知都携带稳定来源身份；同毫秒清单100→200→100可恢复', async () => {
  const id = await ready();
  const initial = h.db.prepare('SELECT identity FROM snapshot_observation').all();
  expect(initial).toHaveLength(1);
  fail();
  for (const stars of [100, 200, 100]) {
    h.github.repos.get('octo-demo/hello-world')!.meta.stars = stars;
    await h.facade.refreshGlance();
  }
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 3 });
  h.db.exec('DROP TRIGGER fail_snapshot');
  h.reopen().snapshotTrend.recoverPendingSampling();
  expect(h.db.prepare('SELECT stars FROM snapshot').get()).toEqual({ stars: 100 });
  await h.facade.fetchDetail(id);
  const detail = h.db.prepare("SELECT identity FROM snapshot_observation WHERE identity LIKE '%detail:%'").all();
  expect(detail).toHaveLength(1);
  expect(h.github.count('observeSummary')).toBe(3);
  const version = h.snapshotTrend.localCacheState(id).viewVersion;
  const view = await h.facade.readLocalDetail!(id, { mode: 'view' });
  await h.facade.readLocalDetail!(id, { mode: 'status' });
  await h.facade.acknowledgeRepositoryViewed!(id, { detailViewVersion: view.detailViewVersion, accessContextRevision: view.accessContextRevision, scopes: ['overview'] });
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version);
  expect(h.db.prepare("SELECT identity FROM snapshot_observation WHERE identity LIKE '%detail:%'").all()).toEqual(detail);
});

it('批量检查迟交付不能倒置同毫秒真实清单观察与详情通知的顺序', async () => {
  await ready();
  const second = makeRepoData();
  second.meta.fullName = 'acme/second';
  h.github.addRepo(second);
  await h.facade.addRepository('acme/second');
  const [victim, delayed] = h.repositoryList.list();
  h.db.exec('DELETE FROM snapshot; DELETE FROM snapshot_pending; DELETE FROM snapshot_view_state');
  h.github.repos.get(victim!.fullName)!.meta.stars = 100;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const observe = h.github.observeSummary.bind(h.github);
  h.github.observeSummary = async (...args) => {
    if (args[1] === delayed!.fullName) { started(); await gate; }
    return observe(...args);
  };
  h.db.exec("CREATE TRIGGER fail_old BEFORE INSERT ON snapshot WHEN NEW.stars = 100 BEGIN SELECT RAISE(ABORT, '旧样本失败'); END");
  const checking = h.facade.refreshGlance();
  await waiting;
  h.db.exec('DROP TRIGGER fail_old');
  h.github.repos.get(victim!.fullName)!.meta.stars = 200;
  await h.facade.fetchDetail(victim!.id);
  const version = h.snapshotTrend.localCacheState(victim!.id).viewVersion;
  release();
  await checking;
  h.reopen().facade.startupMaintenance();
  expect(h.db.prepare('SELECT stars FROM snapshot WHERE repository_id = ?').get(victim!.id)).toEqual({ stars: 200 });
  expect(h.snapshotTrend.localCacheState(victim!.id).viewVersion).toBe(version);
});

it('详情概览真实观察不能等其他范围完成才晚于同毫秒新清单观察登记', async () => {
  const id = await ready();
  h.github.repos.get('octo-demo/hello-world')!.meta.stars = 100;
  h.db.exec("CREATE TRIGGER fail_old BEFORE INSERT ON snapshot WHEN NEW.stars = 100 BEGIN SELECT RAISE(ABORT, '旧样本失败'); END");
  const release = h.github.holdNext('listReleases');
  const detail = h.facade.fetchDetail(id);
  for (let i = 0; i < 100 && h.github.count('listReleases') === 0; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.github.count('listReleases')).toBe(1);
  h.github.repos.get('octo-demo/hello-world')!.meta.stars = 200;
  await h.facade.refreshGlance();
  expect(h.db.prepare('SELECT stars FROM snapshot').get()).toEqual({ stars: 200 });
  const version = h.snapshotTrend.localCacheState(id).viewVersion;
  h.db.exec('DROP TRIGGER fail_old');
  release();
  await detail;
  h.reopen().facade.startupMaintenance();
  expect(h.db.prepare('SELECT stars FROM snapshot').get()).toEqual({ stars: 200 });
  expect(h.repositoryList.findById(id)!.stars).toBe(200);
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version);
});

it.each([false, true])('5000合法失败前缀跨重启推进到尾，解除触发器后全部补齐且幂等（混合坏结构=%s）', async (mixed) => {
  const id = await ready();
  const at = h.clock.now().toISOString();
  const change = { repoId: id, starsChanged: false, forksChanged: false, headChanged: true, releaseChanged: false, tagChanged: false, issuesChanged: false, buildsChanged: false, defaultBranchChanged: false, previousHeadRevision: 'a', currentHeadRevision: 'b', affectedScopes: ['commits'], detectedAt: at };
  const insert = h.db.prepare('INSERT INTO observation_handoff (observation_id, repository_id, detected_at, access_context_revision, change_set) VALUES (?, ?, ?, 0, ?)');
  h.db.transaction(() => {
    for (let i = 0; i < 5000; i++) insert.run(`blocked-${i}`, id, at, JSON.stringify(change));
    if (mixed) insert.run('corrupt', id, at, JSON.stringify({ ...change, affectedScopes: null }));
    insert.run('reachable', id, at, JSON.stringify(change));
  })();
  h.db.exec("CREATE TRIGGER fail_handoff BEFORE INSERT ON detail_observation_apply WHEN NEW.observation_id LIKE 'blocked-%' BEGIN SELECT RAISE(ABORT, '交接失败'); END");
  h.github.resetCalls();
  h.facade.startupMaintenance();
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM detail_observation_apply').get()).toEqual({ n: 0 });
  expect(h.db.prepare('SELECT last_rowid FROM observation_replay_cursor WHERE queue_key = 0').get()).toEqual({ last_rowid: 5000 });
  h.reopen().facade.startupMaintenance();
  expect(h.db.prepare("SELECT applied_at FROM observation_handoff WHERE observation_id = 'reachable'").get()).toEqual({ applied_at: at });
  if (mixed) expect(h.db.prepare("SELECT quarantined_at FROM observation_handoff WHERE observation_id = 'corrupt'").get()).toEqual({ quarantined_at: at });
  expect(h.db.prepare("SELECT COUNT(*) AS n FROM observation_handoff WHERE observation_id LIKE 'blocked-%' AND quarantined_at IS NULL AND applied_at IS NULL").get()).toEqual({ n: 5000 });
  h.reopen();
  h.db.exec('DROP TRIGGER fail_handoff');
  h.facade.startupMaintenance();
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM detail_observation_apply').get()).toEqual({ n: 5001 });
  const before = h.db.prepare('SELECT detected_revision, important_revision FROM detail_scope_state').all();
  h.reopen().facade.startupMaintenance();
  expect(h.db.prepare('SELECT detected_revision, important_revision FROM detail_scope_state').all()).toEqual(before);
  expect(h.github.calls).toEqual({});
});

it('保留删除失败留待下次启动恢复，只在删除成功时推进版本', async () => {
  const id = await ready();
  h.snapshotTrend.recordObserved(id, values(100), h.clock.now());
  const version = h.snapshotTrend.localCacheState(id).viewVersion;
  h.clock.advanceMs(40 * 86400000);
  h.db.exec("CREATE TRIGGER block_retention BEFORE DELETE ON snapshot BEGIN SELECT RAISE(ABORT, '保留失败'); END");
  h.facade.startupMaintenance();
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 1 });
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version);
  h.reopen();
  h.db.exec('DROP TRIGGER block_retention');
  h.facade.startupMaintenance();
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version + 1);
});

it.each(['cleanup-success', 'cleanup-failed', 'same-name', 'revision-only'])('迟到新增失败隔离起始身份与上下文：%s', async (mode) => {
  h = createHarness();
  await h.facade.saveAccessToken('ghp_valid_token');
  h.github.addRepo(makeRepoData());
  const original = h.github.getRepositoryMeta.bind(h.github);
  let attempt = 0;
  h.github.getRepositoryMeta = async (...args) => {
    const current = ++attempt;
    const result = await original(...args);
    if (current === 1) throw new TypeError('迟到旧新增失败');
    return result;
  };
  const release = h.github.holdNext('getRepositoryMeta');
  const adding = h.facade.addRepository('octo-demo/hello-world');
  const id = (h.db.prepare('SELECT id FROM repository').get() as { id: number }).id;
  if (mode === 'same-name') {
    await h.facade.removeRepository(id);
    expect((await h.facade.addRepository('octo-demo/hello-world')).ok).toBe(true);
  } else if (mode === 'revision-only') {
    h.tokenSettings.advanceAccessContext(h.clock.now().toISOString());
  } else {
    if (mode === 'cleanup-failed') h.db.exec("CREATE TRIGGER block_cleanup BEFORE DELETE ON repository BEGIN SELECT RAISE(ABORT, '清理失败'); END");
    h.github.validAccessToken = 'ghp_replaced_token';
    await h.facade.beginTokenReplacement!();
    expect(await h.facade.confirmTokenReplacement!('ghp_replaced_token')).toMatchObject({ tokenCommitted: true, cleanupPending: mode === 'cleanup-failed', accessContextRevision: 1 });
  }
  const before = h.db.prepare('SELECT id, stars, last_error_kind, last_error_message FROM repository').all();
  release();
  expect((await adding).ok).toBe(false);
  expect(h.db.prepare('SELECT id, stars, last_error_kind, last_error_message FROM repository').all()).toEqual(before);
  expect(h.tokenSettings.accessContextRevision()).toBe(mode === 'same-name' ? 0 : 1);
  if (mode !== 'same-name') expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 0 });
});

it('观察登记事务失败不留下半个顺序身份，解除故障后同身份可重新登记', async () => {
  const id = await ready();
  const before = h.db.prepare('SELECT COUNT(*) AS n FROM snapshot_observation').get();
  h.db.exec("CREATE TRIGGER block_pending BEFORE INSERT ON snapshot_pending BEGIN SELECT RAISE(ABORT, '意图失败'); END");
  expect(() => h.snapshotTrend.recordObserved(id, values(100), h.clock.now(), 'atomic')).toThrow();
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot_observation').get()).toEqual(before);
  h.reopen();
  h.db.exec('DROP TRIGGER block_pending');
  h.snapshotTrend.recordObserved(id, values(100), h.clock.now(), 'atomic');
  expect(h.db.prepare('SELECT stars FROM snapshot').get()).toEqual({ stars: 100 });
});

it('SQL IGNORE没有实际写入时不推进版本或清除意图，恢复可重试', async () => {
  const id = await ready();
  h.db.exec('CREATE TRIGGER ignore_snapshot BEFORE INSERT ON snapshot BEGIN SELECT RAISE(IGNORE); END');
  h.snapshotTrend.recordObserved(id, values(100), h.clock.now(), 'ignored');
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(0);
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 1 });
  expect(h.snapshotTrend.recoverPendingSampling()).toMatchObject({ recovered: 0, failed: 1, remaining: 1 });
  h.reopen();
  h.db.exec('DROP TRIGGER ignore_snapshot');
  expect(h.snapshotTrend.recoverPendingSampling()).toMatchObject({ recovered: 1, remaining: 0 });
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(1);
});

it('坏payload删除事务失败计failed并保留，解除触发器后才计discarded', async () => {
  const id = await ready();
  const at = h.clock.now().toISOString();
  h.db.prepare('INSERT INTO snapshot_pending (identity, repository_id, access_context_revision, observed_at, payload, created_at) VALUES (?, ?, 0, ?, ?, ?)').run('broken', id, at, '{}', at);
  h.db.exec("CREATE TRIGGER block_discard BEFORE DELETE ON snapshot_pending BEGIN SELECT RAISE(ABORT, '删除失败'); END");
  expect(h.snapshotTrend.recoverPendingSampling()).toEqual({ recovered: 0, discarded: 0, failed: 1, remaining: 1 });
  h.reopen();
  h.db.exec('DROP TRIGGER block_discard');
  expect(h.snapshotTrend.recoverPendingSampling()).toEqual({ recovered: 0, discarded: 1, failed: 0, remaining: 0 });
});

it('有效ISO时区/闰日与可选缺省合法，必需时间缺省或坏可选类型拒绝', async () => {
  const id = await ready();
  h.snapshotTrend.recordObserved(id, { ...values(100), pushedAt: '2024-02-29T01:02:03+08:00' }, '2026-09-26T12:00:00+08:00', 'valid');
  expect(h.db.prepare('SELECT stars FROM snapshot').get()).toEqual({ stars: 100 });
  const version = h.snapshotTrend.localCacheState(id).viewVersion;
  for (const patch of [{ pushedAt: undefined }, { collaborationAt: 7 }, { status: null }, { latestReleaseTag: undefined }]) {
    h.snapshotTrend.recordObserved(id, { ...values(200), ...patch } as ReturnType<typeof values>, h.clock.now(), JSON.stringify(patch));
  }
  expect(h.snapshotTrend.localCacheState(id).viewVersion).toBe(version);
});

it.each(['2026-09-31T04:00:00.000Z', '2026-02-29T04:00:00Z', 'not-a-date'])('正常登记拒绝非法观察时间 %s', async (at) => {
  const id = await ready();
  h.snapshotTrend.recordObserved(id, values(100), at);
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot_pending').get()).toEqual({ n: 0 });
  const now = h.clock.now().toISOString();
  h.db.prepare('INSERT INTO snapshot_pending (identity, repository_id, access_context_revision, observed_at, payload, created_at) VALUES (?, ?, 0, ?, ?, ?)').run('bad-time', id, at, JSON.stringify(values(100)), now);
  expect(h.snapshotTrend.recoverPendingSampling()).toMatchObject({ recovered: 0, discarded: 1 });
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
});

it.each([{ stars: 1.5 }, { stars: Number.MAX_SAFE_INTEGER + 1 }, { pushedAt: 'not-a-date' }, { collaborationAt: '2026-09-31T00:00:00Z' }])('正常与恢复一致拒绝坏指标/时间 %j', async (patch) => {
  const id = await ready();
  const payload = { ...values(100), ...patch };
  const at = h.clock.now().toISOString();
  h.snapshotTrend.recordObserved(id, payload, at);
  h.db.prepare('INSERT INTO snapshot_pending (identity, repository_id, access_context_revision, observed_at, payload, created_at) VALUES (?, ?, 0, ?, ?, ?)').run('corrupt', id, at, JSON.stringify(payload), at);
  expect(h.snapshotTrend.recoverPendingSampling()).toMatchObject({ discarded: 1, recovered: 0 });
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
});

it.each(['empty', 'expired', 'corrupt'])('启动及恢复在 %s 队列仍维护30自然日', async (mode) => {
  const id = await ready();
  const at = h.clock.now().toISOString();
  h.snapshotTrend.recordObserved(id, values(100), at);
  if (mode !== 'empty') h.db.prepare('INSERT INTO snapshot_pending (identity, repository_id, access_context_revision, observed_at, payload, created_at) VALUES (?, ?, 0, ?, ?, ?)').run('pending', id, at, mode === 'corrupt' ? '{}' : JSON.stringify(values(100)), at);
  h.clock.advanceMs(40 * 86400000);
  h.reopen().snapshotTrend.recoverPendingSampling();
  h.facade.startupMaintenance();
  expect((await h.facade.trend!(id)).points).toEqual([]);
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
});
