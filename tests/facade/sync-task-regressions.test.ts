import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData } from '../helpers/fake-github';
import { createGitHubHttpClient } from '../../src/main/core/adapters/github-http-client';
import { createGitHubDetailAdapter } from '../../src/main/core/adapters/github-detail-adapter';
import { REMOTE_SCOPES } from '../../src/domain/rules/detail-scope';
import type { ScopeFetchPort, ScopeVerificationPort } from '../../src/domain/ports';

const NAME = 'octo-demo/hello-world';
let harness: Harness | null = null;
afterEach(() => { harness?.destroy(); harness = null; });
function h(): Harness { if (!harness) throw new Error('测试台未初始化'); return harness; }
async function ready(ports?: ScopeFetchPort & ScopeVerificationPort): Promise<number> {
  harness = createHarness({ scopePorts: ports });
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData());
  expect((await h().facade.addRepository(NAME)).ok).toBe(true);
  return (await h().facade.listRepositories())[0]!.id;
}
async function cached(): Promise<number> { const id = await ready(); expect((await h().facade.fetchDetail(id)).error).toBeNull(); h().github.resetCalls(); return id; }
async function settled(id: number): Promise<void> {
  await vi.waitFor(async () => expect((await h().facade.readLocalDetail(id, { mode: 'status' })).task).toBeNull());
}
function row(id: number, scope: string): Record<string, unknown> {
  return h().db.prepare('SELECT * FROM detail_scope_state WHERE repository_id = ? AND scope = ? AND access_context_revision = 0').get(id, scope) as Record<string, unknown>;
}
function dirty(id: number, scopes: string[], reason = 'head'): void {
  for (const scope of scopes) h().db.prepare('UPDATE detail_scope_state SET detected_revision = detected_revision + 1, dirty_reasons = ?, freshness = ? WHERE repository_id = ? AND scope = ?')
    .run(JSON.stringify([reason]), 'stale', id, scope);
}

/** 真 HTTP 适配器接 feature，路由只替换网络；所有指纹由生产代码生成。 */
function production() {
  const calls: string[] = [];
  const state = { stars: 10, branch: 'main', truncated: false, tagsFail: false, blockedHead: false };
  const port = createGitHubDetailAdapter(createGitHubHttpClient((async input => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    const tail = url.pathname.replace('/repos/' + NAME, '');
    let data: unknown;
    let status = 200;
    if (tail === '') data = { full_name: NAME, stargazers_count: state.stars, forks_count: 2, open_issues_count: 0, pushed_at: '2026-09-25T12:00:00.000Z', default_branch: state.branch };
    else if (tail === '/releases/latest') data = { tag_name: 'v1', name: 'v1', published_at: '2026-09-25T12:00:00.000Z' };
    else if (tail.startsWith('/git/ref/heads/')) { data = { object: { sha: 'sha-head' } }; if (state.blockedHead) status = 401; }
    else if (tail === '/releases') data = [{ tag_name: 'v1', name: 'v1', published_at: '2026-09-25T12:00:00.000Z' }];
    else if (tail === '/tags') { data = [{ name: 'v1', commit: { sha: 'tag-sha' } }]; if (state.tagsFail) status = 500; }
    else if (tail === '/commits') data = [{ sha: 'sha-head', commit: { message: 'first', author: { name: 'octo', date: '2026-09-25T12:00:00.000Z' } } }];
    else if (tail === '/issues' || tail === '/pulls' || tail === '/contents') data = [];
    else if (tail === '/actions/runs') data = { workflow_runs: [] };
    else if (tail.startsWith('/git/trees/')) data = { sha: 'tree-sha', truncated: state.truncated, tree: [{ path: 'README.md', type: 'blob', size: 10 }] };
    else { status = 404; data = { message: 'Unexpected route' }; }
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch));
  return { port, calls, state };
}

describe('后台同步审查回归', () => {
  it('生产接线：首次获取写全部真实指纹，TTL 再验证使用同一窗口并确认无变化', async () => {
    const remote = production(); const id = await ready(remote.port);
    const result = await h().facade.fetchDetail(id);
    expect(result.error).toBeNull();
    for (const scope of REMOTE_SCOPES) {
      expect(row(id, scope).synced_fingerprint).toEqual(expect.any(String));
      expect(JSON.parse(row(id, scope).synced_fingerprint as string).v).toBe(1);
    }
    remote.calls.length = 0;
    h().clock.advanceMs(31 * 60_000);
    const opened = await h().facade.fetchDetail(id);
    expect(opened.task).toMatchObject({ kind: 'check', targetScopes: [...REMOTE_SCOPES] });
    await settled(id);
    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.error).toBeNull();
    for (const scope of REMOTE_SCOPES) expect(status.syncState![scope]).toMatchObject({ freshness: 'fresh', lastCheckedAt: h().clock.now().toISOString() });
    expect(remote.calls.some(path => path.includes('/issues?'))).toBe(true);
    expect(remote.calls.some(path => path.includes('/pulls?'))).toBe(true);
    expect(remote.calls.filter(path => path.includes('/commits?'))).toHaveLength(0);
  });

  it('生产树截断：强制同步保留旧内容和未同步目标，不提供完整覆盖', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    const before = h().db.prepare('SELECT payload, fetched_at FROM detail_cache WHERE repository_id = ?').get(id);
    dirty(id, ['tree']);
    remote.state.truncated = true;
    const result = await h().facade.refreshRepository!(id, true);
    expect(result.detail!.tree).toEqual([{ path: 'README.md', kind: 'file', size: 10 }]);
    expect(result.error).not.toBeNull();
    expect(h().db.prepare('SELECT payload, fetched_at FROM detail_cache WHERE repository_id = ?').get(id)).toEqual(before);
    expect(row(id, 'tree')).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale', sync_status: 'error' });
  });

  it('生产信号鉴权失败：错误类别可读且停止后续范围请求', async () => {
    const remote = production(); const id = await ready(remote.port); await h().facade.fetchDetail(id);
    remote.calls.length = 0; remote.state.blockedHead = true;
    const result = await h().facade.refreshRepository!(id, true);
    expect(result.error?.kind).toBe('access_token_invalid');
    expect(remote.calls.some(path => path.includes('/commits?'))).toBe(false);
    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.error?.kind).toBe('access_token_invalid');
  });

  it('生产首次采样使用真实摘要，抓取的新指标写入清单和快照', async () => {
    const remote = production(); const id = await ready(remote.port);
    remote.state.stars = 321;
    const result = await h().facade.fetchDetail(id);
    expect(result.detail!.repository.stars).toBe(321);
    expect(result.detail!.repository.latestTag).toBe('v1');
    expect(h().db.prepare('SELECT stars FROM snapshot WHERE repository_id = ?').get(id)).toEqual({ stars: 321 });
    expect((await h().facade.listRepositories())[0]!.stars).toBe(321);
  });

  it('遗留缓存没有同步指纹：TTL 到期补抓真实内容，不永久跳过验证', async () => {
    const id = await cached();
    h().db.prepare('UPDATE detail_scope_state SET synced_fingerprint = NULL WHERE repository_id = ?').run(id);
    h().clock.advanceMs(31 * 60_000);
    await h().facade.fetchDetail(id); await settled(id);
    expect(h().github.count('fetchScope')).toBe(7);
    expect(h().github.count('verifyScopes')).toBe(0);
    expect(row(id, 'commits').synced_fingerprint).toEqual(expect.any(String));
  });

  it('后台限流错误跨重启可见，保留恢复时间且不刷新成功时间', async () => {
    const id = await cached(); dirty(id, ['commits']);
    const before = row(id, 'commits').last_synced_at;
    h().github.fail(NAME, 'fetchScope', fixtures.rateLimited(new Date('2026-09-26T08:00:00.000Z')));
    await h().facade.fetchDetail(id); await settled(id);
    h().reopen();
    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.task).toBeNull();
    expect(status.error).toMatchObject({ kind: 'rate_limited', resetAt: '2026-09-26T08:00:00.000Z' });
    expect(row(id, 'commits').last_synced_at).toBe(before);
  });

  it('历史独立分页读取超过30条提交和被Issue预算遮住的PR，无网络与Token依赖', async () => {
    const id = await cached();
    const cache = h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string };
    const payload = JSON.parse(cache.payload);
    payload.values.commits = Array.from({ length: 45 }, (_, i) => ({ sha: String(i), message: 'c', authorName: null, committedAt: '2026-09-25T12:00:00.000Z' }));
    payload.values.issues = Array.from({ length: 35 }, (_, i) => ({ number: i + 1, title: 'i', state: 'open', authorName: null, body: null, updatedAt: '2026-09-25T12:00:00.000Z' }));
    payload.values.pullRequests = [{ number: 99, title: 'pr', state: 'open', authorName: null, body: null, updatedAt: '2026-09-25T12:00:00.000Z' }];
    h().db.prepare('UPDATE detail_cache SET payload = ? WHERE repository_id = ?').run(JSON.stringify(payload), id);
    h().db.prepare("DELETE FROM setting WHERE key = 'access_token'").run();
    const first = await h().facade.loadHistory!(id, 'commits');
    expect(first.items).toHaveLength(30); expect(first.nextCursor).toBe('30');
    const second = await h().facade.loadHistory!(id, 'commits', first.nextCursor!);
    expect(second.items).toHaveLength(15); expect(second.hasMore).toBe(false);
    const pulls = await h().facade.loadHistory!(id, 'pullRequests');
    expect(pulls.items).toMatchObject([{ number: 99 }]);
    expect(h().github.calls).toEqual({});
  });

  it('普通打开复用正在执行的强制任务，后续强制请求也只执行一次', async () => {
    const id = await cached(); dirty(id, ['commits']);
    const release = h().github.holdNext('listReleases');
    const force = h().facade.refreshRepository!(id, true);
    await vi.waitFor(() => expect(h().github.count('listReleases')).toBe(1));
    const opened = await h().facade.fetchDetail(id);
    expect(opened.task?.kind).toBe('force');
    const again = h().facade.refreshRepository!(id, true);
    release(); await Promise.all([force, again]); await settled(id);
    expect(h().github.count('listReleases')).toBe(1);
    expect(row(id, 'commits')).toMatchObject({ detected_revision: 1, synced_revision: 1, sync_status: 'idle' });
  });

  it('普通同步与强制跟进串行，强制跟进只登记一份', async () => {
    const id = await cached(); dirty(id, ['commits']);
    const release = h().github.holdNext('listReleases');
    await h().facade.fetchDetail(id);
    await vi.waitFor(() => expect(h().github.count('listReleases')).toBe(1));
    const a = h().facade.refreshRepository!(id, true);
    const b = h().facade.refreshRepository!(id, true);
    expect((await h().facade.readLocalDetail(id, { mode: 'status' })).task).toMatchObject({ kind: 'force', status: 'queued' });
    expect(h().github.count('listReleases')).toBe(1);
    release(); await Promise.all([a, b]);
    expect(h().github.count('listReleases')).toBe(2);
    expect(row(id, 'commits').synced_revision).toBe(1);
  });

  it('构建窗口重启丢弃旧片段，确认的新指纹必须覆盖当前窗口', async () => {
    const id = await cached(); dirty(id, ['overview', 'builds'], 'build');
    let call = 0;
    h().github.setScopeFetch(NAME, 'builds', async request => {
      call++;
      const base = { scope: request.scope, accessContextRevision: request.accessContextRevision, observedAt: request.observedAt, hasMore: true, nextCursor: 'retry', coverageComplete: false };
      if (call === 1) return { ...base, items: [{ id: 'old' }], fingerprint: 'old' };
      if (call === 2) return { ...base, items: [], windowRestarted: true };
      return { ...base, hasMore: false, nextCursor: null, coverageComplete: true, fingerprint: 'current', items: [{ id: 'new', status: 'success', workflowName: null, url: null, finishedAt: null, resultDescription: 'success' }] };
    });
    await h().facade.fetchDetail(id); await settled(id);
    expect((await h().facade.readLocalDetail(id, { scopes: ['builds'] })).detail!.builds!.map(item => item.id)).toEqual(['new']);
    expect(row(id, 'builds').synced_fingerprint).toBe('current');
  });

  it('来源部分失败即使带指纹也不得确认旧 dirty，保留原缓存', async () => {
    const id = await cached(); dirty(id, ['releases'], 'release');
    const before = h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id);
    h().github.setScopeFetch(NAME, 'releases', async request => ({ scope: request.scope, items: [{ kind: 'release', tagName: 'v9', title: 'v9', publishedAt: null }], fingerprint: 'false-complete', coverageComplete: true, parts: { releases: { ok: true, coverageComplete: true, hasMore: false, nextCursor: null }, tags: { ok: false, coverageComplete: false, hasMore: true, nextCursor: 'retry' } }, hasMore: false, nextCursor: null, accessContextRevision: request.accessContextRevision, observedAt: request.observedAt }));
    await h().facade.fetchDetail(id); await settled(id);
    expect(h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id)).toEqual(before);
    expect(row(id, 'releases')).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale' });
  });

  it('构建验证的关联overview只获得dirty，不获得构建指纹或成功检查时间', async () => {
    const id = await cached();
    const overview = row(id, 'overview'); const builds = row(id, 'builds');
    h().clock.advanceMs(31 * 60_000);
    h().db.prepare("UPDATE detail_scope_state SET last_checked_at = ? WHERE scope <> 'builds'").run(h().clock.now().toISOString());
    h().github.setScopeVerification(NAME, 'builds', { checkedAt: h().clock.now().toISOString(), checkComplete: false, changed: true, fingerprint: 'changed-build' });
    await h().facade.fetchDetail(id); await settled(id);
    expect(row(id, 'builds').detected_revision).toBe(Number(builds.detected_revision) + 1);
    expect(row(id, 'overview')).toMatchObject({ observed_fingerprint: overview.observed_fingerprint, synced_fingerprint: overview.synced_fingerprint, detected_revision: 1, freshness: 'stale' });
    expect(row(id, 'overview').last_checked_at).toBe(h().clock.now().toISOString());
    expect(row(id, 'builds').last_checked_at).toBe(builds.last_checked_at);
  });

  it('完成较早的摘要不能覆盖较新的清单检查，趋势也保持新观察', async () => {
    const id = await cached(); dirty(id, ['commits']);
    h().github.repos.get(NAME)!.meta.stars = 100;
    const release = h().github.holdNext('listReleases');
    await h().facade.fetchDetail(id);
    await vi.waitFor(() => expect(h().github.count('listReleases')).toBe(1));
    h().clock.advanceMs(60_000); h().github.repos.get(NAME)!.meta.stars = 500;
    await h().facade.refreshGlance();
    release(); await settled(id);
    expect((await h().facade.listRepositories())[0]!.stars).toBe(500);
    expect(h().db.prepare('SELECT stars, captured_at FROM snapshot WHERE repository_id = ?').get(id)).toEqual({ stars: 500, captured_at: h().clock.now().toISOString() });
  });
});
