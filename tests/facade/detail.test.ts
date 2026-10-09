import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData, type FakeRepoData } from '../helpers/fake-github';

let harness: Harness | null = null;

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

afterEach(() => {
  harness?.destroy();
  harness = null;
});

async function readyWithRepo(overrides: Partial<FakeRepoData> = {}): Promise<Harness> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData(overrides));
  const added = await h().facade.addRepository('octo-demo/hello-world');
  if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
  return h();
}

describe('全量信息抓取（详情页）', () => {
  it('完整打开的趋势状态来自快照feature，与返回的两日数据一致', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;
    await h().facade.fetchDetail(id);
    h().clock.advanceMs(86400000);
    await h().facade.refreshGlance();
    const result = await h().facade.fetchDetail(id);
    expect(result.detail?.trend).toHaveLength(2);
    expect(result.syncState?.trends?.cacheStatus).toBe('valid');
  });

  it('返回五类更新的完整内容：发版 / 提交 / 议题与合并请求 / 构建状态 / 星标趋势', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;

    const result = await h().facade.fetchDetail(id);
    expect(result.error).toBeNull();
    const detail = result.detail!;
    expect(detail.repository).toMatchObject({ fullName: 'octo-demo/hello-world', stars: 1284 });
    expect(detail.releases).toEqual([
      { tagName: 'v2.4.0', title: 'v2.4.0 — 稳定性修复', publishedAt: '2026-09-20T12:00:00.000Z' },
      { tagName: 'v2.3.1', title: 'v2.3.1 — 补丁', publishedAt: '2026-08-11T09:00:00.000Z' },
    ]);
    expect(detail.commits).toEqual([
      { sha: 'a1b2c3d', message: '修复快照当日重复记档', authorName: 'octo-dev', committedAt: '2026-09-25T08:30:00.000Z' },
      { sha: 'e4f5a6b', message: '补充限流错误归一', authorName: 'octo-dev', committedAt: '2026-09-24T15:10:00.000Z' },
    ]);
    expect(detail.build).toMatchObject({ status: 'success', conclusion: 'success', workflowName: 'ci' });
    expect(detail.trend.length).toBeGreaterThanOrEqual(1);
  });

  it('议题与合并请求按 pull_request 标记拆分，分开展示', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;

    const detail = (await h().facade.fetchDetail(id)).detail!;
    expect(detail.issues).toEqual([
      { number: 42, title: '清单页刷新按钮无反馈', body: '刷新按钮应该显示进行中的状态。', state: 'open', authorName: 'user-a', updatedAt: '2026-09-25T02:00:00.000Z' },
    ]);
    expect(detail.pullRequests).toEqual([
      { number: 57, title: 'feat: 详情页构建徽章', body: '为详情页增加构建状态展示。', state: 'open', authorName: 'user-b', updatedAt: '2026-09-25T07:20:00.000Z' },
    ]);
  });

  it('构建结论归一为构建状态徽章', async () => {
    const cases: Array<{ resultDescription: string | null; status: 'success' | 'failure' | 'pending' | 'neutral'; expected: string }> = [
      { resultDescription: 'success', status: 'success', expected: 'success' },
      { resultDescription: 'failure', status: 'failure', expected: 'failure' },
      { resultDescription: 'timed_out', status: 'failure', expected: 'failure' },
      { resultDescription: 'cancelled', status: 'neutral', expected: 'neutral' },
      { resultDescription: null, status: 'pending', expected: 'pending' },
    ];
    for (const testCase of cases) {
      harness?.destroy();
      await readyWithRepo({
        build: {
          workflowName: 'ci',
          status: testCase.status,
          resultDescription: testCase.resultDescription,
          url: null,
          finishedAt: null,
        },
      });
      const id = (await h().facade.listRepositories())[0]!.id;
      const detail = (await h().facade.fetchDetail(id)).detail!;
      expect(detail.build.status).toBe(testCase.expected);
    }
  });

  it('没有构建的仓库显示"无构建"空态', async () => {
    await readyWithRepo({ build: null });
    const id = (await h().facade.listRepositories())[0]!.id;

    const detail = (await h().facade.fetchDetail(id)).detail!;
    expect(detail.build).toEqual({ status: 'none', conclusion: null, workflowName: null, url: null, finishedAt: null });
  });

  it('无发版时返回空发版列表（空态不报错）', async () => {
    await readyWithRepo({ releases: [], latestRelease: null });
    const id = (await h().facade.listRepositories())[0]!.id;

    const result = await h().facade.fetchDetail(id);
    expect(result.error).toBeNull();
    expect(result.detail!.releases).toEqual([]);
  });

  it('成功抓取记入历史快照（手动刷新同样记档），并更新最新发版标签', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;

    const data = h().github.repos.get('octo-demo/hello-world')!;
    data.releases = [
      { tagName: 'v3.0.0', title: 'v3.0.0', publishedAt: '2026-09-27T09:00:00.000Z' },
      ...data.releases,
    ];
    data.latestRelease = data.releases[0]!; // 发布列表与真实 latest 摘要保持一致
    h().clock.set(new Date(2026, 8, 27, 12, 0, 0));
    await h().facade.fetchDetail(id);

    const rows = h().db.prepare('SELECT * FROM snapshot ORDER BY captured_at ASC').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ day: '2026-09-27', latest_release_tag: 'v3.0.0', stars: 1284 });

    const listed = await h().facade.listRepositories();
    expect(listed[0]).toMatchObject({
      latestReleaseTag: 'v3.0.0',
      fetchedAt: h().clock.now().toISOString(),
    });
  });

  it('趋势由历史快照序列构成并按时间升序', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 2000;
    h().clock.set(new Date(2026, 8, 27, 12, 0, 0));
    await h().facade.refreshGlance();

    const detail = (await h().facade.fetchDetail(id)).detail!;
    expect(detail.trend.map((s) => s.stars)).toEqual([1284, 2000]);
    const captured = detail.trend.map((s) => s.capturedAt);
    expect([...captured].sort()).toEqual(captured);
  });

  it('抓取失败：返回错误且不记档', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;
    h().github.networkDown = true;

    const result = await h().facade.fetchDetail(id);
    expect(result.detail).toBeNull();
    expect(result.error).toMatchObject({ kind: 'network', fullName: 'octo-demo/hello-world' });

    const count = h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('错误归一：404 → 不存在/无权限；限流带恢复时间；401 → 令牌无效', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;

    h().github.fail('octo-demo/hello-world', 'listReleases', fixtures.notFound());
    expect((await h().facade.fetchDetail(id)).error).toMatchObject({ kind: 'not_found' });

    const resetAt = new Date('2026-09-26T13:00:00.000Z');
    h().github.failures.clear();
    h().github.fail('octo-demo/hello-world', 'listCommits', fixtures.rateLimited(resetAt));
    // 首次部分结果可读；后续错误归一通过等待真实执行的强制入口验证。
    expect((await h().facade.refreshRepository!(id, true)).error).toMatchObject({
      kind: 'rate_limited',
      resetAt: resetAt.toISOString(),
    });

    h().github.failures.clear();
    h().github.accessTokenInvalid = true;
    expect((await h().facade.refreshRepository!(id, true)).error).toMatchObject({ kind: 'access_token_invalid' });
  });

  it('限流归一不依赖恢复时间头（无 reset/retry-after 也报限流）', async () => {
    await readyWithRepo();
    const id = (await h().facade.listRepositories())[0]!.id;

    h().github.fail('octo-demo/hello-world', 'listReleases', fixtures.rateLimitedNoReset());
    const first = await h().facade.fetchDetail(id);
    expect(first.error?.kind).toBe('rate_limited');
    expect(first.error?.resetAt).toBeUndefined();

    h().github.failures.clear();
    h().github.fail('octo-demo/hello-world', 'listReleases', fixtures.tooManyRequests());
    const second = await h().facade.fetchDetail(id);
    expect(second.error?.kind).toBe('rate_limited');
  });
});

// —— 步骤 7A：本地读取与观察应用 ——

describe('本地读取与观察应用（步骤 7A）', () => {
  async function readyWithDetailCache(): Promise<{ id: number }> {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');
    h().github.addRepo(makeRepoData({ observation: { head: 'sha-a' } }));
    const added = await h().facade.addRepository('octo-demo/hello-world');
    if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
    const id = (await h().facade.listRepositories())[0]!.id;
    const fetched = await h().facade.fetchDetail(id);
    if (!fetched.detail) throw new Error('detail setup failed');
    h().github.resetCalls();
    return { id };
  }

  /**
   * 让清单产生一条真实、仍未交接的观察（HEAD 前进）。
   * 轻量检查成功后会及时把交接应用到详情账本，这里注入一次应用中断，
   * 使交接保留在待交接队列，供后续"应用 / 幂等重放 / 重启重放"用例消费。
   */
  async function producePendingHandoff(id: number): Promise<number> {
    await h().facade.refreshGlance(); // 基线（首次观察不宣称变化）
    h().github.repos.get('octo-demo/hello-world')!.observation!.head = 'sha-b';
    h().clock.advanceMs(60_000);
    const original = h().repositoryDetail.applyObservation;
    h().repositoryDetail.applyObservation = () => { throw new Error('注入的交接应用中断'); };
    try { await h().facade.refreshGlance(); } finally { h().repositoryDetail.applyObservation = original; }
    const pending = h().repositoryList.pendingObservations();
    if (pending.length !== 1) throw new Error(`expected one pending handoff, got ${pending.length}`);
    return id;
  }

  it('本地读取：零 GitHub 调用，不改变抓取时间、观察快照与趋势', async () => {
    const { id } = await readyWithDetailCache();
    const before = {
      detailFetchedAt: (h().db.prepare('SELECT fetched_at FROM detail_cache WHERE repository_id = ?').get(id) as { fetched_at: string }).fetched_at,
      listFetchedAt: (await h().facade.listRepositories())[0]!.fetchedAt,
      snapshots: (h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n,
      observation: (h().db.prepare('SELECT observation_json, activity_at FROM repository WHERE id = ?').get(id) as { observation_json: string | null; activity_at: string | null }),
    };

    const read = await h().facade.readLocalDetail(id);

    expect(read.error).toBeNull();
    expect(read.detail).not.toBeNull();
    expect(read.detail!.releases).toHaveLength(2);
    expect(read.truncated).toBe(false);
    expect(read.task).toBeNull(); // 不返回虚假的 running / queued
    expect(h().github.calls).toEqual({}); // 本地读取零 GitHub 调用

    const after = {
      detailFetchedAt: (h().db.prepare('SELECT fetched_at FROM detail_cache WHERE repository_id = ?').get(id) as { fetched_at: string }).fetched_at,
      listFetchedAt: (await h().facade.listRepositories())[0]!.fetchedAt,
      snapshots: (h().db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n,
      observation: (h().db.prepare('SELECT observation_json, activity_at FROM repository WHERE id = ?').get(id) as { observation_json: string | null; activity_at: string | null }),
    };
    expect(after).toEqual(before);
  });

  it('status 模式不解析损坏 payload；view 模式明示损坏，不伪装成空成功', async () => {
    const { id } = await readyWithDetailCache();
    h().db.prepare('UPDATE detail_cache SET payload = ? WHERE repository_id = ?').run('{broken json', id);

    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.detail).toBeNull();
    expect(status.error).toBeNull(); // status 只读状态与版本，不接触 payload
    expect(status.truncated).toBe(false);
    expect(h().github.calls).toEqual({});

    const view = await h().facade.readLocalDetail(id, { scopes: ['commits'] });
    expect(view.detail).toBeNull();
    expect(view.error).toMatchObject({ kind: 'unknown' });
    expect(view.error?.message).toContain('损坏');
  });

  it('没有访问令牌时仍可读取有效缓存', async () => {
    harness = createHarness();
    h().db.prepare(
      'INSERT INTO repository (owner, name, full_name, added_at, stars, forks, open_issues) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('octo-demo', 'hello-world', 'octo-demo/hello-world', '2026-09-26T12:00:00.000Z', 10, 2, 3);
    const payload = JSON.stringify({
      repositoryId: 1,
      fullName: 'octo-demo/hello-world',
      values: {
        releases: [{ tagName: 'v1', title: 'v1', publishedAt: null }],
        commits: [],
        issues: [],
        pullRequests: [],
        build: { status: 'success', workflowName: null, url: null, finishedAt: null, resultDescription: 'success' },
      },
      columns: {},
      fetchedAt: '2026-09-26T12:00:00.000Z',
      source: 'fresh',
    });
    h().db.prepare(
      'INSERT INTO detail_cache (repository_id, payload, fetched_at, source_updated_at, schema_version, access_context_revision) VALUES (1, ?, ?, NULL, 1, 0)',
    ).run(payload, '2026-09-26T12:00:00.000Z');

    expect(await h().facade.accessTokenState()).toEqual({ configured: false, accessContextRevision: 0, cleanupPending: false });
    const read = await h().facade.readLocalDetail(1);
    expect(read.error).toBeNull();
    expect(read.detail?.releases).toEqual([{ tagName: 'v1', title: 'v1', publishedAt: null }]);
    expect(read.accessContextRevision).toBe(0);
  });

  it('内容读取有界可按范围续读；访问上下文与 schema 不匹配时明示失败', async () => {
    harness = createHarness();
    h().db.prepare(
      'INSERT INTO repository (owner, name, full_name, added_at, stars, forks, open_issues) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('octo-demo', 'hello-world', 'octo-demo/hello-world', '2026-09-26T12:00:00.000Z', 10, 2, 3);
    const commits = [1, 2, 3, 4, 5].map((index) => ({ sha: `sha-${index}`, message: `m${index}`, authorName: null, committedAt: '2026-09-26T00:00:00.000Z' }));
    const payload = JSON.stringify({
      repositoryId: 1,
      fullName: 'octo-demo/hello-world',
      values: {
        releases: [{ tagName: 'v1', title: 'v1', publishedAt: null }],
        commits,
        issues: [],
        pullRequests: [],
        build: { status: 'none', workflowName: null, url: null, finishedAt: null, resultDescription: null },
      },
      columns: {},
      fetchedAt: '2026-09-26T12:00:00.000Z',
      source: 'fresh',
    });
    h().db.prepare(
      'INSERT INTO detail_cache (repository_id, payload, fetched_at, source_updated_at, schema_version, access_context_revision) VALUES (1, ?, ?, NULL, 1, 0)',
    ).run(payload, '2026-09-26T12:00:00.000Z');

    const first = await h().facade.readLocalDetail(1, { scopes: ['commits'], itemLimit: 2 });
    expect(first.detail?.commits.map((item) => item.sha)).toEqual(['sha-1', 'sha-2']);
    expect(first.detail?.releases).toEqual([]); // 未选择范围以空值表达
    expect(first.truncated).toBe(true);
    expect(JSON.parse(first.cursors!.commits!)).toMatchObject({ repositoryId: 1, scope: 'commits', offset: 2 });

    const second = await h().facade.readLocalDetail(1, { scopes: ['commits'], itemLimit: 2, cursors: { commits: first.cursors!.commits! } });
    expect(second.detail?.commits.map((item) => item.sha)).toEqual(['sha-3', 'sha-4']);
    expect(JSON.parse(second.cursors!.commits!)).toMatchObject({ repositoryId: 1, scope: 'commits', offset: 4 });

    const third = await h().facade.readLocalDetail(1, { scopes: ['commits'], itemLimit: 2, cursors: { commits: second.cursors!.commits! } });
    expect(third.detail?.commits.map((item) => item.sha)).toEqual(['sha-5']);
    expect(third.truncated).toBe(false);
    expect(third.cursors).toBeUndefined();

    // 访问上下文不匹配：不可展示且明示失败
    h().db.prepare('UPDATE detail_cache SET access_context_revision = 7 WHERE repository_id = 1').run();
    const foreign = await h().facade.readLocalDetail(1, { scopes: ['commits'] });
    expect(foreign.detail).toBeNull();
    expect(foreign.error?.message).toContain('访问上下文');

    // schema 不匹配：同样明示失败
    h().db.prepare('UPDATE detail_cache SET access_context_revision = 0, schema_version = 99 WHERE repository_id = 1').run();
    const incompatible = await h().facade.readLocalDetail(1, { scopes: ['commits'] });
    expect(incompatible.detail).toBeNull();
    expect(incompatible.error?.message).toContain('schema');
  });

  it('观察应用：同事务写账本与应用记录；幂等重放；确认前中断可重启重放', async () => {
    const { id } = await readyWithDetailCache();
    await producePendingHandoff(id);
    const [handoff] = h().repositoryList.pendingObservations();

    // 模拟"应用成功、确认前中断"：直接调用 feature 应用，不确认交接
    const applied = h().repositoryDetail.applyObservation(handoff!, h().clock.now().toISOString());
    expect(applied.applied).toBe(true);
    expect(applied.duplicate).toBe(false);
    expect(applied.affectedScopes).toEqual(['overview', 'commits', 'builds', 'readme', 'tree']);

    const rows = h().db.prepare(
      'SELECT scope, detected_revision, synced_revision, freshness, dirty_reasons, last_synced_at FROM detail_scope_state WHERE repository_id = ? ORDER BY scope',
    ).all(id) as Array<{ scope: string; detected_revision: number; synced_revision: number; freshness: string; dirty_reasons: string; last_synced_at: string | null }>;
    // 首次打开已写入常规详情范围基线；目录树只接收变化观察，不由常规同步伪造基线。
    expect(rows.map((row) => row.scope)).toEqual(['builds', 'commits', 'issuesAndPr', 'overview', 'readme', 'releases', 'tree']);
    const baselineSyncedAt = rows.find((row) => row.scope === 'commits')!.last_synced_at;
    for (const row of rows.filter((entry) => ['overview', 'commits', 'builds', 'readme'].includes(entry.scope))) {
      expect(row).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale' }); // 不宣布 fresh
      expect(row.last_synced_at).toBe(baselineSyncedAt); // 观察不刷新同步时间，也不清除既有基线
      expect(JSON.parse(row.dirty_reasons)).toContain('head');
    }
    expect(rows.find(row => row.scope === 'tree')).toMatchObject({ detected_revision: 1, synced_revision: 0, last_synced_at: null, freshness: 'stale' });
    for (const row of rows.filter((entry) => entry.scope === 'releases' || entry.scope === 'issuesAndPr')) {
      expect(row).toMatchObject({ detected_revision: 0, synced_revision: 0 });
    }

    // 本地读取带出账本状态（只读，不启动任务）
    const read = await h().facade.readLocalDetail(id);
    expect(read.syncState.commits).toMatchObject({ detectedRevision: 1, syncedRevision: 0, freshness: 'stale' });
    expect(read.task).toBeNull();

    // 同一 observationId 重放：不重复递增
    const replay = h().repositoryDetail.applyObservation(handoff!, '2026-09-26T13:00:00.000Z');
    expect(replay).toMatchObject({ applied: false, duplicate: true });
    const afterReplay = h().db.prepare('SELECT detected_revision FROM detail_scope_state WHERE repository_id = ? AND scope = ?').get(id, 'commits') as { detected_revision: number };
    expect(afterReplay.detected_revision).toBe(1);
    expect(h().repositoryList.pendingObservations()).toHaveLength(1); // 中断状态：仍未确认

    // 重启重放：打开详情时消费 → 重放判重 → 确认；本地缓存仍先于后台网络返回
    h().reopen();
    const opened = await h().facade.fetchDetail(id);
    expect(opened.detail).not.toBeNull();
    expect(opened.cached).toBe(true);
    expect(h().repositoryList.pendingObservations()).toEqual([]);
  });

  it('跨访问上下文观察不改动账本，也不被确认', async () => {
    const { id } = await readyWithDetailCache();
    await producePendingHandoff(id);
    const [handoff] = h().repositoryList.pendingObservations();
    h().tokenSettings.advanceAccessContext('2026-09-26T13:00:00.000Z');

    const outcome = h().repositoryDetail.applyObservation(handoff!, h().clock.now().toISOString());
    expect(outcome).toMatchObject({ applied: false, duplicate: false });
    // 当前上下文账本没有任何新增：首次获取写入的基线属于旧上下文，跨上下文观察不改动它，也不改当前账本。
    expect((h().db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state WHERE access_context_revision = 1').get() as { n: number }).n).toBe(0);
    expect((h().db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state WHERE access_context_revision = 0').get() as { n: number }).n).toBe(6);
    expect((h().db.prepare('SELECT COUNT(*) AS n FROM detail_observation_apply').get() as { n: number }).n).toBe(0);

    // facade 打开时不确认（应用无进展），待交接保留供后续重放
    const opened = await h().facade.fetchDetail(id);
    expect(opened.detail).not.toBeNull();
    expect(h().repositoryList.pendingObservations()).toHaveLength(1);
  });

  it('应用事务失败：账本回滚、待交接保留、打开不中断', async () => {
    const { id } = await readyWithDetailCache();
    await producePendingHandoff(id);
    const [handoff] = h().repositoryList.pendingObservations();
    h().db.exec('DROP TABLE detail_observation_apply');

    expect(() => h().repositoryDetail.applyObservation(handoff!, h().clock.now().toISOString())).toThrow();
    // 事务回滚：受影响的 commits 范围保持基线（没有部分递增）
    expect(h().db.prepare("SELECT detected_revision, synced_revision FROM detail_scope_state WHERE repository_id = ? AND scope = 'commits'").get(id))
      .toEqual({ detected_revision: 0, synced_revision: 0 });
    expect((h().db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'detail_observation_apply'").get() as { n: number }).n).toBe(0);

    const opened = await h().facade.fetchDetail(id);
    expect(opened.detail).not.toBeNull();
    expect(h().repositoryList.pendingObservations()).toHaveLength(1); // 失败不确认
  });
});
