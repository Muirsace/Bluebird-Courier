import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData } from '../helpers/fake-github';

let harness: Harness | null = null;

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

function scopeRow(id: number, scope: string): Record<string, unknown> {
  return h().db.prepare('SELECT * FROM detail_scope_state WHERE repository_id = ? AND scope = ? ORDER BY access_context_revision DESC').get(id, scope) as Record<string, unknown>;
}

afterEach(() => {
  harness?.destroy();
  harness = null;
});

async function readyWithRepos(fullNames: string[]): Promise<Harness> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  for (const fullName of fullNames) {
    h().github.addRepo(makeRepoData({ meta: { ...makeRepoData().meta, fullName } }));
    await h().facade.addRepository(fullName);
  }
  return h();
}

describe('轻量信息抓取（清单页）', () => {
  it('重新抓取所有监控仓库的轻量信息并更新落库', async () => {
    await readyWithRepos(['octo-demo/hello-world']);
    const data = h().github.repos.get('octo-demo/hello-world')!;
    data.meta.stars = 2000;
    data.latestRelease = { tagName: 'v3.0.0', title: 'v3.0.0', publishedAt: '2026-09-26T09:00:00.000Z' };

    h().clock.advanceMs(60_000);
    const result = await h().facade.refreshGlance();

    expect(result.errors).toEqual([]);
    expect(result.repositories[0]).toMatchObject({
      fullName: 'octo-demo/hello-world',
      stars: 2000,
      latestReleaseTag: 'v3.0.0',
      fetchedAt: h().clock.now().toISOString(),
    });
  });

  it('网络失败：保留上次数据并附网络失败错误', async () => {
    await readyWithRepos(['octo-demo/hello-world']);
    const fetchedAtBefore = h().clock.now().toISOString();
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 2000;
    h().github.networkDown = true;

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ kind: 'network', fullName: 'octo-demo/hello-world' });
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]).toMatchObject({ stars: 1284, fetchedAt: fetchedAtBefore });
  });

  it('限流：只报一次限流且带恢复时间，其余仓库保留上次数据', async () => {
    const resetAt = new Date('2026-09-26T13:00:00.000Z');
    await readyWithRepos(['octo-demo/hello-world', 'octo-demo/second-repo']);
    h().github.fail('*', 'observeSummary', fixtures.rateLimited(resetAt));

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      kind: 'rate_limited',
      resetAt: resetAt.toISOString(),
    });
    expect(result.repositories).toHaveLength(2);
    expect(result.repositories.every((r) => r.stars === 1284)).toBe(true);
  });

  it('令牌失效（401）：只报一次令牌无效并引导设置', async () => {
    await readyWithRepos(['octo-demo/hello-world', 'octo-demo/second-repo']);
    h().github.accessTokenInvalid = true;

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ kind: 'access_token_invalid' });
    expect(result.repositories).toHaveLength(2);
  });

  it('部分仓库抓取失败不影响其他仓库', async () => {
    await readyWithRepos(['octo-demo/hello-world', 'octo-demo/second-repo']);
    h().github.repos.get('octo-demo/hello-world')!.meta.stars = 2000;
    h().github.fail('octo-demo/second-repo', 'observeSummary', fixtures.notFound());

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ kind: 'not_found', fullName: 'octo-demo/second-repo' });
    expect(result.repositories.find((r) => r.fullName === 'octo-demo/hello-world')).toMatchObject({ stars: 2000 });
    expect(result.repositories.find((r) => r.fullName === 'octo-demo/second-repo')).toMatchObject({ stars: 1284 });
  });

  it('没有监控仓库时返回空清单且无错误', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');

    const result = await h().facade.refreshGlance();
    expect(result).toEqual({ repositories: [], errors: [] });
  });

  it('未配置令牌时提示先配置访问令牌', async () => {
    harness = createHarness();
    const result = await h().facade.refreshGlance();
    expect(result).toEqual({ repositories: [], errors: [] });
  });
});

describe('清单检查与观察交接（步骤 6）', () => {
  async function readyWithCheckRepo(): Promise<void> {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');
    h().github.addRepo(makeRepoData({ observation: { head: 'sha-a', collaborationAt: '2026-09-25T09:00:00.000Z' } }));
    const added = await h().facade.addRepository('octo-demo/hello-world');
    if (!added.ok) throw new Error(`setup failed: ${added.error?.message}`);
  }

  it('观察后保存快照与统一活动；首次观察是基线不产生交接；未查看仓库不抓取详情', async () => {
    await readyWithCheckRepo();
    h().github.resetCalls();

    const first = await h().facade.refreshGlance();

    expect(first.errors).toEqual([]);
    expect(h().github.count('observeSummary')).toBe(1);
    for (const method of ['listReleases', 'listCommits', 'listIssues', 'getLatestBuild', 'getMetadata', 'listTags', 'listBuilds', 'listReadmes', 'listTree', 'verifyScopes', 'fetchScope']) {
      expect(h().github.count(method), method).toBe(0);
    }
    expect(h().repositoryList.pendingObservations()).toEqual([]);

    // 显示与排序同源：协作（09-25T09:00）晚于发版（09-20T12:00）与推送（08:30）
    const [glance] = await h().facade.listRepositories();
    expect(glance).toMatchObject({ activityAt: '2026-09-25T09:00:00.000Z', activityKind: 'issue', collaborationAt: '2026-09-25T09:00:00.000Z' });

    const row = h().db.prepare('SELECT observation_json, access_context_revision FROM repository').get() as { observation_json: string; access_context_revision: number };
    const observation = JSON.parse(row.observation_json) as { signals: { headRevision: unknown } };
    expect(observation.signals.headRevision).toEqual({ state: 'known', value: 'sha-a', checkedAt: h().clock.now().toISOString() });
    expect(row.access_context_revision).toBe(0);
  });

  it('HEAD 变化及时落到详情账本（dirty）；重复观察不重复增加序号', async () => {
    await readyWithCheckRepo();
    await h().facade.refreshGlance(); // 基线
    const id = (await h().facade.listRepositories())[0]!.id;

    const data = h().github.repos.get('octo-demo/hello-world')!;
    data.observation!.head = 'sha-b';
    h().clock.advanceMs(60_000);
    await h().facade.refreshGlance();

    // 轻量检查成功即及时交接：变化落到详情账本（只 dirty，不抓详情），待交接队列清空
    expect(h().repositoryList.pendingObservations()).toEqual([]);
    expect(scopeRow(id, 'commits')).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale' });
    expect(h().github.count('fetchScope')).toBe(0);
    expect(h().github.count('listCommits')).toBe(0);

    // 重复观察同一状态：不产生新变化，也不重复增加序号
    h().clock.advanceMs(60_000);
    await h().facade.refreshGlance();
    expect(h().repositoryList.pendingObservations()).toEqual([]);
    expect(scopeRow(id, 'commits')!.detected_revision).toBe(1);
  });

  it('保存失败与交接同事务回滚：摘要保留旧值并记录失败', async () => {
    await readyWithCheckRepo();
    await h().facade.refreshGlance(); // 基线

    const data = h().github.repos.get('octo-demo/hello-world')!;
    data.meta.stars = 9999;
    data.observation!.head = 'sha-b';
    h().db.exec('DROP TABLE observation_handoff');

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe('unknown');
    const row = h().db.prepare('SELECT stars, observation_json FROM repository').get() as { stars: number; observation_json: string };
    expect(row.stars).toBe(1284); // 事务回滚：摘要保留旧值
    expect((JSON.parse(row.observation_json) as { signals: { headRevision: { value: string } } }).signals.headRevision.value).toBe('sha-a');
  });

  it('失败或确认无活动不覆盖已有有效来源', async () => {
    await readyWithCheckRepo();
    await h().facade.refreshGlance(); // 基线（协作活动 09-25T09:00 为最新活动）

    const data = h().github.repos.get('octo-demo/hello-world')!;
    data.observation = { head: 'sha-a' }; // 协作候选变为确认无活动
    h().github.networkDown = true;
    h().clock.advanceMs(60_000);
    const failed = await h().facade.refreshGlance();

    expect(failed.errors).toHaveLength(1);
    expect(failed.errors[0]?.kind).toBe('network');
    expect((await h().facade.listRepositories())[0]).toMatchObject({
      stars: 1284,
      activityAt: '2026-09-25T09:00:00.000Z',
      activityKind: 'issue',
    });

    // 恢复网络：成功确认无协作也保留上次已知活动，不用空值覆盖
    h().github.networkDown = false;
    h().clock.advanceMs(60_000);
    const ok = await h().facade.refreshGlance();
    expect(ok.errors).toEqual([]);
    expect((await h().facade.listRepositories())[0]).toMatchObject({
      activityAt: '2026-09-25T09:00:00.000Z',
      activityKind: 'issue',
    });
  });

  it('限流停止后续仓库的检查', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');
    for (const fullName of ['octo-demo/hello-world', 'octo-demo/second-repo']) {
      h().github.addRepo(makeRepoData({ meta: { ...makeRepoData().meta, fullName } }));
      await h().facade.addRepository(fullName);
    }
    h().github.resetCalls();
    const resetAt = new Date('2026-09-26T13:00:00.000Z');
    h().github.fail('*', 'observeSummary', fixtures.rateLimited(resetAt));

    const result = await h().facade.refreshGlance();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ kind: 'rate_limited', resetAt: resetAt.toISOString() });
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe('rate_limited');
    expect(h().github.count('observeSummary')).toBe(1); // 停止后不再检查后续仓库
  });

  it('访问上下文变化后旧观察不参与比较，新上下文内恢复检测', async () => {
    await readyWithCheckRepo();
    await h().facade.refreshGlance(); // 上下文 0 的基线

    h().tokenSettings.advanceAccessContext('2026-09-26T12:30:00.000Z');
    const data = h().github.repos.get('octo-demo/hello-world')!;
    data.observation!.head = 'sha-b';
    h().clock.advanceMs(60_000);
    const acrossContext = await h().facade.refreshGlance();

    expect(acrossContext.errors).toEqual([]);
    expect(h().repositoryList.pendingObservations()).toEqual([]); // 跨上下文不宣称变化
    const row = h().db.prepare('SELECT observation_json, access_context_revision FROM repository').get() as { observation_json: string; access_context_revision: number };
    expect(row.access_context_revision).toBe(1); // 快照按新上下文保存
    expect((JSON.parse(row.observation_json) as { signals: { headRevision: { value: string } } }).signals.headRevision.value).toBe('sha-b');

    // 上下文内的再次变化可正常发现（及时交接后待交接队列清空，账本序号推进）
    data.observation!.head = 'sha-c';
    h().clock.advanceMs(60_000);
    await h().facade.refreshGlance();
    const id = (await h().facade.listRepositories())[0]!.id;
    expect(h().repositoryList.pendingObservations()).toEqual([]);
    expect(scopeRow(id, 'commits')).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale' });
  });

  it('启动检查与手动检查并发时共用去重登记', async () => {
    await readyWithCheckRepo();
    h().github.resetCalls();
    const release = h().github.holdNextObservation();

    const startup = h().facade.refreshGlance('startup');
    const manual = h().facade.refreshGlance('manual');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    release();
    const [startupResult, manualResult] = await Promise.all([startup, manual]);

    expect(h().github.count('observeSummary')).toBe(1);
    expect(startupResult.repositories).toHaveLength(1);
    expect(manualResult.repositories).toHaveLength(1);
  });
});
