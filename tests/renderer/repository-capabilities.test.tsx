// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeRepoData } from '../helpers/fake-github';
import { createGitHubHttpClient } from '../../src/main/core/adapters/github-http-client';
import { createGitHubDetailAdapter } from '../../src/main/core/adapters/github-detail-adapter';
import { click, createStub, renderApp, repoOpenButton, settle, tab, type RenderResult } from './helpers';
import type { DetailViewSnapshot } from '../../src/renderer/lib/detail-view';

vi.mock('react-chartjs-2', () => import('./chart-stub'));
const NAME = 'octo-demo/hello-world';
let h: Harness | undefined;
let view: RenderResult | undefined;
afterEach(async () => { await view?.unmount(); h?.destroy(); view = undefined; h = undefined; });

async function setup(issuesEnabled: boolean, pullsInitiallyEnabled: boolean) {
  let pullsEnabled = pullsInitiallyEnabled;
  let pullsForbidden = false;
  let pullsCapabilityUnknown = false;
  const calls: string[] = [];
  const port = createGitHubDetailAdapter(createGitHubHttpClient((async input => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const tail = url.pathname.replace('/repos/' + NAME, '');
    let body: unknown = [];
    let status = 200;
    if (tail === '') body = { full_name: NAME, default_branch: 'main', stargazers_count: 1, forks_count: 1, open_issues_count: 0, has_issues: issuesEnabled, has_pull_requests: pullsCapabilityUnknown ? undefined : pullsEnabled };
    else if (tail === '/releases/latest') { body = { message: 'Not Found' }; status = 404; }
    else if (tail.startsWith('/git/ref/heads/')) body = { object: { sha: 'head-1' } };
    else if (tail === '/commits') body = [{ sha: 'head-1', commit: { message: 'first', author: { name: 'octo', date: '2026-09-26T04:00:00Z' } } }];
    else if (tail === '/actions/runs') body = { workflow_runs: [] };
    else if (tail === '/pulls') {
      if (!pullsEnabled) throw new Error('禁用PR不能发请求');
      body = [{ number: 7, title: '重新开启后的PR', state: 'open', updated_at: '2026-09-26T04:00:00Z', body: null, user: { login: 'octo' } }];
      if (pullsForbidden) { body = { message: 'Forbidden' }; status = 403; }
    } else if (tail === '/issues' && !issuesEnabled) throw new Error('禁用Issue不能发请求');
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch));
  h = createHarness({ scopePorts: port });
  await h.facade.saveAccessToken('ghp_valid_token');
  const data = makeRepoData({ latestRelease: null, releases: [], observation: { head: 'head-1' } });
  h.github.addRepo(data);
  const id = (await h.facade.addRepository(NAME)).repository!.id;
  const opened = await h.facade.fetchDetail(id);
  expect(opened.error).toBeNull();
  expect(opened.detailFetchedAt).toEqual(expect.any(String));
  const stub = createStub({ repositories: await h.facade.listRepositories() });
  Object.assign(stub.api, h.facade);
  view = await renderApp(stub);
  await settle();
  await click(repoOpenButton(NAME));
  await settle();
  return { id, calls, enablePulls: () => { pullsEnabled = true; },
    reopenButForbidden: (unknown: boolean) => { pullsEnabled = true; pullsForbidden = true; pullsCapabilityUnknown = unknown; } };
}

it('真实adapter/facade的禁用PR终态展示为未启用，复开后新内容仍可交付', async () => {
  const { id, calls, enablePulls } = await setup(true, false);
  expect(document.body.textContent).toContain('此仓库未启用 Pull Request');
  await click(tab('Issue & PR'));
  await settle();
  expect(document.body.textContent).toContain('此仓库未启用 Pull Request');
  expect(document.body.textContent).not.toContain('仓库不存在或无权访问');
  expect(calls.some(path => path.endsWith('/pulls'))).toBe(false);
  const snapshot = view!.queryClient.getQueryData<DetailViewSnapshot>(['detail', id]);
  expect(snapshot?.windows.issuesAndPr).toBeDefined();
  expect(snapshot?.incomplete?.issuesAndPr).not.toBe(true);

  enablePulls();
  const refetch = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === '重新抓取');
  expect(refetch).toBeDefined();
  await click(refetch!);
  await settle();
  expect(document.body.textContent).toContain('重新开启后的PR');
  expect(document.body.textContent).not.toContain('此仓库未启用 Pull Request');
  expect(calls.some(path => path.endsWith('/pulls'))).toBe(true);
});

it('两侧均禁用不会冒充已确认空列表，已同步仍能显示完整成功时间', async () => {
  const { calls } = await setup(false, false);
  await click(tab('Issue & PR'));
  await settle();
  expect(document.body.textContent).toContain('此仓库未启用 Issue');
  expect(document.body.textContent).toContain('此仓库未启用 Pull Request');
  expect(document.body.textContent).not.toContain('当前没有开放的 Issue 或 Pull Request');
  expect(document.body.textContent).not.toContain('尚未完整同步');
  expect(calls.some(path => path.endsWith('/issues') || path.endsWith('/pulls'))).toBe(false);
});

it.each([false, true])('原PR禁用证据失效且来源403时不再误报未启用，能力未知=%s', async unknown => {
  const { id, reopenButForbidden } = await setup(true, false);
  expect(document.body.textContent).toContain('此仓库未启用 Pull Request');
  reopenButForbidden(unknown);
  const refetch = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === '重新抓取');
  await click(refetch!);
  await settle();
  expect(document.body.textContent).not.toContain('此仓库未启用 Pull Request');
  expect(view!.queryClient.getQueryData<DetailViewSnapshot>(['detail', id])?.columns.pullRequests?.status).toBe('failed');
  expect(document.querySelector('.state-error-bar')).not.toBeNull();
});
