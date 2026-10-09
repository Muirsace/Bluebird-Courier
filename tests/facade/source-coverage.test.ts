import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';
import { coversSourceTarget } from '../../src/domain/rules/source-coverage';
import type { ContentVersion } from '../../src/domain/types';
import { collectScope } from '../../src/main/features/repository-detail/implementation/refresh-detail';
import { readStagedScope, stagedQueryKey, writeStagedScope } from '../../src/main/features/repository-detail/implementation/staged-scope';
import { createGitHubDetailAdapter } from '../../src/main/core/adapters/github-detail-adapter';
import { createGitHubHttpClient } from '../../src/main/core/adapters/github-http-client';

const NAME = 'octo-demo/hello-world';
let harness: Harness | undefined;
afterEach(() => { harness?.destroy(); harness = undefined; });
async function ready() {
  const h = harness = createHarness();
  await h.facade.saveAccessToken('ghp_valid_token');
  const data = h.github.addRepo(makeRepoData({ observation: { head: 'sha-a', unknown: ['release', 'tag'] },
    commits: [{ sha: 'sha-a', message: 'A', authorName: null, committedAt: '2026-09-25T08:30:00.000Z' }] }));
  await h.facade.addRepository(NAME);
  const id = (await h.facade.listRepositories())[0]!.id;
  await h.facade.refreshGlance();
  expect((await h.facade.fetchDetail(id)).error).toBeNull();
  return { h, id, data };
}
async function changed(h: Harness, data: ReturnType<typeof makeRepoData>, head = 'sha-b') {
  h.clock.advanceMs(60_000); data.observation!.head = head; await h.facade.refreshGlance();
}
function state(h: Harness, id: number) {
  return h.db.prepare("SELECT detected_revision, synced_revision, synced_fingerprint, last_synced_at FROM detail_scope_state WHERE repository_id = ? AND scope = 'commits'").get(id) as Record<string, unknown>;
}

describe('任务捕获源版本与实际交付覆盖', () => {
  it('首次同步已知B目标也不能用缺版的A建立完整成功基线', async () => {
    const h = harness = createHarness();
    await h.facade.saveAccessToken('ghp_valid_token');
    h.github.addRepo(makeRepoData({ observation: { head: 'sha-b', unknown: ['release', 'tag'] },
      commits: [{ sha: 'sha-a', message: 'old A', authorName: null, committedAt: '2026-09-25T08:30:00Z' }] }));
    const id = (await h.facade.addRepository(NAME)).repository!.id;
    await h.facade.refreshGlance();
    const original = h.github.fetchScope.bind(h.github);
    h.github.fetchScope = async (token, request) => {
      const result = await original(token, request);
      if (request.scope === 'commits') return { ...result, version: undefined };
      if (request.scope === 'readme') return { ...result, version: { ...result.version, headRevision: 'sha-b' } };
      return result;
    };
    const result = await h.facade.fetchDetail(id);
    expect(result.error).not.toBeNull();
    expect(result.detailFetchedAt).toBeNull();
    expect(result.detail!.commits).toEqual([]);
    expect(h.db.prepare("SELECT synced_fingerprint FROM detail_scope_state WHERE repository_id=? AND scope='commits'").get(id)).toEqual({ synced_fingerprint: null });
  });

  it('目标B实际A保留旧提交、dirty、成功基线与完整时间，并仍提交无关成功栏目', async () => {
    const { h, id, data } = await ready(); const before = state(h, id);
    const completed = (await h.facade.readLocalDetail(id)).detailFetchedAt;
    await changed(h, data); data.issuesAndPullRequests = [];
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error).not.toBeNull();
    expect(result.detail!.commits[0]!.sha).toBe('sha-a');
    expect(result.detail!.issues).toEqual([]);
    expect(result.detailFetchedAt).toBe(completed);
    expect(state(h, id)).toMatchObject({ detected_revision: 1, synced_revision: before.synced_revision, synced_fingerprint: before.synced_fingerprint, last_synced_at: before.last_synced_at });
  });

  it('目标B实际B才确认，commits请求收到不可变目标', async () => {
    const { h, id, data } = await ready(); await changed(h, data); data.commits[0]!.sha = 'sha-b';
    const original = h.github.fetchScope.bind(h.github); let target: Partial<ContentVersion> | undefined;
    h.github.fetchScope = async (token, request) => { if (request.scope === 'commits') target = request.targetVersion; return original(token, request); };
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error).toBeNull(); expect(target).toMatchObject({ headRevision: 'sha-b', defaultBranch: 'main' });
    expect(state(h, id)).toMatchObject({ detected_revision: 1, synced_revision: 1 });
  });

  it('任务启动B后观察C，实际B只确认启动序号，C仍待同步', async () => {
    const { h, id, data } = await ready(); await changed(h, data); data.commits[0]!.sha = 'sha-b';
    const original = h.github.fetchScope.bind(h.github); let started!: () => void; let release!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    h.github.fetchScope = async (token, request) => { const result = await original(token, request); if (request.scope === 'commits') { started(); await gate; } return result; };
    const fetching = h.facade.refreshRepository!(id, true); await running;
    await changed(h, data, 'sha-c'); release(); await fetching;
    expect(state(h, id)).toMatchObject({ detected_revision: 2, synced_revision: 1 });
    expect((await h.facade.readLocalDetail(id)).detail!.commits[0]!.sha).toBe('sha-b');
  });

  it('known dirty缺少actual版本不能凭HTTP成功或指纹确认', async () => {
    const { h, id, data } = await ready(); await changed(h, data); data.commits[0]!.sha = 'sha-b';
    const original = h.github.fetchScope.bind(h.github);
    h.github.fetchScope = async (token, request) => { const result = await original(token, request); return request.scope === 'commits' ? { ...result, version: undefined } : result; };
    expect((await h.facade.refreshRepository!(id, true)).error).not.toBeNull();
    expect(state(h, id)).toMatchObject({ detected_revision: 1, synced_revision: 0 });
  });

  it('源核验区分unknown、可信null、分支变化与不同范围证据', () => {
    const a = { defaultBranch: 'main', headRevision: 'a', releaseRevision: null, tagRevision: null };
    expect(coversSourceTarget('commits', { headRevision: null }, a, true)).toBe(false);
    expect(coversSourceTarget('commits', {}, a, true)).toBe(true);
    expect(coversSourceTarget('commits', { defaultBranch: 'other' }, a, true)).toBe(false);
    expect(coversSourceTarget('releases', { releaseRevision: 'r' }, a, true)).toBe(false);
    expect(coversSourceTarget('releases', { releaseRevision: null, tagRevision: null }, a, true)).toBe(true);
    expect(coversSourceTarget('builds', { headRevision: 'b', defaultBranch: 'main' }, a, true)).toBe(true);
    expect(coversSourceTarget('commits', undefined, undefined, false)).toBe(true);
    expect(coversSourceTarget('commits', undefined, undefined, true)).toBe(false);
  });

  it('SQL后写失败，实际B的数据与确认全部回滚', async () => {
    const { h, id, data } = await ready(); await changed(h, data); data.commits[0]!.sha = 'sha-b';
    const before = state(h, id); const cache = h.db.prepare('SELECT payload, complete_fetched_at FROM detail_cache WHERE repository_id = ?').get(id);
    h.db.exec("CREATE TRIGGER fail_source_commit BEFORE UPDATE ON detail_column WHEN NEW.column_name = 'builds' BEGIN SELECT RAISE(ABORT, '源确认回滚'); END");
    expect((await h.facade.refreshRepository!(id, true)).error).not.toBeNull();
    expect(state(h, id)).toEqual(before); expect(h.db.prepare('SELECT payload, complete_fetched_at FROM detail_cache WHERE repository_id = ?').get(id)).toEqual(cache);
  });

  it('分支目标也必须匹配实际分支，unknown检查保留之前已知B目标', async () => {
    const { h, id, data } = await ready(); await changed(h, data);
    data.observation!.unknown = ['head', 'release', 'tag']; await h.facade.refreshGlance();
    expect(h.repositoryList.findReference(id)!.contentVersion!.headRevision).toBe('sha-b');
    expect((await h.facade.refreshRepository!(id, true)).error).not.toBeNull();
    expect(state(h, id)).toMatchObject({ detected_revision: 1, synced_revision: 0 });
    data.observation!.unknown = ['release', 'tag']; data.observation!.head = 'sha-a'; data.observation!.defaultBranch = 'other'; await h.facade.refreshGlance();
    const original = h.github.fetchScope.bind(h.github);
    h.github.fetchScope = async (token, request) => { const result = await original(token, request); return request.scope === 'commits' ? { ...result, version: { ...result.version!, defaultBranch: 'main' } } : result; };
    expect((await h.facade.refreshRepository!(id, true)).error).not.toBeNull(); expect(state(h, id).synced_revision).toBe(0);
  });

  it('可信null不被实际非空覆盖；实际空才确认清空，而初始unknown保持字段缺省', async () => {
    const { h, id, data } = await ready(); await changed(h, data); data.observation!.head = null; await h.facade.refreshGlance();
    expect(h.repositoryList.findReference(id)!.contentVersion!.headRevision).toBeNull();
    expect((await h.facade.refreshRepository!(id, true)).error).not.toBeNull();
    data.commits = []; expect((await h.facade.refreshRepository!(id, true)).error).toBeNull();
    expect(state(h, id)).toMatchObject({ detected_revision: 2, synced_revision: 2 });
    expect((await h.facade.readLocalDetail(id)).detail!.commits).toEqual([]);
    h.tokenSettings.advanceAccessContext(h.clock.now().toISOString());
    expect(h.repositoryList.findReference(id)!.contentVersion).toEqual({});
  });

  it('known release目标不匹配保留旧发版；无目标的成功tag栏目仍独立保存', async () => {
    const { h, id, data } = await ready(); data.observation!.unknown = ['tag']; data.observation!.release = 'release-b'; await h.facade.refreshGlance();
    const original = h.github.fetchScope.bind(h.github);
    h.github.fetchScope = async (token, request) => request.scope === 'releases' ? {
      scope: request.scope, accessContextRevision: request.accessContextRevision, observedAt: request.observedAt,
      coverageComplete: true, hasMore: false, nextCursor: null, fingerprint: 'real-a',
      version: { defaultBranch: 'main', headRevision: 'sha-a', releaseRevision: 'release-a', tagRevision: 'tag-new' },
      items: [{ kind: 'release', tagName: 'old-remote', title: 'old', publishedAt: null }, { kind: 'tag', name: 'tag-new', committedAt: null }],
    } : original(token, request);
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error).not.toBeNull(); expect(result.detail!.releases[0]!.tagName).toBe('v2.4.0'); expect(result.detail!.tags![0]!.name).toBe('tag-new');
  });

  it('分页只保留首页HEAD证据；暂存身份绑定目标并隔离损坏版本', async () => {
    const { h, id } = await ready(); const a = { defaultBranch: 'main', headRevision: 'sha-a', releaseRevision: null, tagRevision: null };
    const request = { fullName: NAME, scope: 'commits' as const, defaultBranch: 'main', cursor: null, limit: 1, accessContextRevision: 0, observedAt: h.clock.now().toISOString() };
    const outcome = await collectScope({ fetchScope: async (_token, page) => ({ ...page, items: [{ sha: page.cursor === null ? 'sha-a' : 'historical', message: 'm', authorName: null, committedAt: '2026-09-25T08:30:00.000Z' }],
      coverageComplete: page.cursor !== null, hasMore: page.cursor === null, nextCursor: page.cursor === null ? 'second' : null, fingerprint: page.cursor === null ? 'window' : undefined,
      version: { ...a, headRevision: page.cursor === null ? 'sha-a' : 'historical' } }) }, 'fake', request, () => true);
    expect(outcome.outcome.version!.headRevision).toBe('sha-a');
    const query = { scope: 'commits' as const, fullName: NAME, defaultBranch: 'main', limit: 1, accessContextRevision: 0, schemaVersion: 1, targetVersion: { headRevision: 'sha-a' } };
    expect(stagedQueryKey(query)).not.toBe(stagedQueryKey({ ...query, targetVersion: { headRevision: 'sha-b' } }));
    expect(writeStagedScope(h.db, id, query, { items: outcome.outcome.items, cursor: 'next', fingerprint: 'window', version: a, pages: 2, bytes: 1 }, request.observedAt)).toBe(true);
    expect(readStagedScope(h.db, id, query)!.version).toEqual(a);
    h.db.prepare("UPDATE cache_query_page SET payload = json_set(payload, '$.version.headRevision', 42) WHERE repository_id = ? AND scope = 'commits'").run(id);
    expect(readStagedScope(h.db, id, query)).toBeNull();
  });

  it('带续读游标的单来源网络错误只执行一次，不耗尽分页预算重复请求失败运行', async () => {
    let calls = 0;
    const collected = await collectScope({ fetchScope: async (_token, request) => { calls++; return { ...request, items: [], coverageComplete: false, hasMore: true, nextCursor: 'failed-next', errors: [{ kind: 'network', message: '失败' }] }; } }, 'fake',
      { fullName: NAME, scope: 'builds', defaultBranch: null, cursor: null, limit: 50, accessContextRevision: 0, observedAt: '2026-09-25T08:30:00.000Z' }, () => true);
    expect(calls).toBe(1); expect(collected).toMatchObject({ staged: false, outcome: { coverageComplete: false, fingerprint: undefined } });
  });

  it('partial实际版本暂存保留字段缺省；非法字段与字段类型均隔离', async () => {
    const { h, id } = await ready(); const query = { scope: 'releases' as const, fullName: NAME, defaultBranch: 'main', limit: 1, accessContextRevision: 0, schemaVersion: 1 };
    const save = () => writeStagedScope(h.db, id, query, { items: [{ kind: 'tag', name: 'new', committedAt: null }], cursor: 'next', pages: 1, bytes: 1, version: { tagRevision: 'tag-b', defaultBranch: 'main' } }, h.clock.now().toISOString());
    expect(save()).toBe(true); expect(readStagedScope(h.db, id, query)!.version).toEqual({ tagRevision: 'tag-b', defaultBranch: 'main' });
    expect(readStagedScope(h.db, id, query)!.version).not.toHaveProperty('releaseRevision');
    h.db.prepare("UPDATE cache_query_page SET payload = json_set(payload, '$.version.releaseRevision', 42) WHERE repository_id = ? AND scope = 'releases'").run(id); expect(readStagedScope(h.db, id, query)).toBeNull();
    expect(save()).toBe(true); h.db.prepare("UPDATE cache_query_page SET payload = json_set(payload, '$.version.invalid', 'sha') WHERE repository_id = ? AND scope = 'releases'").run(id); expect(readStagedScope(h.db, id, query)).toBeNull();
  });

  it('生产/latest失败时tag实际证据仍交付成功栏目，release dirty与旧基线保留', async () => {
    const { h, id, data } = await ready(); const before = (await h.facade.readLocalDetail(id)).detailFetchedAt;
    data.observation!.release = 'release-b'; data.observation!.unknown = ['tag']; await h.facade.refreshGlance();
    h.db.prepare("UPDATE detail_scope_state SET detected_revision = detected_revision + 1, dirty_reasons = '[\"release\"]', freshness = 'stale' WHERE repository_id = ? AND scope = 'releases'").run(id);
    const ledger = h.db.prepare("SELECT synced_revision, synced_fingerprint FROM detail_scope_state WHERE repository_id = ? AND scope = 'releases'").get(id);
    const adapter = createGitHubDetailAdapter(createGitHubHttpClient((async input => {
      const path = new URL(String(input)).pathname;
      return new Response(JSON.stringify(path.endsWith('/releases/latest') ? { message: '最新发版服务故障' } : path.endsWith('/tags') ? [{ name: 'tag-new', commit: { sha: 'tag-new-sha' } }] : [{ tag_name: 'stale', name: 'stale', published_at: null }]),
        { status: path.endsWith('/releases/latest') ? 500 : 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch));
    const original = h.github.fetchScope.bind(h.github);
    h.github.fetchScope = (token, request) => request.scope === 'releases' ? adapter.fetchScope(token, request) : original(token, request);
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error).not.toBeNull(); expect(result.detailFetchedAt).toBe(before);
    expect(result.detail!.tags).toEqual([{ name: 'tag-new', committedAt: null }]); expect(result.detail!.releases[0]!.tagName).toBe('v2.4.0');
    expect(h.db.prepare("SELECT synced_revision, synced_fingerprint FROM detail_scope_state WHERE repository_id = ? AND scope = 'releases'").get(id)).toEqual(ledger);
    expect(result.syncState!.releases!.detectedRevision).toBeGreaterThan(result.syncState!.releases!.syncedRevision);
    expect(result.columns!.tags!.status).toBe('success');
  });
});
