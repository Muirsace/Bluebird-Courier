import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData } from '../helpers/fake-github';

let harness: Harness | undefined;
afterEach(() => { harness?.destroy(); harness = undefined; });

async function ready() {
  const h = harness = createHarness();
  await h.facade.saveAccessToken('ghp_valid_token');
  const data = h.github.addRepo(makeRepoData({ observation: { head: 'sha-a', unknown: ['release', 'tag'] } }));
  const id = (await h.facade.addRepository(data.meta.fullName)).repository!.id;
  await h.facade.refreshGlance();
  expect((await h.facade.fetchDetail(id)).error).toBeNull();
  const completeAt = (await h.facade.readLocalDetail(id)).detailFetchedAt;
  h.clock.advanceMs(60_000);
  return { h, data, id, completeAt };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('概览源目标失配的有界恢复', () => {
  it.each([false, true])('旧目标A、当前B在同一次强制同步内恢复：先前摘要局部失败=%s', async partialFailure => {
    const { h, data, id, completeAt } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    if (partialFailure) {
      data.observation!.unknown = ['head', 'release', 'tag'];
      data.observation!.errors = [{ kind: 'network', message: '网络失败' }];
      await h.facade.refreshGlance();
      data.observation!.unknown = ['release', 'tag']; data.observation!.errors = undefined;
    }
    const checks = h.github.calls.observeSummary ?? 0;
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error).toBeNull();
    expect(result.detailFetchedAt).not.toBe(completeAt);
    expect(result.detail!.commits[0]!.sha).toBe('sha-b');
    expect(h.repositoryList.findReference(id)?.contentVersion?.headRevision).toBe('sha-b');
    expect(result.syncState!.commits).toMatchObject({ detectedRevision: 1, syncedRevision: 1 });
    expect((h.github.calls.observeSummary ?? 0) - checks).toBe(1);
  });

  it('已有缓存的后台打开也在同一个任务登记中恢复', async () => {
    const { h, data, id, completeAt } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    h.db.prepare("UPDATE detail_scope_state SET detected_revision=detected_revision+1,dirty_reasons='[\"head\"]' WHERE repository_id=? AND scope='commits'").run(id);
    const result = await h.facade.fetchDetail(id);
    expect(result.detail!.commits[0]!.sha).toBe('sha-a');
    expect(result.task).not.toBeNull();
    await expect.poll(async () => (await h.facade.readLocalDetail(id, { mode: 'status' })).task).toBeNull();
    const completed = await h.facade.readLocalDetail(id);
    expect(completed.detail!.commits[0]!.sha).toBe('sha-b');
    expect(completed.detailFetchedAt).not.toBe(completeAt);
    expect(completed.syncState.overview?.lastSyncError).toBeUndefined();
  });

  it('正常强制同步不额外检查摘要', async () => {
    const { h, id } = await ready();
    const checks = h.github.calls.observeSummary ?? 0;
    expect((await h.facade.refreshRepository!(id, true)).error).toBeNull();
    expect(h.github.calls.observeSummary ?? 0).toBe(checks);
  });

  it('摘要再次确认原目标时不重复抓取，也不将冲突概览当成成功', async () => {
    const { h, id, completeAt } = await ready();
    const original = h.github.fetchScope.bind(h.github); let overviews = 0;
    h.github.fetchScope = async (token, request) => {
      const outcome = await original(token, request);
      if (request.scope !== 'overview') return outcome;
      overviews++;
      return { ...outcome, version: { ...outcome.version, headRevision: 'conflicting-head' } };
    };
    const checks = h.github.calls.observeSummary ?? 0;
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error?.message).toContain('overview 实际源版本未覆盖任务目标');
    expect(result.detailFetchedAt).toBe(completeAt);
    expect(overviews).toBe(1);
    expect((h.github.calls.observeSummary ?? 0) - checks).toBe(1);
  });

  it('重试时仓库再次变化，最多两次详情获取，仍保留完整成功时间', async () => {
    const { h, data, id, completeAt } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    const original = h.github.fetchScope.bind(h.github); let overviews = 0;
    h.github.fetchScope = async (token, request) => {
      if (request.scope === 'overview' && ++overviews === 2) {
        data.observation!.head = 'sha-c'; data.commits[0]!.sha = 'sha-c';
      }
      return original(token, request);
    };
    const checks = h.github.calls.observeSummary ?? 0;
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error?.message).toContain('overview 实际源版本未覆盖任务目标');
    expect(result.detailFetchedAt).toBe(completeAt);
    expect(overviews).toBe(2);
    expect((h.github.calls.observeSummary ?? 0) - checks).toBe(1);
    expect(result.syncState!.overview!.detectedRevision).toBeGreaterThan(result.syncState!.overview!.syncedRevision);
  });

  it.each(['network', 'access_token_invalid', 'rate_limited'] as const)('恢复检查%s失败时停止重试并透传真实错误', async kind => {
    const { h, data, id, completeAt } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    h.github.failures.set(data.meta.fullName, { observeSummary: kind === 'network' ? fixtures.networkError() : kind === 'access_token_invalid' ? fixtures.unauthorized() : fixtures.rateLimited(h.clock.now()) });
    const original = h.github.fetchScope.bind(h.github); let overviews = 0;
    h.github.fetchScope = async (token, request) => { if (request.scope === 'overview') overviews++; return original(token, request); };
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error?.kind).toBe(kind);
    expect(result.detailFetchedAt).toBe(completeAt);
    expect(result.detail!.commits[0]!.sha).toBe('sha-a');
    expect(overviews).toBe(1);
  });

  it('恢复检查在途时，并发强制同步与打开复用同一个任务', async () => {
    const { h, data, id } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    const checks = h.github.count('observeSummary');
    const release = h.github.holdNextObservation();
    const original = h.github.fetchScope.bind(h.github); let overviews = 0;
    h.github.fetchScope = async (token, request) => { if (request.scope === 'overview') overviews++; return original(token, request); };
    const first = h.facade.refreshRepository!(id, true);
    await expect.poll(() => h.github.count('observeSummary')).toBe(checks + 1);
    const recovering = await h.facade.readLocalDetail(id, { mode: 'status' });
    expect(recovering.task?.status).toBe('running');
    const concurrent = h.facade.refreshRepository!(id, true);
    const opened = await h.facade.fetchDetail(id);
    expect(opened.task?.taskId).toBe(recovering.task!.taskId);
    expect(opened.detail!.commits[0]!.sha).toBe('sha-a');
    release();
    const results = await Promise.all([first, concurrent]);
    for (const result of results) {
      expect(result.error).toBeNull();
      expect(result.detail!.commits[0]!.sha).toBe('sha-b');
    }
    expect(overviews).toBe(2);
    expect(h.github.count('observeSummary') - checks).toBe(1);
    expect((await h.facade.readLocalDetail(id, { mode: 'status' })).task).toBeNull();
  });

  it.each(['token', 'remove'] as const)('恢复摘要等待期间%s变化，不重试也不回填旧上下文', async change => {
    const { h, data, id } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    const started = deferred(); const release = deferred();
    const observe = h.github.observeSummary.bind(h.github);
    h.github.observeSummary = async (...args) => { const result = await observe(...args); started.resolve(); await release.promise; return result; };
    const fetch = h.github.fetchScope.bind(h.github); let overviews = 0;
    h.github.fetchScope = async (token, request) => { if (request.scope === 'overview') overviews++; return fetch(token, request); };
    const refreshing = h.facade.refreshRepository!(id, true);
    await started.promise;
    if (change === 'token') {
      h.github.validAccessToken = 'ghp_replacement';
      expect((await h.facade.beginTokenReplacement!()).ok).toBe(true);
      expect((await h.facade.confirmTokenReplacement!('ghp_replacement')).ok).toBe(true);
    } else await h.facade.removeRepository(id);
    release.resolve(); await refreshing;
    expect(overviews).toBe(1);
    expect(h.repositoryList.pendingObservations()).toEqual([]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM detail_cache WHERE repository_id = ?').get(id)).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot WHERE repository_id = ?').get(id)).toEqual({ n: 0 });
    if (change === 'remove') expect(h.repositoryList.findById(id)).toBeNull();
    else {
      expect(h.tokenSettings.accessContextRevision()).toBe(1);
      expect(h.repositoryList.findReference(id)?.contentVersion?.headRevision).not.toBe('sha-b');
    }
  });

  it('第一轮已有供应商限流时，概览冲突不再发出恢复检查', async () => {
    const { h, data, id, completeAt } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    h.github.fail(data.meta.fullName, 'listCommits', fixtures.rateLimited(h.clock.now()));
    const checks = h.github.count('observeSummary');
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error?.kind).toBe('rate_limited');
    expect(result.detailFetchedAt).toBe(completeAt);
    expect(result.detail!.commits[0]!.sha).toBe('sha-a');
    expect(h.github.count('observeSummary')).toBe(checks);
    expect(h.repositoryList.findReference(id)?.contentVersion?.headRevision).toBe('sha-a');
  });

  it('恢复摘要的HEAD已知更新，其他信号网络失败仍允许重抓成功', async () => {
    const { h, data, id, completeAt } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    data.observation!.errors = [{ kind: 'network', message: '标签检查网络失败' }];
    const checks = h.github.count('observeSummary');
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error).toBeNull();
    expect(result.detailFetchedAt).not.toBe(completeAt);
    expect(result.detail!.commits[0]!.sha).toBe('sha-b');
    expect(h.repositoryList.findReference(id)?.contentVersion?.headRevision).toBe('sha-b');
    expect(h.github.count('observeSummary') - checks).toBe(1);
  });

  it('恢复摘要HEAD未知时保留已知A目标，不能依据概览B自行重抓', async () => {
    const { h, data, id, completeAt } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    data.observation!.unknown = ['head', 'release', 'tag'];
    const checks = h.github.count('observeSummary');
    const fetch = h.github.fetchScope.bind(h.github); let overviews = 0;
    h.github.fetchScope = async (token, request) => { if (request.scope === 'overview') overviews++; return fetch(token, request); };
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error).not.toBeNull();
    expect(result.detailFetchedAt).toBe(completeAt);
    expect(result.detail!.commits[0]!.sha).toBe('sha-a');
    expect(h.repositoryList.findReference(id)?.contentVersion?.headRevision).toBe('sha-a');
    expect(overviews).toBe(1);
    expect(h.github.count('observeSummary') - checks).toBe(1);
  });

  it.each(['version', 'head', 'content', 'coverage', 'fingerprint'] as const)('概览缺少%s证据时不触发恢复检查', async missing => {
    const { h, data, id, completeAt } = await ready();
    data.observation!.head = 'sha-b';
    const original = h.github.fetchScope.bind(h.github);
    h.github.fetchScope = async (token, request) => {
      const outcome = await original(token, request);
      if (request.scope !== 'overview') return outcome;
      if (missing === 'version') return { ...outcome, version: undefined };
      if (missing === 'head') { const { headRevision: _head, ...version } = outcome.version!; return { ...outcome, version }; }
      if (missing === 'content') return { ...outcome, items: [] };
      if (missing === 'coverage') return { ...outcome, coverageComplete: false };
      return { ...outcome, fingerprint: undefined };
    };
    const checks = h.github.count('observeSummary');
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error).not.toBeNull();
    expect(result.detailFetchedAt).toBe(completeAt);
    expect(h.github.count('observeSummary')).toBe(checks);
    expect(h.repositoryList.findReference(id)?.contentVersion?.headRevision).toBe('sha-a');
  });

  it('只有提交范围返回B而概览仍为A时，不触发源目标恢复', async () => {
    const { h, data, id, completeAt } = await ready();
    data.commits[0]!.sha = 'sha-b';
    const checks = h.github.count('observeSummary');
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error?.message).toContain('commits 实际源版本未覆盖任务目标');
    expect(result.detail!.commits[0]!.sha).toBe('sha-a');
    expect(result.detailFetchedAt).toBe(completeAt);
    expect(h.github.count('observeSummary')).toBe(checks);
    expect(h.repositoryList.findReference(id)?.contentVersion?.headRevision).toBe('sha-a');
  });

  it('重新捕获B目标后丢弃A暂存游标，从B首页读取且不混入A片段', async () => {
    const { h, data, id } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    const fetch = h.github.fetchScope.bind(h.github);
    const cursors: Array<{ head: string | null | undefined; cursor: string | null }> = [];
    h.github.fetchScope = async (token, request) => {
      if (request.scope !== 'commits') return fetch(token, request);
      const head = request.targetVersion?.headRevision;
      cursors.push({ head, cursor: request.cursor });
      if (head !== 'sha-a') return fetch(token, request);
      const page = Number(request.cursor ?? 0);
      return { scope: request.scope, accessContextRevision: request.accessContextRevision, observedAt: request.observedAt,
        items: [{ ...data.commits[0]!, sha: `old-a-${page}` }], coverageComplete: false, hasMore: true,
        nextCursor: String(page + 1), fingerprint: 'old-a-window', version: { defaultBranch: 'main', headRevision: 'sha-a' } };
    };
    const observe = h.github.observeSummary.bind(h.github);
    h.github.observeSummary = async (...args) => {
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM cache_query_page WHERE repository_id = ? AND scope = 'commits'").get(id)).toEqual({ n: 1 });
      return observe(...args);
    };
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error).toBeNull();
    expect(cursors.filter(item => item.head === 'sha-a').length).toBeGreaterThan(1);
    expect(cursors.filter(item => item.head === 'sha-b')).toEqual([{ head: 'sha-b', cursor: null }]);
    expect(result.detail!.commits.map(item => item.sha)).toEqual(data.commits.map(item => item.sha));
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM cache_query_page WHERE repository_id = ? AND scope = 'commits'").get(id)).toEqual({ n: 0 });
  });

  it.each(['apply', 'confirm'] as const)('恢复观察持久交接%s失败时不重试、不误确认；重放后可同步', async failure => {
    const { h, data, id, completeAt } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    const originalApply = h.repositoryDetail.applyObservation;
    const originalConfirm = h.repositoryList.confirmObservationHandoff;
    if (failure === 'apply') h.repositoryDetail.applyObservation = () => { throw new Error('交接应用中断'); };
    else h.repositoryList.confirmObservationHandoff = () => { throw new Error('交接确认中断'); };
    const original = h.github.fetchScope.bind(h.github); let overviews = 0;
    h.github.fetchScope = async (token, request) => { if (request.scope === 'overview') overviews++; return original(token, request); };
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.error?.message).toContain('新源观察尚未完成交接');
    expect(result.detailFetchedAt).toBe(completeAt);
    expect(result.detail!.commits[0]!.sha).toBe('sha-a');
    expect(result.syncState!.commits!.syncedRevision).toBe(0);
    expect(h.repositoryList.pendingObservations()).toHaveLength(1);
    expect(overviews).toBe(1);
    h.repositoryDetail.applyObservation = originalApply;
    h.repositoryList.confirmObservationHandoff = originalConfirm;
    const recovered = await h.facade.refreshRepository!(id, true);
    expect(recovered.error).toBeNull();
    expect(recovered.detail!.commits[0]!.sha).toBe('sha-b');
    expect(recovered.syncState!.commits).toMatchObject({ detectedRevision: 1, syncedRevision: 1 });
    expect(h.repositoryList.pendingObservations()).toEqual([]);
  });

  it('第二轮按B抓取期间收到C观察，只确认B序号并保留C变化待同步', async () => {
    const { h, data, id, completeAt } = await ready();
    data.observation!.head = 'sha-b'; data.commits[0]!.sha = 'sha-b';
    const original = h.github.fetchScope.bind(h.github); let overviews = 0;
    h.github.fetchScope = async (token, request) => {
      if (request.scope === 'overview') overviews++;
      const outcome = await original(token, request);
      if (request.scope === 'commits' && request.targetVersion?.headRevision === 'sha-b') {
        data.observation!.head = 'sha-c'; data.commits[0]!.sha = 'sha-c';
        h.clock.advanceMs(60_000);
        await h.facade.refreshGlance();
      }
      return outcome;
    };
    const result = await h.facade.refreshRepository!(id, true);
    expect(result.detail!.commits[0]!.sha).toBe('sha-b');
    expect(result.detailFetchedAt).toBe(completeAt);
    expect(h.repositoryList.findReference(id)?.contentVersion?.headRevision).toBe('sha-c');
    expect(result.syncState!.overview).toMatchObject({ detectedRevision: 2, syncedRevision: 1 });
    expect(result.syncState!.commits).toMatchObject({ detectedRevision: 2, syncedRevision: 1 });
    expect(result.error).not.toBeNull();
    expect(overviews).toBe(2);
  });
});
