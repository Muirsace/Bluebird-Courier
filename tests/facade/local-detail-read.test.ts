import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';
import type { ObservationHandoff, RepoChangeSet } from '../../src/domain/types';

let harness: Harness | undefined;
afterEach(() => { vi.restoreAllMocks(); harness?.destroy(); harness = undefined; });

async function ready(): Promise<{ h: Harness; id: number }> {
  const h = harness = createHarness();
  await h.facade.saveAccessToken('ghp_valid_token');
  h.github.addRepo(makeRepoData());
  const id = (await h.facade.addRepository('octo-demo/hello-world')).repository!.id;
  await h.facade.fetchDetail(id);
  h.github.resetCalls();
  return { h, id };
}
function change(id: number): RepoChangeSet {
  return { repoId: id, starsChanged: false, forksChanged: false, headChanged: true, releaseChanged: false,
    tagChanged: false, issuesChanged: false, buildsChanged: false, defaultBranchChanged: false,
    previousHeadRevision: 'a', currentHeadRevision: 'b', affectedScopes: ['commits'], detectedAt: '2026-09-26T01:00:00.000Z' };
}
function handoff(id: number, observationId: string, revision = 0): ObservationHandoff {
  return { repoId: id, observationId, accessContextRevision: revision, detectedAt: '2026-09-26T01:00:00.000Z', changeSet: change(id) };
}
function setValues(h: Harness, id: number, patch: Record<string, unknown>): void {
  const row = h.db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string };
  const cache = JSON.parse(row.payload);
  Object.assign(cache.values, patch);
  h.db.prepare('UPDATE detail_cache SET payload = ? WHERE repository_id = ?').run(JSON.stringify(cache), id);
}
function queue(h: Harness, entry: ObservationHandoff): void {
  h.db.prepare('INSERT INTO observation_handoff (observation_id, repository_id, detected_at, access_context_revision, change_set) VALUES (?, ?, ?, ?, ?)')
    .run(entry.observationId, entry.repoId, entry.detectedAt, entry.accessContextRevision, JSON.stringify(entry.changeSet));
}

describe('步骤 7A 审查回归', () => {
  it('单范围查询不解析整份详情、不返回未选择栏目或其完整副本', async () => {
    const { h, id } = await ready();
    const commits = Array.from({ length: 5000 }, (_, i) => ({ sha: 's' + i, message: 'm', authorName: null, committedAt: '2026-09-26T00:00:00.000Z' }));
    setValues(h, id, { commits, readmes: [{ language: 'zh', content: '未选择的长正文'.repeat(100000) }] });
    const parse = vi.spyOn(JSON, 'parse');
    const read = h.repositoryDetail.readLocal(id, { scopes: ['commits'], itemLimit: 2 })!;
    expect(read.values!.commits.map(x => x.sha)).toEqual(['s0', 's1']);
    expect(read.values!.readmes).toEqual([]);
    expect(read.columns.commits?.value).toBeNull();
    expect(JSON.stringify(read)).not.toContain('未选择的长正文');
    expect(parse.mock.calls.some(([input]) => String(input).includes('"values"'))).toBe(false);
    expect(h.github.calls).toEqual({});
  });

  it.each(['issuesAndPr', 'releases'] as const)('%s 共用范围预算，跨双栏目续读无重复和遗漏', async scope => {
    const { h, id } = await ready();
    const item = (number: number) => ({ number, title: 't' + number, state: 'open', body: null, authorName: null, updatedAt: '2026-09-26T00:00:00.000Z' });
    setValues(h, id, { issues: [1, 2, 3, 4, 5].map(item), pullRequests: [6, 7, 8, 9].map(item),
      releases: [1, 2, 3, 4, 5].map(n => ({ tagName: 'r' + n, title: 'r', publishedAt: null })),
      tags: [6, 7, 8, 9].map(n => ({ name: 't' + n })) });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const read = await h.facade.readLocalDetail(id, { scopes: [scope], itemLimit: 3, cursors: { [scope]: cursor } });
      const items = scope === 'issuesAndPr'
        ? [...read.detail!.issues, ...read.detail!.pullRequests].map(x => String(x.number))
        : [...read.detail!.releases.map(x => x.tagName), ...read.detail!.tags!.map(x => x.name)];
      expect(items.length).toBeLessThanOrEqual(3);
      seen.push(...items);
      cursor = read.cursors?.[scope] ?? null;
    } while (cursor);
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  it('游标拒绝跨仓库、跨范围和内容版本变化后的 offset', async () => {
    const { h, id } = await ready();
    const first = await h.facade.readLocalDetail(id, { scopes: ['commits'], itemLimit: 1 });
    const cursor = first.cursors!.commits!;
    const other = h.repositoryList.createPending('acme/other');
    const payload = h.db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string };
    const otherCache = JSON.parse(payload.payload); otherCache.repositoryId = other.id;
    h.db.prepare('INSERT INTO detail_cache (repository_id, payload, fetched_at) VALUES (?, ?, ?)').run(other.id, JSON.stringify(otherCache), h.clock.now().toISOString());
    const foreign = await h.facade.readLocalDetail(other.id, { scopes: ['commits'], cursors: { commits: cursor } });
    expect(foreign.error?.message).toContain('游标已失效');
    const wrongScope = await h.facade.readLocalDetail(id, { scopes: ['releases'], cursors: { releases: cursor } });
    expect(wrongScope.error?.message).toContain('游标已失效');
    await h.facade.refreshRepository!(id, true);
    const changed = await h.facade.readLocalDetail(id, { scopes: ['commits'], cursors: { commits: cursor } });
    expect(changed.error?.message).toContain('游标已失效');
    expect(changed.detail!.commits).toEqual([]);
  });

  it.each([{}, [null]])('损坏的单范围保留其他有效范围并明示错误：%j', async bad => {
    const { h, id } = await ready();
    setValues(h, id, { commits: bad });
    const read = await h.facade.readLocalDetail(id, { scopes: ['commits', 'releases'] });
    expect(read.error?.message).toContain('commits');
    expect(read.detail!.releases.length).toBeGreaterThan(0);
    expect(read.syncState.commits?.cacheStatus).toBe('invalid');
    expect(read.syncState.releases?.cacheStatus).toBe('valid');
    expect(h.github.calls).toEqual({});
  });

  it('预算在直接 feature 调用中同样收口到缺省30和最大200', async () => {
    const { h, id } = await ready();
    setValues(h, id, { commits: Array.from({ length: 300 }, (_, i) => ({ sha: 's' + i, message: 'm', committedAt: '2026-09-26T00:00:00.000Z', authorName: null })) });
    for (const limit of [NaN, Infinity]) expect(h.repositoryDetail.readLocal(id, { scopes: ['commits'], itemLimit: limit })!.values!.commits).toHaveLength(30);
    expect(h.repositoryDetail.readLocal(id, { scopes: ['commits'], itemLimit: 999 })!.values!.commits).toHaveLength(200);
  });

  it('status 不传指纹、不读取payload，旧上下文账本不冒充当前状态', async () => {
    const { h, id } = await ready();
    h.repositoryDetail.applyObservation(handoff(id, 'initial'), h.clock.now().toISOString());
    h.db.prepare("UPDATE detail_scope_state SET observed_fingerprint = '内部原文', synced_fingerprint = '旧内部原文' WHERE repository_id = ?").run(id);
    h.db.prepare("UPDATE detail_cache SET payload = '{broken' WHERE repository_id = ?").run(id);
    const status = await h.facade.readLocalDetail(id, { mode: 'status' });
    expect(status.error).toBeNull();
    expect(status.syncState.commits).not.toHaveProperty('observedFingerprint');
    expect(status.syncState.commits).not.toHaveProperty('syncedFingerprint');
    h.tokenSettings.advanceAccessContext(h.clock.now().toISOString());
    const current = await h.facade.readLocalDetail(id, { mode: 'status' });
    expect(current.syncState.commits?.detectedRevision).toBe(0);
    h.repositoryDetail.applyObservation(handoff(id, 'new-context', 1), h.clock.now().toISOString());
    expect(h.db.prepare("SELECT detected_revision, important_revision, access_context_revision FROM detail_scope_state WHERE repository_id = ? AND scope = 'commits'").get(id))
      .toEqual({ detected_revision: 1, important_revision: 1, access_context_revision: 1 });
  });

  it('新访问上下文实际强制抓取后，缓存元信息正确标记并可本地读取', async () => {
    const { h, id } = await ready();
    h.tokenSettings.advanceAccessContext(h.clock.now().toISOString());
    await h.facade.refreshRepository!(id, true);
    const read = await h.facade.readLocalDetail(id);
    expect(read.error).toBeNull();
    expect(read.accessContextRevision).toBe(1);
    expect(h.db.prepare('SELECT access_context_revision, schema_version FROM detail_cache WHERE repository_id = ?').get(id))
      .toEqual({ access_context_revision: 1, schema_version: 1 });
  });

  it('目标仓库在全局前100条之外，仍消费自己的全部多批观察并保留其他仓库', async () => {
    const { h, id } = await ready();
    const other = h.repositoryList.createPending('acme/other');
    for (let i = 0; i < 101; i++) queue(h, handoff(other.id, 'other-' + i));
    for (let i = 0; i < 205; i++) queue(h, handoff(id, 'target-' + i));
    await h.facade.fetchDetail(id);
    expect(h.repositoryList.pendingObservations(100, { repositoryId: id })).toEqual([]);
    expect(h.db.prepare("SELECT detected_revision FROM detail_scope_state WHERE repository_id = ? AND scope = 'commits'").get(id)).toEqual({ detected_revision: 205 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM observation_handoff WHERE repository_id = ? AND applied_at IS NULL').get(other.id)).toEqual({ n: 101 });
  });

  it('已有dirty与同步基线保留，多原因单观察只递增一次，确认失败后可重启重放', async () => {
    const { h, id } = await ready();
    const entry = handoff(id, 'once');
    h.repositoryDetail.applyObservation(handoff(id, 'older'), h.clock.now().toISOString());
    h.db.prepare("UPDATE detail_scope_state SET dirty_reasons = '[\"旧原因\"]', synced_fingerprint = 'old-success', last_synced_at = '2026-09-20' WHERE repository_id = ?").run(id);
    queue(h, entry);
    vi.spyOn(h.repositoryList, 'confirmObservationHandoff').mockImplementationOnce(() => { throw new Error('确认中断'); });
    await h.facade.fetchDetail(id);
    expect(h.repositoryList.pendingObservations()).toHaveLength(1);
    h.reopen();
    await h.facade.fetchDetail(id);
    expect(h.repositoryList.pendingObservations()).toEqual([]);
    const row = h.db.prepare("SELECT detected_revision, dirty_reasons, synced_fingerprint, last_synced_at FROM detail_scope_state WHERE repository_id = ? AND scope = 'commits'").get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ detected_revision: 2, synced_fingerprint: 'old-success', last_synced_at: '2026-09-20' });
    expect(JSON.parse(row.dirty_reasons as string)).toEqual(['旧原因', 'head']);
  });

  it('趋势仅在选中时读取、有界续读，真实采样改变窗口后旧游标失效', async () => {
    const { h, id } = await ready();
    for (let i = 1; i <= 10; i++) h.db.prepare('INSERT INTO snapshot (repository_id, captured_at, day, stars, forks) VALUES (?, ?, ?, ?, ?)')
      .run(id, '2026-08-' + String(i).padStart(2, '0') + 'T00:00:00.000Z', '2026-08-' + String(i).padStart(2, '0'), i, 1);
    const excluded = await h.facade.readLocalDetail(id, { scopes: ['commits'], itemLimit: 2 });
    expect(excluded.detail!.trend).toEqual([]);
    const first = await h.facade.readLocalDetail(id, { scopes: ['trends'], itemLimit: 3 });
    expect(first.detail!.trend).toHaveLength(3);
    const next = await h.facade.readLocalDetail(id, { scopes: ['trends'], itemLimit: 3, cursors: { trends: first.cursors!.trends! } });
    expect(next.detail!.trend).toHaveLength(3);
    expect(next.detail!.trend[0]!.capturedAt).not.toBe(first.detail!.trend[0]!.capturedAt);
    await h.facade.refreshGlance();
    const changed = await h.facade.readLocalDetail(id, { scopes: ['trends'], cursors: { trends: first.cursors!.trends! } });
    expect(changed.error?.message).toContain('游标已失效');
  });
});

describe('独立本地范围与轻量状态', () => {
  it('首次成功抓取后status报告缓存存在而非missing，freshness保持unknown', async () => {
    const { h, id } = await ready();
    const status = await h.facade.readLocalDetail(id, { mode: 'status' });
    expect(status.syncState.commits).toMatchObject({ cacheStatus: 'valid', freshness: 'unknown', detectedRevision: 0, syncedRevision: 0 });
    const view = await h.facade.readLocalDetail(id, { scopes: ['commits'] });
    expect(view.syncState.commits!.cacheStatus).toBe(status.syncState.commits!.cacheStatus);
  });

  it.each(['missing', 'corrupt', 'schema'] as const)('详情%s时已有趋势独立读取且不解析详情正文', async state => {
    const { h, id } = await ready();
    if (state === 'missing') h.db.prepare('DELETE FROM detail_cache WHERE repository_id = ?').run(id);
    if (state === 'corrupt') h.db.prepare("UPDATE detail_cache SET payload = '{broken' WHERE repository_id = ?").run(id);
    if (state === 'schema') h.db.prepare('UPDATE detail_cache SET schema_version = 99 WHERE repository_id = ?').run(id);
    const parse = vi.spyOn(JSON, 'parse');
    const read = await h.facade.readLocalDetail(id, { scopes: ['trends'], itemLimit: 2 });
    expect(read.error).toBeNull();
    expect(read.detail!.trend.length).toBeGreaterThan(0);
    expect(read.syncState.trends!.cacheStatus).toBe('valid');
    expect(parse.mock.calls.some(([input]) => String(input).includes('"values"'))).toBe(false);
    expect(h.github.calls).toEqual({});
  });

  it('跨上下文的旧趋势不可展示；当前上下文的新采样独立可读', async () => {
    const { h, id } = await ready();
    h.tokenSettings.advanceAccessContext(h.clock.now().toISOString());
    const foreign = await h.facade.readLocalDetail(id, { scopes: ['trends'] });
    expect(foreign.error?.message).toContain('访问上下文');
    expect(foreign.detail).toBeNull();
    await h.facade.refreshGlance();
    const current = await h.facade.readLocalDetail(id, { scopes: ['trends'] });
    expect(current.error).toBeNull();
    expect(current.detail!.trend.length).toBeGreaterThan(0);
    expect(current.syncState.trends!.cacheStatus).toBe('valid');
  });
});

describe('交接失败的范围隔离', () => {
  it('前100条无法应用的观察保留，后续有效观察仍可消费', async () => {
    const { h, id } = await ready();
    for (let i = 0; i < 100; i++) {
      const bad = handoff(id, 'bad-' + i);
      queue(h, bad);
      h.db.prepare('UPDATE observation_handoff SET change_set = ? WHERE observation_id = ?')
        .run(JSON.stringify({ ...bad.changeSet, affectedScopes: {} }), bad.observationId);
    }
    queue(h, handoff(id, 'valid-after'));
    await h.facade.fetchDetail(id);
    expect(h.db.prepare("SELECT applied_at FROM observation_handoff WHERE observation_id = 'valid-after'").get()).toMatchObject({ applied_at: expect.any(String) });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM observation_handoff WHERE observation_id LIKE 'bad-%' AND applied_at IS NULL").get()).toEqual({ n: 100 });
  });
});
