import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData } from '../helpers/fake-github';
import { createGitHubHttpClient } from '../../src/main/core/adapters/github-http-client';
import { createGitHubDetailAdapter } from '../../src/main/core/adapters/github-detail-adapter';
import { REMOTE_SCOPES } from '../../src/domain/rules/detail-scope';
import type { ScopeFetchPort, ScopeVerificationPort } from '../../src/domain/ports';
import { MAX_STAGED_BYTES, readStagedScope, stagedItemsBytes, stagedQueryKey, writeStagedScope } from '../../src/main/features/repository-detail/implementation/staged-scope';

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
/** HTTP 请求口径：树端点的实际请求数。 */
function treeCalls(remote: { calls: string[] }): number {
  return remote.calls.filter(path => path.startsWith('/repos/' + NAME + '/git/trees/')).length;
}
function stagedRow(id: number): { cursor: string | null; payload: string } | undefined {
  return h().db.prepare('SELECT cursor, payload FROM cache_query_page WHERE repository_id = ? AND scope = ?').get(id, 'tree') as { cursor: string | null; payload: string } | undefined;
}
function storedTree(id: number): Array<{ path: string }> {
  return (JSON.parse((h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string }).payload) as { values: { tree: Array<{ path: string }> } }).values.tree;
}
function makeDirtyTree(id: number): void {
  h().db.prepare(`UPDATE detail_scope_state SET detected_revision = detected_revision + 1, dirty_reasons = '["head"]', freshness = 'stale' WHERE repository_id = ? AND scope = 'tree'`).run(id);
}
function bigTree(prefix: string, count = 1601): Array<{ path: string; type: string; size: number }> {
  return Array.from({ length: count }, (_, index) => ({ path: `${prefix}-${index}.ts`, type: 'blob', size: 1 }));
}

/** 真 HTTP 适配器接 feature，路由只替换网络；所有指纹由生产代码生成。 */
function production() {
  const calls: string[] = [];
  const state = {
    stars: 10, branch: 'main', truncated: false, tagsFail: false, blockedHead: false,
    treeSha: 'tree-sha',
    tree: [{ path: 'README.md', type: 'blob', size: 10 }] as Array<{ path: string; type: string; size: number }>,
    /** 按调用次数返回不同的树窗口（验证续读中的窗口重启）。 */
    treeProvider: null as null | (() => { sha: string; tree: Array<{ path: string; type: string; size: number }> }),
    issues: [] as Array<Record<string, unknown>>,
    pulls: [] as Array<Record<string, unknown>>,
    releases: null as null | Array<Record<string, unknown>>,
    /** 注入供应商阻塞：命中路径前缀的请求返回给定状态码（验证限流/认证停止后续 HTTP）。 */
    failTail: null as null | { prefix: string; status: number; resetAt?: string },
  };
  const port = createGitHubDetailAdapter(createGitHubHttpClient((async input => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    const tail = url.pathname.replace('/repos/' + NAME, '');
    if (state.failTail && tail.startsWith(state.failTail.prefix)) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (state.failTail.resetAt) headers['x-ratelimit-reset'] = String(Math.floor(Date.parse(state.failTail.resetAt) / 1000));
      return new Response(JSON.stringify({ message: 'injected provider block' }), { status: state.failTail.status, headers });
    }
    let data: unknown;
    let status = 200;
    if (tail === '') data = { full_name: NAME, stargazers_count: state.stars, forks_count: 2, open_issues_count: 0, pushed_at: '2026-09-25T12:00:00.000Z', default_branch: state.branch };
    else if (tail === '/releases/latest') data = { tag_name: 'v1', name: 'v1', published_at: '2026-09-25T12:00:00.000Z' };
    else if (tail.startsWith('/git/ref/heads/')) { data = { object: { sha: 'sha-head' } }; if (state.blockedHead) status = 401; }
    else if (tail === '/releases') data = state.releases ?? [{ tag_name: 'v1', name: 'v1', published_at: '2026-09-25T12:00:00.000Z' }];
    else if (tail === '/tags') { data = [{ name: 'v1', commit: { sha: 'tag-sha' } }]; if (state.tagsFail) status = 500; }
    else if (tail === '/commits') data = [{ sha: 'sha-head', commit: { message: 'first', author: { name: 'octo', date: '2026-09-25T12:00:00.000Z' } } }];
    else if (tail === '/issues') data = state.issues;
    else if (tail === '/pulls') data = state.pulls;
    else if (tail === '/contents') data = [];
    else if (tail === '/actions/runs') data = { workflow_runs: [] };
    else if (tail.startsWith('/git/trees/')) { const window = state.treeProvider ? state.treeProvider() : { sha: state.treeSha, tree: state.tree }; data = { sha: window.sha, truncated: state.truncated, tree: window.tree }; }
    else { status = 404; data = { message: 'Unexpected route' }; }
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch));
  return { port, calls, state };
}

describe('后台同步审查回归', () => {
  it('暂存预算按真实UTF8字节检查，伪造bytes不能绕过写入或恢复上限', async () => {
    const id = await cached();
    const query = { scope: 'tree' as const, fullName: NAME, defaultBranch: 'main', limit: 50, accessContextRevision: 0, schemaVersion: 1 };
    const items = [{ path: '汉'.repeat(750_000), kind: 'file', size: 1 }];
    expect(JSON.stringify(items).length).toBeLessThan(MAX_STAGED_BYTES);
    expect(stagedItemsBytes(items)).toBeGreaterThan(MAX_STAGED_BYTES);
    expect(writeStagedScope(h().db, id, query, { items, cursor: 'next', pages: 1, bytes: 0, fingerprint: 'window' }, h().clock.now().toISOString())).toBe(false);

    // 模拟损坏的磁盘元信息：实际超限但声明bytes为0，读取必须隔离并删除。
    h().db.prepare('INSERT INTO cache_query_page (repository_id, scope, query_key, access_context_revision, schema_version, payload, cursor, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'tree', stagedQueryKey(query), 0, 1, JSON.stringify({ items, pages: 1, bytes: 0, fingerprint: 'window' }), 'next', h().clock.now().toISOString());
    expect(readStagedScope(h().db, id, query)).toBeNull();
    expect(stagedRow(id)).toBeUndefined();
  });

  it('同范围标签限流时仍提交真实成功发版，不把成功来源擦成空数组', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    remote.state.releases = [{ tag_name: 'v2', name: 'v2', published_at: '2026-10-01T12:00:00.000Z' }];
    const fetchScope = remote.port.fetchScope.bind(remote.port);
    remote.port.fetchScope = async (token, request) => {
      if (request.scope === 'releases') remote.state.failTail = { prefix: '/tags', status: 429 };
      return fetchScope(token, request);
    };
    const result = await h().facade.refreshRepository!(id, true);

    expect(result.error?.kind).toBe('rate_limited');
    expect(result.detail!.releases.map(release => release.tagName)).toEqual(['v2']);
    expect(result.detail!.tags!.map(tag => tag.name)).toEqual(['v1']);
    expect(result.columns!.releases!.status).toBe('success');
  });

  it('暂存内合法JSON的损坏条目必须重建，不能进入成功缓存并确认覆盖', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    makeDirtyTree(id);
    remote.state.tree = bigTree('healthy');
    await h().facade.refreshRepository!(id, true);
    const progress = JSON.parse(stagedRow(id)!.payload);
    progress.items[0] = { bad: 'unreadable' };
    h().db.prepare("UPDATE cache_query_page SET payload = ? WHERE repository_id = ? AND scope = 'tree'").run(JSON.stringify(progress), id);
    remote.calls.length = 0;

    await h().facade.refreshRepository!(id, true);
    expect(treeCalls(remote)).toBe(30);
    expect(storedTree(id)).toEqual([{ path: 'README.md', kind: 'file', size: 10 }]);
    expect(row(id, 'tree').synced_revision).toBe(0);
    expect(JSON.parse(stagedRow(id)!.payload).items[0].path).toBe('healthy-0.ts');
    remote.calls.length = 0;
    const completed = await h().facade.refreshRepository!(id, true);
    expect(treeCalls(remote)).toBe(3);
    expect(completed.error).toBeNull();
    expect(storedTree(id)).toHaveLength(1601);
    expect((await h().facade.readLocalDetail(id, { scopes: ['tree'] })).syncState.tree!.cacheStatus).toBe('valid');
  });

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

  it('生产树截断：保留旧树与未同步目标，不留下可续读假象，其他有效范围不被阻塞', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    const before = h().db.prepare('SELECT payload, fetched_at FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string; fetched_at: string };
    dirty(id, ['tree']);
    remote.state.truncated = true;
    const result = await h().facade.refreshRepository!(id, true);
    expect(result.detail!.tree).toEqual([{ path: 'README.md', kind: 'file', size: 10 }]);
    expect(result.error?.message).toContain('截断'); // 明确降级而不是普通"未完成"
    const after = h().db.prepare('SELECT payload, fetched_at FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string; fetched_at: string };
    expect(after.fetched_at).toBe(before.fetched_at); // 不完整的一轮不刷新完整抓取时间
    expect(JSON.parse(after.payload).values.tree).toEqual(JSON.parse(before.payload).values.tree); // 截断不替换旧树
    expect(row(id, 'tree')).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale', sync_status: 'error' });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM cache_query_page WHERE repository_id = ?').get(id)).toEqual({ n: 0 }); // 截断不能续读，不留暂存
    expect(row(id, 'commits')).toMatchObject({ sync_status: 'idle' }); // 其他范围照常提交
  });

  it('暂存体积超过上限：放弃暂存并保留未确认状态，不做无界增长', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    const beforeTree = storedTree(id);
    // 体积超限的树条目（1500 条 × 约 2KB > 2 MiB 暂存上限）
    remote.state.tree = Array.from({ length: 1601 }, (_, index) => ({ path: `${'p'.repeat(2000)}-${index}.ts`, type: 'blob', size: index }));
    makeDirtyTree(id);
    remote.calls.length = 0;

    const result = await h().facade.refreshRepository!(id, true);
    expect(treeCalls(remote)).toBe(30); // 仍然只跑一批预算
    expect(result.error).not.toBeNull(); // 未完成按失败明示（不冒充成功，也不留不可控暂存）
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM cache_query_page WHERE repository_id = ?').get(id)).toEqual({ n: 0 });
    expect(storedTree(id)).toEqual(beforeTree); // 旧树保留
    expect(row(id, 'tree')).toMatchObject({ synced_revision: 0, freshness: 'stale' });
  });

  it('生产适配器：超过单次页预算的长树在同一打开流程内完整续读', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    h().db.prepare("UPDATE detail_scope_state SET detected_revision = detected_revision + 1, dirty_reasons = '[\"head\"]', freshness = 'stale' WHERE repository_id = ? AND scope = 'tree'").run(id);
    remote.calls.length = 0;
    remote.state.tree = Array.from({ length: 260 }, (_, index) => ({ path: `src/file-${index}.ts`, type: 'blob', size: index }));
    const result = await h().facade.refreshRepository!(id, true);
    expect(result.error).toBeNull();
    // HTTP 口径：树按每页 50 条续读，260 条需要 6 次请求（旧 3 页预算只能读 150 条且每次从第一页重来，永不覆盖）
    expect(remote.calls.filter(path => path.startsWith('/repos/' + NAME + '/git/trees/')).length).toBe(6);
    const payload = h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string };
    const tree = JSON.parse(payload.payload).values.tree as Array<{ path: string; kind: string; size: number }>;
    expect(tree).toHaveLength(260);
    expect(tree[0]).toEqual({ path: 'src/file-0.ts', kind: 'file', size: 0 });
    expect(tree[259]!.path).toBe('src/file-259.ts');
    expect(row(id, 'tree')).toMatchObject({ detected_revision: 1, synced_revision: 1, freshness: 'unknown' });
    expect(row(id, 'tree').synced_fingerprint).toEqual(expect.any(String));
  });

  it('生产适配器：Issue 关闭＋新增数量不变、PR 草稿字段变化都会更新列表', async () => {
    const remote = production(); const id = await ready(remote.port);
    remote.state.issues = [
      { number: 1, title: '旧议题', state: 'open', user: { login: 'a' }, updated_at: '2026-09-25T12:00:00.000Z' },
      { number: 2, title: '将关闭', state: 'open', user: { login: 'b' }, updated_at: '2026-09-25T12:00:00.000Z' },
    ];
    remote.state.pulls = [
      { number: 9, title: '草稿 PR', state: 'open', draft: true, user: { login: 'c' }, updated_at: '2026-09-25T12:00:00.000Z', merged_at: null, head: { ref: 'feat' }, base: { ref: 'main' } },
    ];
    expect((await h().facade.fetchDetail(id)).error).toBeNull();
    expect((await h().facade.readLocalDetail(id, { scopes: ['issuesAndPr'] })).detail!.pullRequests).toMatchObject([{ number: 9, draft: true }]);

    // 数量相同：关闭 #2、新增 #3；PR 从草稿变为可合并。HEAD 与 Release 均未变化。
    remote.state.issues = [
      { number: 1, title: '旧议题', state: 'open', user: { login: 'a' }, updated_at: '2026-09-25T12:00:00.000Z' },
      { number: 3, title: '新议题', state: 'open', user: { login: 'b' }, updated_at: '2026-09-26T01:00:00.000Z' },
      { number: 2, title: '将关闭', state: 'closed', user: { login: 'b' }, updated_at: '2026-09-26T01:00:00.000Z' },
    ];
    remote.state.pulls = [
      { number: 9, title: '草稿 PR', state: 'open', draft: false, user: { login: 'c' }, updated_at: '2026-09-25T12:00:00.000Z', merged_at: null, head: { ref: 'feat' }, base: { ref: 'main' } },
    ];
    h().clock.advanceMs(31 * 60_000);
    const opened = await h().facade.fetchDetail(id);
    expect(opened.task).toMatchObject({ kind: 'check' });

    await settled(id); // 验证发现变化 → 后继完整同步在同一次打开内完成
    const read = await h().facade.readLocalDetail(id, { scopes: ['issuesAndPr'] });
    expect(read.detail!.issues.map(entry => entry.number)).toEqual([3, 2, 1]); // 按更新时间倒序的新列表
    expect(read.detail!.issues.find(entry => entry.number === 2)).toMatchObject({ state: 'closed' });
    expect(read.detail!.pullRequests).toMatchObject([{ number: 9, draft: false }]);
    expect(row(id, 'issuesAndPr')).toMatchObject({ detected_revision: 1, synced_revision: 1, freshness: 'unknown' });
  });

  it('大窗口续读期间树变化：丢弃旧窗口片段、按新窗口重读，内容不混合', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    h().db.prepare("UPDATE detail_scope_state SET detected_revision = detected_revision + 1, dirty_reasons = '[\"head\"]', freshness = 'stale' WHERE repository_id = ? AND scope = 'tree'").run(id);
    remote.calls.length = 0;
    const oldTree = Array.from({ length: 260 }, (_, index) => ({ path: `old-${index}.ts`, type: 'blob', size: 1 }));
    const newTree = Array.from({ length: 120 }, (_, index) => ({ path: `new-${index}.ts`, type: 'blob', size: 2 }));
    let reads = 0;
    remote.state.treeProvider = () => { reads += 1; return reads <= 1 ? { sha: 'sha-old', tree: oldTree } : { sha: 'sha-new', tree: newTree }; };
    const result = await h().facade.refreshRepository!(id, true);
    expect(result.error).toBeNull();
    const payload = h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string };
    const tree = JSON.parse(payload.payload).values.tree as Array<{ path: string }>;
    expect(tree).toHaveLength(120); // 只提交新窗口
    expect(tree.every(entry => entry.path.startsWith('new-'))).toBe(true); // 旧窗口片段已丢弃，不混合
    expect(tree[0]!.path).toBe('new-0.ts');
    expect(reads).toBe(5); // 旧窗口首段 → 窗口重启 → 新窗口三页
    expect(row(id, 'tree')).toMatchObject({ detected_revision: 1, synced_revision: 1 });
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
    expect(first.items).toHaveLength(30);
    // 续读游标绑定仓库、上下文、内容版本与栏目，不再是裸 offset。
    expect(JSON.parse(first.nextCursor!)).toMatchObject({ repositoryId: id, kind: 'commits', offset: 30 });
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

  it('来源部分失败：成功栏目提交、失败栏目保留，带指纹也不确认组合范围', async () => {
    const id = await cached(); dirty(id, ['releases'], 'release');
    const beforeFingerprint = row(id, 'releases').synced_fingerprint;
    h().db.prepare("UPDATE detail_cache SET payload = json_set(payload, '$.values.tags', json(?)) WHERE repository_id = ?")
      .run(JSON.stringify([{ name: 'old-tag', committedAt: null }]), id);
    h().github.setScopeFetch(NAME, 'releases', async request => ({ scope: request.scope, items: [{ kind: 'release', tagName: 'v9', title: 'v9', publishedAt: null }], fingerprint: 'false-complete', coverageComplete: true, parts: { releases: { ok: true, coverageComplete: true, hasMore: false, nextCursor: null }, tags: { ok: false, coverageComplete: false, hasMore: true, nextCursor: 'retry' } }, hasMore: false, nextCursor: null, accessContextRevision: request.accessContextRevision, observedAt: request.observedAt }));
    await h().facade.fetchDetail(id); await settled(id);
    const payload = h().db.prepare('SELECT payload FROM detail_cache WHERE repository_id = ?').get(id) as { payload: string };
    const values = JSON.parse(payload.payload).values as { releases: Array<{ tagName: string }>; tags: Array<{ name: string }> };
    expect(values.releases.map(entry => entry.tagName)).toEqual(['v9']); // 成功来源已提交
    expect(values.tags).toEqual([{ name: 'old-tag', committedAt: null }]); // 失败来源保留旧值
    expect(row(id, 'releases')).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale' });
    expect(row(id, 'releases').synced_fingerprint).toBe(beforeFingerprint); // 部分失败不得推进组合基线
  });

  it('构建验证的关联overview只获得dirty，不获得构建指纹或成功检查时间；同一次打开内随构建组修复', async () => {
    const id = await cached();
    const overview = row(id, 'overview'); const builds = row(id, 'builds');
    h().clock.advanceMs(31 * 60_000);
    h().db.prepare("UPDATE detail_scope_state SET last_checked_at = ? WHERE scope <> 'builds'").run(h().clock.now().toISOString());
    h().github.setScopeVerification(NAME, 'builds', { checkedAt: h().clock.now().toISOString(), checkComplete: false, changed: true, fingerprint: 'changed-build' });
    const gate = h().github.holdNext('fetchScope'); // 后继抓取挂起，先核对验证步骤本身的账本效果
    await h().facade.fetchDetail(id);
    await vi.waitFor(() => expect(h().github.count('fetchScope')).toBe(1));
    expect(row(id, 'builds').detected_revision).toBe(Number(builds.detected_revision) + 1);
    expect(row(id, 'overview')).toMatchObject({ observed_fingerprint: overview.observed_fingerprint, synced_fingerprint: overview.synced_fingerprint, detected_revision: 1, freshness: 'stale' });
    expect(row(id, 'overview').last_checked_at).toBe(h().clock.now().toISOString());
    expect(row(id, 'builds').last_checked_at).toBe(builds.last_checked_at);
    // 后继同步在同一打开流程内完成构建组修复；overview 仍不接收构建指纹，检查时间也不回填
    gate();
    await settled(id);
    expect(row(id, 'overview')).toMatchObject({ observed_fingerprint: overview.observed_fingerprint, synced_fingerprint: overview.synced_fingerprint, detected_revision: 1, synced_revision: 1, freshness: 'unknown' });
    expect(row(id, 'builds').synced_revision).toBe(Number(builds.synced_revision) + 1);
    expect(row(id, 'overview').last_checked_at).toBe(h().clock.now().toISOString());
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

describe('R1 返工：批次续读与限流部分提交', () => {
  it('生产适配器：1601 条稳定树跨批续读，第二批从续读点继续而不是重扫首部', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    remote.state.tree = bigTree('src/file', 1601);
    makeDirtyTree(id);
    remote.calls.length = 0;

    // 第一批：每批 30 页 × 50 条 = 0～1499，仍未覆盖
    const first = await h().facade.refreshRepository!(id, true);
    expect(treeCalls(remote)).toBe(30);
    const staged = stagedRow(id)!;
    expect(staged.cursor).toEqual(expect.any(String));
    expect((JSON.parse(staged.payload) as { items: unknown[] }).items).toHaveLength(1500);
    // 未完成：不替换有效旧树、不确认、不写错误（暂存不是失败）
    expect(first.detail!.tree).toEqual([{ path: 'README.md', kind: 'file', size: 10 }]);
    expect(row(id, 'tree')).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale', sync_status: 'idle' });
    expect(row(id, 'tree').synced_fingerprint).toEqual(expect.any(String));

    // 第二批：只读剩余 3 页（1500-1550、1550-1600、1600-1601），并确认覆盖
    remote.calls.length = 0;
    const second = await h().facade.refreshRepository!(id, true);
    expect(treeCalls(remote)).toBe(3);
    expect(second.error).toBeNull();
    const tree = storedTree(id);
    expect(tree).toHaveLength(1601);
    expect(tree[0]!.path).toBe('src/file-0.ts');
    expect(tree[1600]!.path).toBe('src/file-1600.ts');
    expect(row(id, 'tree')).toMatchObject({ detected_revision: 1, synced_revision: 1, freshness: 'unknown' });
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM cache_query_page WHERE repository_id = ?').get(id)).toEqual({ n: 0 }); // 完成后不留暂存
  });

  it('生产适配器：续读期间树窗口变化 → 丢弃旧片段只提交新窗口', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    remote.state.tree = bigTree('old', 1601);
    makeDirtyTree(id);
    await h().facade.refreshRepository!(id, true); // 第一批：暂存旧窗口 0～1499
    const stagedOld = JSON.parse(stagedRow(id)!.payload) as { items: Array<{ path: string }> };
    expect(stagedOld.items).toHaveLength(1500);
    expect(stagedOld.items.every(item => item.path.startsWith('old-'))).toBe(true);

    // 窗口变化后的第二批：旧片段必须丢弃，不能混合（重启那一页占掉一批预算，故本批装配 1450 条）
    let reads = 0;
    remote.state.treeProvider = () => { reads += 1; return { sha: 'sha-new', tree: bigTree('new', 1601) }; };
    await h().facade.refreshRepository!(id, true);
    const stagedNew = JSON.parse(stagedRow(id)!.payload) as { items: Array<{ path: string }> };
    expect(stagedNew.items).toHaveLength(1450);
    expect(stagedNew.items.every(item => item.path.startsWith('new-'))).toBe(true);
    expect(reads).toBe(30);

    // 第三批：按新窗口完成
    await h().facade.refreshRepository!(id, true);
    const tree = storedTree(id);
    expect(tree).toHaveLength(1601);
    expect(tree.every(entry => entry.path.startsWith('new-'))).toBe(true);
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM cache_query_page WHERE repository_id = ?').get(id)).toEqual({ n: 0 });
  });

  it('生产适配器：应用重启后续读暂存继续可用，也不伪装运行中', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    remote.state.tree = bigTree('src/f', 1601);
    makeDirtyTree(id);
    await h().facade.refreshRepository!(id, true); // 第一批
    h().reopen(); // 模拟应用重启：在途登记清空，暂存留在库里
    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.task).toBeNull();
    expect(h().db.prepare('SELECT COUNT(*) AS n FROM cache_query_page WHERE repository_id = ?').get(id)).toEqual({ n: 1 });

    remote.calls.length = 0;
    await h().facade.refreshRepository!(id, true); // 重启后从续读点继续
    expect(treeCalls(remote)).toBe(3);
    expect(storedTree(id)).toHaveLength(1601);
  });

  it('暂存不可接续：旧上下文、损坏或参数漂移的记录都不得回填，从稳定窗口重建', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    remote.state.tree = bigTree('v1', 1601);
    makeDirtyTree(id);
    await h().facade.refreshRepository!(id, true);
    expect(stagedRow(id)).toBeDefined();
    const queryKey = JSON.stringify([NAME, 'main', 50]);
    const insertStaged = (context: number, key: string, payload: string, cursor: string): void => {
      h().db.prepare('INSERT INTO cache_query_page (repository_id, scope, query_key, access_context_revision, schema_version, payload, cursor, has_more, saved_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?)')
        .run(id, 'tree', key, context, payload, cursor, h().clock.now().toISOString());
    };
    const resetStaging = (): void => { h().db.prepare('DELETE FROM cache_query_page WHERE repository_id = ?').run(id); };

    // Token 更换推进访问上下文：旧上下文暂存（含伪造片段）不得回填
    resetStaging();
    insertStaged(0, queryKey, JSON.stringify({ items: [{ path: 'stale-ctx.ts' }], pages: 1, bytes: 20 }), 'stale-ctx-cursor');
    h().tokenSettings.advanceAccessContext(h().clock.now().toISOString());
    remote.state.tree = bigTree('newctx', 1601);
    remote.calls.length = 0;
    await h().facade.refreshRepository!(id, true); // 新上下文第一批
    expect(treeCalls(remote)).toBe(30); // 从窗口起点重建，未按旧上下文游标续读
    const stagedAfterContext = JSON.parse(stagedRow(id)!.payload) as { items: Array<{ path: string }> };
    expect(stagedAfterContext.items.every(item => item.path.startsWith('newctx-'))).toBe(true);
    await h().facade.refreshRepository!(id, true);
    expect(storedTree(id)).toHaveLength(1601);
    expect(storedTree(id).some(entry => entry.path === 'stale-ctx.ts')).toBe(false); // 旧片段未混入内容

    // 损坏记录（身份匹配但 payload 不可解析）：不接续，就地清理并重建
    resetStaging();
    insertStaged(1, queryKey, '{broken', 'resume');
    remote.calls.length = 0;
    const rebuilt = await h().facade.refreshRepository!(id, true);
    expect(rebuilt.error).toBeNull();
    expect(treeCalls(remote)).toBe(30); // 未按损坏游标续读
    expect(stagedRow(id)!.cursor).not.toBe('resume');

    // 参数漂移（旧每页上限）：开窗时清理，旧片段不进入内容
    resetStaging();
    insertStaged(1, JSON.stringify([NAME, 'main', 30]), JSON.stringify({ items: [{ path: 'stale.ts' }], pages: 1, bytes: 20 }), 'stale-cursor');
    remote.calls.length = 0;
    const redone = await h().facade.refreshRepository!(id, true);
    expect(redone.error).toBeNull();
    expect(treeCalls(remote)).toBe(30); // 身份漂移同样从窗口起点重建
    expect(storedTree(id).some(entry => entry.path === 'stale.ts')).toBe(false);
    // 漂移行已清理，只剩当前身份的新暂存
    expect(h().db.prepare('SELECT query_key FROM cache_query_page WHERE repository_id = ? AND scope = ?').get(id, 'tree')).toEqual({ query_key: queryKey });
  });

  it('限流：已取得的成功范围原子提交，停止后续 HTTP，未尝试范围保留旧值与 dirty', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    remote.state.releases = [{ tag_name: 'v2', name: 'v2', published_at: '2026-09-26T00:00:00.000Z' }];
    dirty(id, ['readme'], 'head'); // 未尝试范围带未同步变化
    const beforeTree = storedTree(id);
    const beforeReadme = row(id, 'readme').synced_fingerprint;
    // 构建范围（第 5 个）被限流：readme/tree 不应再被请求
    remote.state.failTail = { prefix: '/actions/runs', status: 429, resetAt: '2026-09-26T08:00:00.000Z' };
    remote.calls.length = 0;

    const result = await h().facade.refreshRepository!(id, true);
    expect(result.error).toMatchObject({ kind: 'rate_limited', resetAt: '2026-09-26T08:00:00.000Z' });
    // 已取得范围提交：发版更新到 v2（内容与确认同一事务）
    const read = await h().facade.readLocalDetail(id, { scopes: ['releases'] });
    expect(read.detail!.releases.map(entry => entry.tagName)).toEqual(['v2']);
    expect(row(id, 'releases').sync_status).toBe('idle');
    // 停止后续 HTTP：构建后的 readme/tree 没有被请求
    expect(remote.calls.filter(path => path.includes('/actions/runs'))).toHaveLength(1);
    expect(remote.calls.some(path => path.includes('/contents'))).toBe(false);
    expect(remote.calls.some(path => path.includes('/git/trees/'))).toBe(false);
    expect(remote.calls.filter(path => path.includes('/releases?'))).toHaveLength(1);
    // 未尝试/阻塞范围：保留旧值与 dirty，按阻塞原因明示不可提交
    expect(storedTree(id)).toEqual(beforeTree);
    expect(row(id, 'readme')).toMatchObject({ detected_revision: 1, synced_revision: 0, freshness: 'stale', sync_status: 'error' });
    expect(row(id, 'readme').synced_fingerprint).toBe(beforeReadme);
    expect(JSON.parse(String(row(id, 'builds').last_sync_error))).toMatchObject({ kind: 'rate_limited', resetAt: '2026-09-26T08:00:00.000Z' });
    expect(h().github.count('verifyScopes')).toBe(0); // 不安排后继
    await settled(id);
    h().reopen();
    const status = await h().facade.readLocalDetail(id, { mode: 'status' });
    expect(status.error).toMatchObject({ kind: 'rate_limited', resetAt: '2026-09-26T08:00:00.000Z' }); // 错误跨重启可读
    expect(storedTree(id)).toEqual(beforeTree);
  });

  it('认证失败：同样保留此前成功范围、停止后续请求，未取得范围不写成空成功', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    remote.state.releases = [{ tag_name: 'v2', name: 'v2', published_at: '2026-09-26T00:00:00.000Z' }];
    const beforeTree = storedTree(id);
    remote.state.failTail = { prefix: '/commits', status: 401 }; // 第 3 个范围起停止
    remote.calls.length = 0;

    const result = await h().facade.refreshRepository!(id, true);
    expect(result.error).toMatchObject({ kind: 'access_token_invalid' });
    expect((await h().facade.readLocalDetail(id, { scopes: ['releases'] })).detail!.releases.map(entry => entry.tagName)).toEqual(['v2']);
    expect(remote.calls.some(path => path.includes('/actions/runs'))).toBe(false);
    expect(remote.calls.some(path => path.includes('/git/trees/'))).toBe(false);
    expect(row(id, 'commits')).toMatchObject({ sync_status: 'error' });
    expect(JSON.parse(String(row(id, 'commits').last_sync_error))).toMatchObject({ kind: 'access_token_invalid' });
    expect(storedTree(id)).toEqual(beforeTree);
    expect((await h().facade.readLocalDetail(id, { scopes: ['commits'] })).detail!.commits).toEqual([{ sha: 'sha-head', message: 'first', authorName: 'octo', committedAt: '2026-09-25T12:00:00.000Z' }]);
  });

  it('阻塞发生在最后一个范围：此前取得的内容仍提交，旧树保留且不写成空成功', async () => {
    const remote = production(); const id = await ready(remote.port);
    await h().facade.fetchDetail(id);
    remote.state.releases = [{ tag_name: 'v2', name: 'v2', published_at: '2026-09-26T00:00:00.000Z' }];
    const beforeTree = storedTree(id);
    remote.state.failTail = { prefix: '/git/trees/', status: 429, resetAt: '2026-09-26T09:00:00.000Z' };

    const result = await h().facade.refreshRepository!(id, true);
    expect(result.error).toMatchObject({ kind: 'rate_limited', resetAt: '2026-09-26T09:00:00.000Z' });
    expect((await h().facade.readLocalDetail(id, { scopes: ['releases'] })).detail!.releases.map(entry => entry.tagName)).toEqual(['v2']);
    expect(storedTree(id)).toEqual(beforeTree);
    expect(row(id, 'tree')).toMatchObject({ synced_revision: 0, freshness: 'unknown', sync_status: 'error' }); // 无未同步变化，未被阻塞轮次误标为 stale/fresh
    expect(JSON.parse(String(row(id, 'tree').last_sync_error))).toMatchObject({ kind: 'rate_limited', resetAt: '2026-09-26T09:00:00.000Z' });
    const treeColumn = h().db.prepare("SELECT state FROM detail_column WHERE repository_id = ? AND column_name = 'tree'").get(id) as { state: string };
    expect(treeColumn.state).not.toBe('empty'); // 阻塞不得解释为空成功

    // 无缓存时同样如此：只建立实际取得的内容，失败/未取得范围标为失败，完整时间保持未知
    const plain = production(); const second = await ready(plain.port);
    plain.state.failTail = { prefix: '/git/trees/', status: 429, resetAt: '2026-09-26T09:00:00.000Z' };
    const opened = await h().facade.fetchDetail(second);
    expect(opened.error).toMatchObject({ kind: 'rate_limited' });
    expect(opened.detailFetchedAt ?? null).toBeNull();
    expect(h().db.prepare('SELECT complete_fetched_at FROM detail_cache WHERE repository_id = ?').get(second)).toEqual({ complete_fetched_at: null });
    const createdTreeColumn = h().db.prepare("SELECT state, payload FROM detail_column WHERE repository_id = ? AND column_name = 'tree'").get(second) as { state: string; payload: string | null };
    expect(createdTreeColumn).toMatchObject({ state: 'failed', payload: null }); // 失败范围不写成空数组成功
    expect(row(second, 'tree')).toMatchObject({ sync_status: 'error' });
    expect(JSON.parse(String(row(second, 'tree').last_sync_error))).toMatchObject({ kind: 'rate_limited' });
  });
});
