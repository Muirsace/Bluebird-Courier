import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData } from '../helpers/fake-github';
import type { RepositoryCapabilities } from '../../src/domain/types';

let harness: Harness | undefined;
afterEach(() => { harness?.destroy(); harness = undefined; });
async function ready() {
  const h = harness = createHarness(); await h.facade.saveAccessToken('ghp_valid_token'); h.github.addRepo(makeRepoData());
  await h.facade.addRepository('octo-demo/hello-world'); return { h, id: (await h.facade.listRepositories())[0]!.id };
}
describe('权威功能能力接入详情采集与验证', () => {
  it('本轮overview能力传给协作采集，明确disabled交付unsupported并允许完整成功', async () => {
    const { h, id } = await ready(); const original = h.github.fetchScope.bind(h.github);
    const capabilities: RepositoryCapabilities = { issues: 'disabled', pullRequests: 'disabled' }; let received: RepositoryCapabilities | undefined;
    h.github.fetchScope = async (token, request) => {
      const result = await original(token, request);
      if (request.scope === 'overview') (result.items[0] as { metadata: { capabilities?: RepositoryCapabilities } }).metadata.capabilities = capabilities;
      if (request.scope === 'issuesAndPr') {
        received = request.capabilities;
        return { ...result, items: [], parts: { issues: { ok: true, coverageComplete: true, hasMore: false, nextCursor: null, availability: 'disabled' }, pullRequests: { ok: true, coverageComplete: true, hasMore: false, nextCursor: null, availability: 'disabled' } } };
      }
      return result;
    };
    const result = await h.facade.fetchDetail(id);
    expect(received).toEqual(capabilities); expect(result.error).toBeNull(); expect(result.detailFetchedAt).toEqual(expect.any(String));
    expect(result.columns!.issues).toMatchObject({ status: 'unsupported', value: null }); expect(result.columns!.pullRequests).toMatchObject({ status: 'unsupported', value: null });
    h.clock.advanceMs(31 * 60_000); let verified: RepositoryCapabilities | undefined;
    h.github.verifyScopes = async (_token, request) => { if (request.scope === 'issuesAndPr') verified = request.capabilities; return { scope: request.scope, accessContextRevision: request.accessContextRevision, checkedAt: request.checkedAt, checkComplete: true, changed: false }; };
    await h.facade.fetchDetail(id); await vi.waitFor(async () => expect((await h.facade.readLocalDetail(id, { mode: 'status' })).task).toBeNull()); expect(verified).toEqual(capabilities);
  });

  it('未提供能力旗标仍unknown，403/404失败保留旧协作内容和完整时间', async () => {
    const { h, id } = await ready(); const first = await h.facade.fetchDetail(id); const original = h.github.fetchScope.bind(h.github); let received: RepositoryCapabilities | undefined;
    h.clock.advanceMs(60_000);
    h.github.fetchScope = async (token, request) => { if (request.scope === 'issuesAndPr') { received = request.capabilities; throw fixtures.notFound(); } return original(token, request); };
    const result = await h.facade.refreshRepository!(id, true);
    expect(received).toBeUndefined(); expect(result.error?.kind).toBe('not_found'); expect(result.detail!.issues).toEqual(first.detail!.issues); expect(result.detailFetchedAt).toBe(first.detailFetchedAt);
  });

  it('关闭PR后复开但来源失败，不再使用旧unsupported冒充仍禁用', async () => {
    const { h, id } = await ready(); const original = h.github.fetchScope.bind(h.github); let enabled = false;
    h.github.fetchScope = async (token, request) => {
      const result = await original(token, request);
      if (request.scope === 'overview') (result.items[0] as { metadata: { capabilities?: RepositoryCapabilities } }).metadata.capabilities = { issues: 'enabled', pullRequests: enabled ? 'enabled' : 'disabled' };
      if (request.scope === 'issuesAndPr') return { ...result, items: enabled ? result.items.filter(item => (item as { kind: string }).kind === 'issue') : [],
        coverageComplete: !enabled, ...(enabled ? { errors: [{ kind: 'not_found' as const, message: 'PR访问被拒绝' }] } : {}),
        parts: { issues: { ok: true, coverageComplete: true, hasMore: false, nextCursor: null },
          pullRequests: { ok: !enabled, coverageComplete: !enabled, hasMore: false, nextCursor: null, availability: enabled ? 'enabled' : 'disabled' } } };
      return result;
    };
    const first = await h.facade.fetchDetail(id);
    expect(first.columns!.pullRequests?.status).toBe('unsupported');
    const before = first.detailFetchedAt;
    enabled = true; h.clock.advanceMs(1000);
    const failed = await h.facade.refreshRepository!(id, true);
    expect(failed.detail!.metadata!.capabilities!.pullRequests).toBe('enabled');
    expect(failed.columns!.pullRequests?.status).toBe('failed');
    expect(failed.error?.kind).toBe('not_found');
    expect(failed.detailFetchedAt).toBe(before);
  });
});
