import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';
import type { ScopeFetchPort, ScopeVerification, ScopeVerificationPort, ScopeVerifyRequest } from '../../src/domain/ports';
import { createGitHubDetailAdapter } from '../../src/main/core/adapters/github-detail-adapter';
import { createGitHubHttpClient } from '../../src/main/core/adapters/github-http-client';

let harness: Harness | undefined;
afterEach(() => { harness?.destroy(); harness = undefined; });
async function ready(verify: (request: ScopeVerifyRequest) => Promise<ScopeVerification>) {
  const ports: ScopeFetchPort & ScopeVerificationPort = {
    fetchScope: (token, request) => harness!.github.fetchScope(token, request),
    verifyScopes: (_token, request) => verify(request),
  };
  const h = harness = createHarness({ scopePorts: ports });
  await h.facade.saveAccessToken('ghp_valid_token'); h.github.addRepo(makeRepoData());
  await h.facade.addRepository('octo-demo/hello-world'); const id = (await h.facade.listRepositories())[0]!.id;
  expect((await h.facade.fetchDetail(id)).error).toBeNull(); return { h, id };
}
function row(h: Harness, id: number) {
  return h.db.prepare("SELECT verification_progress, synced_fingerprint, observed_fingerprint, last_checked_at, last_synced_at FROM detail_scope_state WHERE repository_id = ? AND scope = 'builds'").get(id) as Record<string, unknown>;
}
async function check(h: Harness, id: number) {
  h.clock.advanceMs(31 * 60_000); await h.facade.fetchDetail(id);
  await vi.waitFor(async () => expect((await h.facade.readLocalDetail(id, { mode: 'status' })).task).toBeNull());
}

describe('有界构建验证进度在feature持久接续', () => {
  it('预算3的多轮未完整验证保存进度，重启接续，完整轮次原子清除并更新检查时间', async () => {
    const requests: ScopeVerifyRequest[] = [];
    const { h, id } = await ready(async request => {
      if (request.scope !== 'builds') return { scope: request.scope, accessContextRevision: request.accessContextRevision, checkedAt: request.checkedAt, checkComplete: true, changed: false, fingerprint: request.baselineFingerprint! };
      requests.push(request); const complete = requests.length === 3;
      return { scope: request.scope, accessContextRevision: request.accessContextRevision, checkedAt: request.checkedAt, changed: false, checkComplete: complete,
        ...(complete ? { fingerprint: request.baselineFingerprint! } : {}), verificationProgress: complete ? null : `round-${requests.length}` };
    });
    const initial = row(h, id); await check(h, id);
    expect(row(h, id)).toMatchObject({ verification_progress: 'round-1', last_checked_at: initial.last_checked_at, synced_fingerprint: initial.synced_fingerprint, last_synced_at: initial.last_synced_at });
    await check(h, id); expect(row(h, id).verification_progress).toBe('round-2');
    h.reopen(); await check(h, id);
    expect(requests.map(request => request.verificationProgress)).toEqual([undefined, 'round-1', 'round-2']);
    expect(requests.map(request => request.maxPages)).toEqual([3, 3, 3]);
    expect(row(h, id)).toMatchObject({ verification_progress: null, last_checked_at: h.clock.now().toISOString(), synced_fingerprint: initial.synced_fingerprint });
  });

  it('undefined保留旧进度；显式null清除；强制新基线也清除旧轮次', async () => {
    let progress: string | null | undefined = 'pending';
    const { h, id } = await ready(async request => ({ scope: request.scope, accessContextRevision: request.accessContextRevision, checkedAt: request.checkedAt, changed: false, checkComplete: request.scope !== 'builds', verificationProgress: request.scope === 'builds' ? progress : undefined }));
    await check(h, id); progress = undefined; await check(h, id); expect(row(h, id).verification_progress).toBe('pending');
    progress = null; await check(h, id); expect(row(h, id).verification_progress).toBeNull();
    progress = 'old'; await check(h, id); expect(row(h, id).verification_progress).toBe('old');
    expect((await h.facade.refreshRepository!(id, true)).error).toBeNull(); expect(row(h, id).verification_progress).toBeNull();
  });

  it('验证状态SQL失败时进度和检查基线同一事务回滚', async () => {
    const { h, id } = await ready(async request => ({ scope: request.scope, accessContextRevision: request.accessContextRevision, checkedAt: request.checkedAt, changed: false, checkComplete: true, fingerprint: request.baselineFingerprint!, verificationProgress: 'should-rollback' }));
    const initial = row(h, id);
    h.db.exec("CREATE TRIGGER fail_progress BEFORE UPDATE ON detail_view_state BEGIN SELECT RAISE(ABORT, '进度原子回滚'); END");
    await check(h, id); expect(row(h, id)).toEqual(initial);
  });

  it('生产适配器验证并修补离开近期页的第3个运行，后继fetch接收进度并交付完成状态', async () => {
    let hidden = false; const calls: string[] = [];
    const run = (id: number) => ({ id, run_attempt: 1, name: 'ci-' + id, html_url: 'https://github.com/octo-demo/hello-world/actions/runs/' + id,
      status: hidden && id === 3 ? 'completed' : 'in_progress', conclusion: hidden && id === 3 ? 'success' : null, updated_at: '2026-09-25T08:30:00.000Z' });
    const adapter = createGitHubDetailAdapter(createGitHubHttpClient((async input => {
      const path = new URL(String(input)).pathname; calls.push(path);
      return new Response(JSON.stringify(path.endsWith('/actions/runs') ? { workflow_runs: hidden ? [] : [run(1), run(2), run(3)] } : run(Number(path.split('/').at(-1)))), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch));
    const seen: Array<{ baseline: string | null | undefined; progress: string | undefined }> = [];
    const ports: ScopeFetchPort & ScopeVerificationPort = {
      fetchScope: async (token, request) => { if (request.scope !== 'builds') return harness!.github.fetchScope(token, request); seen.push({ baseline: request.baselineFingerprint, progress: request.verificationProgress }); return adapter.fetchScope(token, request); },
      verifyScopes: (token, request) => request.scope === 'builds' ? adapter.verifyScopes(token, request) : Promise.resolve({ scope: request.scope, accessContextRevision: request.accessContextRevision, checkedAt: request.checkedAt, checkComplete: true, changed: false }),
    };
    const h = harness = createHarness({ scopePorts: ports }); await h.facade.saveAccessToken('ghp_valid_token'); h.github.addRepo(makeRepoData()); await h.facade.addRepository('octo-demo/hello-world');
    const id = (await h.facade.listRepositories())[0]!.id; expect((await h.facade.fetchDetail(id)).error).toBeNull();
    const baseline = row(h, id).synced_fingerprint; hidden = true;
    await check(h, id);
    const local = await h.facade.readLocalDetail(id, { scopes: ['builds'] });
    expect(calls.filter(path => path.endsWith('/actions/runs/3')).length).toBeGreaterThan(0);
    expect(local.detail!.builds).toContainEqual(expect.objectContaining({ id: '3', status: 'success', workflowName: 'ci-3' }));
    expect(seen.some(request => request.baseline === baseline && request.progress !== undefined)).toBe(true);
    expect(row(h, id).verification_progress).toBeNull();
  });
});
