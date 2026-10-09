import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData } from '../helpers/fake-github';
import { initialScopeState } from '../../src/domain/rules/observation-application';
import { writeScopeState } from '../../src/main/features/repository-detail/implementation/detail-store';

const NAME = 'octo-demo/hello-world';
let harness: Harness | null = null;
afterEach(() => { harness?.destroy(); harness = null; });
function h(): Harness { if (!harness) throw new Error('测试台未创建'); return harness; }
async function ready(): Promise<number> {
  harness = createHarness();
  await h().facade.saveAccessToken('ghp_valid_token');
  h().github.addRepo(makeRepoData());
  expect((await h().facade.addRepository(NAME)).ok).toBe(true);
  return (await h().facade.listRepositories())[0]!.id;
}

describe('常规详情排除目录树，保留 README', () => {
  it('首次打开和强制抓取不调用目录树，README成功且完整时间推进', async () => {
    const id = await ready();
    const tree = vi.fn(async () => { throw fixtures.networkError(); });
    h().github.setScopeFetch(NAME, 'tree', tree);
    h().github.setScopeFetch(NAME, 'readme', async request => ({ scope: 'readme', items: [{ language: 'md', content: 'README.md' }], hasMore: false, nextCursor: null,
      coverageComplete: true, observedAt: request.observedAt, accessContextRevision: request.accessContextRevision, fingerprint: 'fp-readme' }));
    const first = await h().facade.fetchDetail(id);
    expect(tree).not.toHaveBeenCalled();
    expect(first.error).toBeNull();
    expect(first.detailFetchedAt).toBe(h().clock.now().toISOString());
    expect(first.columns?.readme?.status).toBe('success');
    expect(first.columns?.tree).toBeUndefined();
    h().clock.advanceMs(1000);
    const forced = await h().facade.refreshRepository!(id, true);
    expect(tree).not.toHaveBeenCalled();
    expect(forced.error).toBeNull();
    expect(forced.detailFetchedAt).toBe(h().clock.now().toISOString());
  });

  it('旧树错误、dirty和暂存不阻碍常规打开，也不伪造树已同步', async () => {
    const id = await ready();
    await h().facade.fetchDetail(id);
    writeScopeState(h().db, id, 'tree', { ...initialScopeState('valid'), detectedRevision: 1, syncedRevision: 0,
      dirtyReasons: ['head'], freshness: 'stale', syncStatus: 'error', lastSyncError: '旧目录树错误',
      lastSyncFailure: { kind: 'not_found', message: '旧目录树错误' } }, 0);
    h().db.prepare('INSERT INTO cache_query_page (repository_id,scope,query_key,access_context_revision,schema_version,payload,cursor,saved_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, 'tree', JSON.stringify([NAME, 'main', 50]), 0, 1, JSON.stringify({ items: [{ path: 'legacy.ts', kind: 'file', size: 1 }], pages: 1, bytes: 48, fingerprint: 'old-tree' }), 'old-cursor', h().clock.now().toISOString());
    h().github.resetCalls();
    const opened = await h().facade.fetchDetail(id);
    expect(opened.task).toBeNull();
    expect(opened.error).toBeNull();
    expect(h().github.calls.fetchScope ?? 0).toBe(0);
    expect((await h().facade.readLocalDetail(id, { mode: 'status' })).error).toBeNull();
    expect(h().db.prepare("SELECT detected_revision,synced_revision FROM detail_scope_state WHERE repository_id=? AND scope='tree'").get(id))
      .toEqual({ detected_revision: 1, synced_revision: 0 });
    const explicit = await h().facade.readLocalDetail(id, { scopes: ['tree'] });
    expect(explicit.error?.message).toBe('旧目录树错误');
  });

  it('README失败仍阻止完整成功，不因排除树而放宽同步条件', async () => {
    const id = await ready();
    h().github.setScopeFetch(NAME, 'readme', async () => { throw fixtures.networkError(); });
    const failed = await h().facade.refreshRepository!(id, true);
    expect(failed.error).not.toBeNull();
    expect(failed.detailFetchedAt).toBeNull();
  });

  it('历史树未查看不阻碍常规详情确认，也不假装历史树已看', async () => {
    const id = await ready();
    await h().facade.fetchDetail(id);
    writeScopeState(h().db, id, 'tree', { ...initialScopeState('valid'), detectedRevision: 5,
      syncedRevision: 0, importantRevision: 5, viewedRevision: 0, dirtyReasons: ['head'], freshness: 'stale' }, 0);
    const current = await h().facade.readLocalDetail(id, { scopes: ['overview'] });
    const result = await h().facade.acknowledgeRepositoryViewed(id, { detailViewVersion: current.detailViewVersion,
      accessContextRevision: current.accessContextRevision, scopes: ['overview'] });
    expect(result).toEqual({ ok: true, seenRevision: 0 });
    expect(h().db.prepare("SELECT important_revision,viewed_revision FROM detail_scope_state WHERE repository_id=? AND scope='tree'").get(id))
      .toEqual({ important_revision: 5, viewed_revision: 0 });
  });
});
