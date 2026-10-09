import { describe, expect, it } from 'vitest';
import { createGitHubDetailAdapter } from '../../../src/main/core/adapters/github-detail-adapter';
import { createGitHubRepositoryAdapter } from '../../../src/main/core/adapters/github-repository-adapter';
import { createGitHubHttpClient } from '../../../src/main/core/adapters/github-http-client';
import type { ScopeFetchRequest } from '../../../src/domain/ports';

const request: ScopeFetchRequest = { fullName: 'octo/demo', scope: 'issuesAndPr', defaultBranch: 'main', cursor: null, limit: 30, accessContextRevision: 1, observedAt: '2026-10-08T00:00:00Z' };
const meta = { full_name: 'octo/demo', default_branch: 'main', stargazers_count: 1, forks_count: 0, open_issues_count: 0 };
function fixture(handler: (path: string) => { body: unknown; status?: number }) {
  const calls: string[] = [];
  const fetcher = (async (input: unknown) => {
    const url = new URL(String(input)); const path = url.pathname + url.search; calls.push(path);
    const reply = handler(path); return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  const client = createGitHubHttpClient(fetcher);
  return { calls, adapter: { ...createGitHubRepositoryAdapter(client), ...createGitHubDetailAdapter(client) } };
}

describe('权威能力信息与禁用来源终态', () => {
  it.each([false, true, undefined, 'false'])('只将仓库布尔值%s映射为可信能力', async value => {
    const f = fixture(path => ({ body: path === '/repos/octo/demo' ? { ...meta, has_issues: value, has_pull_requests: value } : path.includes('/git/ref/') ? { object: { sha: 'A' } } : [] }));
    const outcome = await f.adapter.fetchScope('fake', { ...request, scope: 'overview' });
    const availability = value === false ? 'disabled' : value === true ? 'enabled' : 'unknown';
    expect(outcome.items[0]).toMatchObject({ metadata: { capabilities: { issues: availability, pullRequests: availability } } });
  });

  it('双禁用来源0次HTTP完成，终态parts和指纹可验证', async () => {
    const capabilities = { issues: 'disabled', pullRequests: 'disabled' } as const;
    const f = fixture(() => ({ body: { ...meta, has_issues: false, has_pull_requests: false } }));
    const fetched = await f.adapter.fetchScope('fake', { ...request, capabilities });
    expect(f.calls).toEqual([]);
    expect(fetched).toMatchObject({ coverageComplete: true, hasMore: false, items: [], parts: { issues: { availability: 'disabled', ok: true, coverageComplete: true }, pullRequests: { availability: 'disabled', ok: true, coverageComplete: true } } });
    const checked = await f.adapter.verifyScopes('fake', { ...request, capabilities, mode: 'reread', maxPages: 3, checkedAt: request.observedAt, baselineFingerprint: fetched.fingerprint ?? null });
    expect(checked).toMatchObject({ checkComplete: true, changed: false });
    expect(f.calls).toEqual(['/repos/octo/demo']);
  });

  it('PR禁用而Issue有效时只请求Issue；失败只影响仍启用来源', async () => {
    const capabilities = { issues: 'enabled', pullRequests: 'disabled' } as const;
    for (const status of [200, 403, 404]) {
      const f = fixture(() => ({ body: [], status }));
      const fetched = await f.adapter.fetchScope('fake', { ...request, capabilities });
      expect(f.calls).toHaveLength(1); expect(f.calls[0]).toContain('/issues?');
      expect(fetched.parts?.pullRequests).toMatchObject({ ok: true, availability: 'disabled', coverageComplete: true });
      expect(fetched.coverageComplete).toBe(status === 200);
      expect(fetched.parts?.issues?.ok).toBe(status === 200);
    }
  });

  it.each([403, 404])('未知PR权限%s仍保留失败和重试游标', async status => {
    const f = fixture(path => path.includes('/pulls?') ? { body: {}, status } : { body: [] });
    const fetched = await f.adapter.fetchScope('fake', request);
    expect(fetched.coverageComplete).toBe(false);
    expect(fetched.parts?.pullRequests).toMatchObject({ ok: false, availability: 'unknown' });
    expect(fetched.nextCursor).not.toBeNull(); expect(fetched.errors?.[0]?.kind).toBe('not_found');
  });

  it('持久禁用能力复开后发现变化，不能永远跳过来源', async () => {
    const capabilities = { issues: 'disabled', pullRequests: 'disabled' } as const;
    const f = fixture(() => ({ body: { ...meta, has_issues: true, has_pull_requests: true } }));
    const fetched = await f.adapter.fetchScope('fake', { ...request, capabilities });
    const checked = await f.adapter.verifyScopes('fake', { ...request, capabilities, mode: 'reread', maxPages: 3, checkedAt: request.observedAt, baselineFingerprint: fetched.fingerprint ?? null });
    expect(checked).toMatchObject({ changed: true, checkComplete: false });
  });

  it('双禁用summary不发协作请求，单Issue禁用从PR检查活动', async () => {
    for (const pullsEnabled of [false, true]) {
      const f = fixture(path => ({ body: path === '/repos/octo/demo' ? { ...meta, has_issues: false, has_pull_requests: pullsEnabled } : path.includes('/git/ref/') ? { object: { sha: 'A' } } : path.includes('/releases/latest') ? { tag_name: 'v1' } : [] }));
      const observed = await f.adapter.observeSummary('fake', 'octo/demo', request.observedAt, 1);
      expect(observed.errors).toBeUndefined();
      expect(f.calls.some(path => path.includes('/issues?'))).toBe(false);
      expect(f.calls.some(path => path.includes('/pulls?'))).toBe(pullsEnabled);
      expect(f.calls.filter(path => path === '/repos/octo/demo')).toHaveLength(1);
    }
  });

  it('提交和README请求绑定目标SHA，提交返回实际首条SHA而非冒充目标', async () => {
    const f = fixture(path => ({ body: path.includes('/commits?') ? [{ sha: 'actual-A', commit: { message: 'message' } }] : [{ type: 'file', name: 'README.md', path: 'README.md', sha: 'blob' }] }));
    const commits = await f.adapter.fetchScope('fake', { ...request, scope: 'commits', targetVersion: { headRevision: 'target-B' } });
    const readme = await f.adapter.fetchScope('fake', { ...request, scope: 'readme', targetVersion: { headRevision: 'target-B' } });
    expect(f.calls[0]).toContain('&sha=target-B'); expect(commits.version?.headRevision).toBe('actual-A');
    expect(f.calls[1]).toContain('?ref=target-B'); expect(readme.version?.headRevision).toBe('target-B');
    expect(readme.items).toEqual([{ language: 'md', content: 'README.md' }]); expect(f.calls).toHaveLength(2);
  });

  it('已捕获稳定发版目标不能被列表首条预发布冒充，续窗口只查询一次latest', async () => {
    const f = fixture(path => ({ body: path.includes('/releases/latest') ? { tag_name: 'stable', name: 'Stable' } : path.includes('/releases?')
      ? [{ tag_name: 'preview', name: 'Preview', prerelease: true }, { tag_name: 'stable', name: 'Stable' }] : [{ name: 'tag', commit: { sha: 'tag-sha' } }] }));
    const nextRequest = { ...request, scope: 'releases' as const, limit: 2, targetVersion: { releaseRevision: JSON.stringify(['stable', 'Stable', null]) } };
    const first = await f.adapter.fetchScope('fake', nextRequest);
    expect(first.version?.releaseRevision).toBe(JSON.stringify(['stable', 'Stable', null]));
    expect(first.items).toEqual([{ kind: 'release', tagName: 'preview', title: 'Preview', publishedAt: null }, { kind: 'release', tagName: 'stable', title: 'Stable', publishedAt: null }]);
    const second = await f.adapter.fetchScope('fake', { ...nextRequest, cursor: first.nextCursor });
    expect(second.items[0]).toMatchObject({ kind: 'tag', name: 'tag' });
    expect(f.calls.filter(path => path.includes('/releases/latest'))).toHaveLength(1);
    expect(f.calls).toHaveLength(5);
  });

  it('latest失败保留成功tags而不提供受影响来源覆盖与源版本', async () => {
    const f = fixture(path => path.includes('/releases/latest') ? { body: {}, status: 500 }
      : { body: path.includes('/releases?') ? [] : [{ name: 'tag', commit: { sha: 'tag-sha' } }] });
    const outcome = await f.adapter.fetchScope('fake', { ...request, scope: 'releases', targetVersion: { releaseRevision: null } });
    expect(outcome.items).toEqual([{ kind: 'tag', name: 'tag', committedAt: null }]);
    expect(outcome.parts?.tags).toMatchObject({ ok: true, coverageComplete: true });
    expect(outcome.parts?.releases?.coverageComplete).toBe(false);
    expect(outcome.coverageComplete).toBe(false);
    expect(outcome.version).toEqual({ tagRevision: JSON.stringify(['tag', 'tag-sha']) }); expect(outcome.fingerprint).toBeUndefined();
    expect(f.calls).toHaveLength(3);
  });

  it('latest已B而列表仍A时交付实际取得的B，不能只借用B版本冒充旧列表', async () => {
    const f = fixture(path => ({ body: path.includes('/releases/latest') ? { tag_name: 'B' } : path.includes('/releases?') ? [{ tag_name: 'A' }] : [{ name: 'tag', commit: { sha: 'tag-sha' } }] }));
    const outcome = await f.adapter.fetchScope('fake', { ...request, scope: 'releases', targetVersion: { releaseRevision: JSON.stringify(['B', 'B', null]) } });
    expect(outcome).toMatchObject({ coverageComplete: true, parts: { releases: { ok: true, coverageComplete: true }, tags: { ok: true, coverageComplete: true } } });
    expect(outcome.items).toContainEqual({ kind: 'release', tagName: 'B', title: 'B', publishedAt: null });
    expect(outcome.version).toEqual({ releaseRevision: JSON.stringify(['B', 'B', null]), tagRevision: JSON.stringify(['tag', 'tag-sha']) });
    expect(outcome.fingerprint).toBeTypeOf('string'); expect(f.calls).toHaveLength(3);
  });

  it('51+预发布挤出stable时从已取得latest交付，按limit续窗且不重复latest', async () => {
    const previews = Array.from({ length: 50 }, (_, index) => ({ tag_name: 'preview-' + index, prerelease: true }));
    const f = fixture(path => ({ body: path.includes('/releases/latest') ? { tag_name: 'stable-old' } : path.includes('/releases?') ? previews : [] }));
    const req = { ...request, scope: 'releases' as const, limit: 50, targetVersion: { releaseRevision: JSON.stringify(['stable-old', 'stable-old', null]) } };
    const first = await f.adapter.fetchScope('fake', req);
    expect(first.items).toHaveLength(50); expect(first.coverageComplete).toBe(false);
    expect(first.items[0]).toMatchObject({ kind: 'release', tagName: 'stable-old' });
    const second = await f.adapter.fetchScope('fake', { ...req, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1); expect(second.coverageComplete).toBe(true);
    expect(f.calls.filter(path => path.includes('/releases/latest'))).toHaveLength(1);
    expect(f.calls).toHaveLength(5);
  });
});
