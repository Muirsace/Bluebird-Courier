import { expect, it } from 'vitest';
import { createGitHubDetailAdapter } from '../../src/main/core/adapters/github-detail-adapter';
import { createGitHubHttpClient } from '../../src/main/core/adapters/github-http-client';
import { createHarness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';

it.each([true, false])('真实协议适配器的当前概览与旧SHA冲突后，将提交和README绑定新SHA：已有缓存=%s', async hasCache => {
  let head = 'sha-a';
  const requests: URL[] = [];
  const adapter = createGitHubDetailAdapter(createGitHubHttpClient((async input => {
    const url = new URL(String(input)); requests.push(url);
    const path = url.pathname.replace('/repos/octo-demo/hello-world', '');
    let body: unknown = []; let status = 200;
    if (path === '') body = { full_name: 'octo-demo/hello-world', default_branch: 'main', has_issues: true, has_pull_requests: true,
      stargazers_count: 1, forks_count: 1, open_issues_count: 0 };
    else if (path.startsWith('/git/ref/heads/')) body = { object: { sha: head } };
    else if (path === '/releases/latest') { body = {}; status = 404; }
    else if (path === '/commits') {
      const sha = url.searchParams.get('sha') ?? head;
      body = [{ sha, commit: { message: sha, author: { name: 'author', date: '2026-09-25T08:30:00Z' } } }];
    } else if (path === '/contents') body = [{ type: 'file', name: 'README.md', path: 'README.md', sha: 'readme-' + url.searchParams.get('ref') }];
    else if (path === '/actions/runs') body = { workflow_runs: [] };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch));
  const h = createHarness({ scopePorts: adapter });
  try {
    await h.facade.saveAccessToken('ghp_valid_token');
    const data = h.github.addRepo(makeRepoData({ latestRelease: null, releases: [], observation: { head, release: null, tag: null } }));
    const id = (await h.facade.addRepository(data.meta.fullName)).repository!.id;
    await h.facade.refreshGlance();
    if (hasCache) expect((await h.facade.fetchDetail(id)).error).toBeNull();
    h.clock.advanceMs(60_000); head = 'sha-b'; data.observation!.head = head; data.commits[0]!.sha = head;
    requests.length = 0;
    const result = hasCache ? await h.facade.refreshRepository!(id, true) : await h.facade.fetchDetail(id);
    expect(result.error).toBeNull();
    expect(result.detail!.commits[0]!.sha).toBe(head);
    expect(result.syncState!.commits).toMatchObject({ detectedRevision: 1, syncedRevision: 1 });
    expect(result.syncState!.readme).toMatchObject({ detectedRevision: 1, syncedRevision: 1 });
    expect(requests.filter(url => url.pathname.endsWith('/commits')).map(url => url.searchParams.get('sha'))).toEqual(['sha-a', 'sha-b']);
    expect(requests.filter(url => url.pathname.endsWith('/contents')).map(url => url.searchParams.get('ref'))).toEqual(['sha-a', 'sha-b']);
  } finally { h.destroy(); }
});
