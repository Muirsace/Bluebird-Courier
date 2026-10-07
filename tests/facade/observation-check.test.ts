import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures, makeRepoData } from '../helpers/fake-github';

let harness: Harness | undefined;
afterEach(() => { harness?.destroy(); harness = undefined; });

async function ready(): Promise<Harness> {
  const h = harness = createHarness();
  await h.facade.saveAccessToken('ghp_valid_token');
  h.github.addRepo(makeRepoData({ observation: { head: 'head-a', release: 'release-a', tag: 'tag-a',
    collaborationAt: '2026-09-25T09:00:00.000Z' } }));
  expect((await h.facade.addRepository('octo-demo/hello-world')).ok).toBe(true);
  return h;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('清单观察审查回归', () => {
  it('启动意图在主进程生命周期内只检查一次；手动可重查，重启可重新启动检查', async () => {
    const h = await ready();
    h.github.resetCalls();
    await h.facade.refreshGlance('startup');
    h.github.repos.get('octo-demo/hello-world')!.meta.stars = 9999;
    expect((await h.facade.refreshGlance('startup')).skipped).toBe(true);
    expect(h.github.count('observeSummary')).toBe(1);
    expect((await h.facade.listRepositories())[0]!.stars).toBe(1284);
    await h.facade.refreshGlance('manual');
    expect(h.github.count('observeSummary')).toBe(2);
    expect((await h.facade.listRepositories())[0]!.stars).toBe(9999);
    h.reopen();
    await h.facade.refreshGlance('startup');
    expect(h.github.count('observeSummary')).toBe(3);
  });

  it.each(['success', 'failure'] as const)('旧上下文延迟返回 %s 均不覆盖新摘要、错误、观察或快照', async outcome => {
    const h = await ready();
    await h.facade.refreshGlance();
    const original = h.github.observeSummary.bind(h.github);
    const started = deferred(); const release = deferred();
    h.github.observeSummary = async (...args) => {
      const captured = await original(...args);
      if (args[3] === 0) {
        started.resolve(); await release.promise;
        if (outcome === 'failure') throw fixtures.unauthorized();
      }
      return captured;
    };
    const old = h.facade.refreshGlance();
    await started.promise;
    h.tokenSettings.advanceAccessContext(h.clock.now().toISOString());
    const data = h.github.repos.get('octo-demo/hello-world')!;
    data.meta.stars = 5000; data.observation!.head = 'new-context-head';
    h.clock.advanceMs(60_000);
    await h.facade.refreshGlance();
    release.resolve();
    expect((await old).errors).toEqual([]);
    const row = h.db.prepare('SELECT stars, access_context_revision, last_error_kind, observation_json FROM repository').get() as Record<string, unknown>;
    expect(row).toMatchObject({ stars: 5000, access_context_revision: 1, last_error_kind: null });
    expect(JSON.parse(row.observation_json as string).signals.headRevision.value).toBe('new-context-head');
    expect(h.repositoryList.pendingObservations()).toEqual([]);
    expect(h.db.prepare('SELECT stars FROM snapshot').get()).toMatchObject({ stars: 5000 });
  });

  it('删除仓库后在途成功观察不重建摘要或快照', async () => {
    const h = await ready();
    const original = h.github.observeSummary.bind(h.github);
    const started = deferred(); const release = deferred();
    h.github.observeSummary = async (...args) => { const result = await original(...args); started.resolve(); await release.promise; return result; };
    const checking = h.facade.refreshGlance();
    await started.promise;
    await h.facade.removeRepository((await h.facade.listRepositories())[0]!.id);
    release.resolve(); await checking;
    expect(await h.facade.listRepositories()).toEqual([]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 0 });
    expect(h.repositoryList.pendingObservations()).toEqual([]);
  });

  it('批次期间上下文变化阻止旧上下文的后续仓库与趋势写入', async () => {
    const h = await ready();
    h.github.addRepo(makeRepoData({ meta: { ...makeRepoData().meta, fullName: 'acme/second', pushedAt: '2026-09-10T00:00:00.000Z' } }));
    await h.facade.addRepository('acme/second');
    h.github.repos.get('octo-demo/hello-world')!.meta.stars = 2000;
    const original = h.github.observeSummary.bind(h.github);
    const second = deferred(); const release = deferred();
    h.github.observeSummary = async (...args) => {
      const result = await original(...args);
      if (args[1] === 'acme/second') { second.resolve(); await release.promise; }
      return result;
    };
    const checking = h.facade.refreshGlance();
    await second.promise;
    h.tokenSettings.advanceAccessContext(h.clock.now().toISOString());
    release.resolve(); await checking;
    const repo = h.repositoryList.findByFullName('octo-demo/hello-world')!;
    expect(repo.stars).toBe(2000);
    expect(h.db.prepare('SELECT stars FROM snapshot WHERE repository_id = ?').get(repo.id)).toMatchObject({ stars: 1284 });
  });

  it('Release/Tag unknown 保留各自成功摘要和检查时间，known-null 可清除标签', async () => {
    const h = await ready();
    await h.facade.refreshGlance();
    const checkedAt = h.clock.now().toISOString();
    const data = h.github.repos.get('octo-demo/hello-world')!;
    data.latestRelease = null; data.observation = { head: 'head-a', unknown: ['release', 'tag'] };
    data.meta.stars = 3000; h.clock.advanceMs(60_000);
    await h.facade.refreshGlance();
    expect((await h.facade.listRepositories())[0]).toMatchObject({ stars: 3000, latestReleaseTag: 'v2.4.0', latestTag: 'tag-a' });
    const row = h.db.prepare('SELECT observation_json FROM repository').get() as { observation_json: string };
    expect(JSON.parse(row.observation_json).signals.releaseRevision.checkedAt).toBe(checkedAt);
    data.observation = { head: 'head-a', release: null, tag: null };
    await h.facade.refreshGlance();
    expect((await h.facade.listRepositories())[0]).toMatchObject({ latestReleaseTag: null, latestTag: null });
  });

  it('旧摘要首次观察的 unknown 不清空旧发版，也不将旧值冒充检查基线', async () => {
    const h = await ready();
    const data = h.github.repos.get('octo-demo/hello-world')!;
    data.latestRelease = null; data.observation = { unknown: ['release', 'tag'] };
    await h.facade.refreshGlance();
    expect((await h.facade.listRepositories())[0]!.latestReleaseTag).toBe('v2.4.0');
    const row = h.db.prepare('SELECT observation_json FROM repository').get() as { observation_json: string };
    expect(JSON.parse(row.observation_json).signals.releaseRevision.state).toBe('unknown');
  });

  it('默认分支 HEAD 未变的推送与协作普通更新时间不刷新活动；展示字段变化才更新', async () => {
    const h = await ready();
    await h.facade.refreshGlance();
    const data = h.github.repos.get('octo-demo/hello-world')!;
    data.meta.pushedAt = '2026-09-26T03:30:00.000Z';
    data.observation!.collaborationAt = '2026-09-26T03:00:00.000Z';
    data.observation!.collaborationCreatedAt = '2026-09-25T09:00:00.000Z';
    for (let i = 0; i < 2; i++) {
      await h.facade.refreshGlance();
      expect((await h.facade.listRepositories())[0]).toMatchObject({ activityAt: '2026-09-25T09:00:00.000Z', activityKind: 'issue' });
    }
    const stored = h.db.prepare('SELECT observation_json FROM repository').get() as { observation_json: string };
    expect(JSON.parse(stored.observation_json).activity.collaboration).toMatchObject({
      at: '2026-09-26T03:00:00.000Z', importantAt: '2026-09-25T09:00:00.000Z',
    });
    data.observation!.collaborationRevision = 'edited-title';
    await h.facade.refreshGlance();
    expect((await h.facade.listRepositories())[0]).toMatchObject({ activityAt: '2026-09-26T03:00:00.000Z', activityKind: 'issue' });
  });

  it('未来推送被拒绝后不会由读库回退复活；成功的无活动仓库按正常排序置后', async () => {
    const h = await ready();
    const data = h.github.repos.get('octo-demo/hello-world')!;
    data.meta.pushedAt = '2099-01-01T00:00:00.000Z'; data.latestRelease = null; data.observation = { head: 'head-a' };
    await h.facade.refreshGlance();
    h.github.addRepo(makeRepoData({ meta: { ...makeRepoData().meta, fullName: 'acme/active' } }));
    await h.facade.addRepository('acme/active');
    h.reopen();
    const listed = await h.facade.listRepositories();
    expect(listed.map(x => x.fullName)).toEqual(['acme/active', 'octo-demo/hello-world']);
    expect(listed[1]).toMatchObject({ activityAt: null, activityKind: null });
  });

  it.each(['access_token_invalid', 'rate_limited'] as const)('单信号 %s 仍保存成功摘要并停止后续仓库', async kind => {
    const h = await ready();
    h.github.addRepo(makeRepoData({ meta: { ...makeRepoData().meta, fullName: 'acme/second', pushedAt: '2026-09-10T00:00:00.000Z' } }));
    await h.facade.addRepository('acme/second');
    const data = h.github.repos.get('octo-demo/hello-world')!;
    data.meta.stars = 2222; data.observation!.errors = [{ kind, message: '单信号检查失败' }];
    h.github.resetCalls();
    const result = await h.facade.refreshGlance();
    expect(result.stopped).toBe(true); expect(result.stopReason).toBe(kind);
    expect(h.github.count('observeSummary')).toBe(1);
    expect(h.repositoryList.findByFullName('octo-demo/hello-world')!.stars).toBe(2222);
  });

  it('观察快照结构损坏按无基线重建，规范仓库名称仍随成功观察更新', async () => {
    const h = await ready();
    h.db.prepare("UPDATE repository SET observation_json = '{}' ").run();
    h.github.repos.get('octo-demo/hello-world')!.meta.fullName = 'acme/renamed';
    const result = await h.facade.refreshGlance();
    expect(result.errors).toEqual([]);
    expect(result.repositories[0]).toMatchObject({ owner: 'acme', name: 'renamed', fullName: 'acme/renamed' });
    expect(h.repositoryList.pendingObservations()).toEqual([]);
  });
});
