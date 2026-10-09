import { describe, expect, it } from 'vitest';
import type { ScopeVerifyRequest } from '../../../src/domain/ports';
import { createGitHubHttpClient } from '../../../src/main/core/adapters/github-http-client';
import { createGitHubDetailAdapter } from '../../../src/main/core/adapters/github-detail-adapter';

const tuple = (id: number) => [String(id), 1, 'in_progress', null, 'ci', 'https://example.test/' + id, '2026-10-08T00:00:00Z'];
const run = (id: number) => ({ id, run_attempt: 1, status: 'in_progress', conclusion: null, name: 'ci', html_url: 'https://example.test/' + id, updated_at: '2026-10-08T00:00:00Z' });
function fixture(handler: (path: string) => { body: unknown; status?: number }) {
  const calls: string[] = [];
  const fetcher = (async (input: unknown) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search;
    calls.push(path);
    const reply = handler(path);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, recreate: () => createGitHubDetailAdapter(createGitHubHttpClient(fetcher)) };
}
const request = (tracked = [1, 2, 3, 4, 5]): ScopeVerifyRequest => ({ fullName: 'octo/demo', scope: 'builds', defaultBranch: 'main', accessContextRevision: 1,
  checkedAt: '2026-10-08T01:00:00Z', mode: 'reread', maxPages: 3, baselineFingerprint: JSON.stringify({ v: 2, windowSize: 30, recent: [], tracked: tracked.map(tuple) }) });

describe('构建公平续扫与展示指纹', () => {
  it('服务重建后接续全部已知未完成运行，每轮最多3次HTTP，未完成不更新基线', async () => {
    const f = fixture(path => ({ body: path.includes('?') ? { workflow_runs: [] } : run(Number(path.split('/').at(-1))) }));
    let next = request();
    for (let round = 0; round < 3; round += 1) {
      const before = f.calls.length;
      const result = await f.recreate().verifyScopes('fake', next);
      expect(f.calls.length - before).toBeLessThanOrEqual(3);
      expect(result.checkComplete).toBe(round === 2);
      if (round < 2) { expect(result.fingerprint).toBeUndefined(); expect(result.verificationProgress).toBeTypeOf('string'); }
      else expect(result.verificationProgress).toBeNull();
      next = { ...next, verificationProgress: result.verificationProgress ?? undefined };
    }
    for (const id of [1, 2, 3, 4, 5]) expect(f.calls.filter(path => path.endsWith('/' + id))).toHaveLength(1);
  });

  it('失败项轮转到尾部，后排完成仍被发现，失败项不丢失', async () => {
    let failed = true;
    const f = fixture(path => path.includes('?') ? { body: { workflow_runs: [] } } : path.endsWith('/1') && failed
      ? { body: {}, status: 500 } : { body: path.endsWith('/3') ? { ...run(3), status: 'completed', conclusion: 'success' } : run(Number(path.split('/').at(-1))) });
    const first = await f.recreate().verifyScopes('fake', request([1, 2, 3]));
    expect(first.checkComplete).toBe(false);
    expect(first.error).toBeDefined();
    const second = await f.recreate().verifyScopes('fake', { ...request([1, 2, 3]), verificationProgress: first.verificationProgress ?? undefined });
    expect(second.changed).toBe(true);
    expect(second.checkComplete).toBe(false);
    failed = false;
    const third = await f.recreate().verifyScopes('fake', { ...request([1, 2, 3]), verificationProgress: second.verificationProgress ?? undefined });
    expect(third).toMatchObject({ changed: true, checkComplete: true });
    expect(third.verificationProgress).toBeTypeOf('string');
    expect(third.fingerprint).toBeUndefined();
  });

  it.each(['fullName', 'defaultBranch', 'accessContextRevision', 'baselineFingerprint'] as const)('%s变化后旧进度不能跳过前排', async field => {
    const f = fixture(path => ({ body: path.includes('?') ? { workflow_runs: [] } : run(Number(path.split('/').at(-1))) }));
    const first = await f.recreate().verifyScopes('fake', request());
    const next = { ...request(), verificationProgress: first.verificationProgress ?? undefined,
      [field]: field === 'fullName' ? 'octo/other' : field === 'defaultBranch' ? 'dev' : field === 'accessContextRevision' ? 2 : request().baselineFingerprint + ' ' };
    const before = f.calls.length;
    await f.recreate().verifyScopes('fake', next);
    expect(f.calls.slice(before).some(path => path.endsWith('/1'))).toBe(true);
  });

  it.each(['name', 'html_url', 'updated_at', 'run_attempt'] as const)('展示或重跑字段%s变化可被发现', async field => {
    let changed = false;
    const f = fixture(() => ({ body: { workflow_runs: [{ ...run(1), status: 'completed', conclusion: 'success', ...(changed ? { [field]: field === 'run_attempt' ? 2 : 'changed' } : {}) }] } }));
    const fetched = await f.recreate().fetchScope('fake', { fullName: 'octo/demo', scope: 'builds', defaultBranch: 'main', cursor: null, limit: 30, accessContextRevision: 1, observedAt: '2026-10-08T01:00:00Z' });
    changed = true;
    expect(await f.recreate().verifyScopes('fake', { ...request([]), baselineFingerprint: fetched.fingerprint ?? null })).toMatchObject({ changed: true, checkComplete: true });
  });

  it('旧四元组不能把未核验展示字段宣告无变化', async () => {
    const f = fixture(() => ({ body: { workflow_runs: [{ ...run(1), status: 'completed', conclusion: 'success' }] } }));
    expect(await f.recreate().verifyScopes('fake', { ...request([]), baselineFingerprint: JSON.stringify({ v: 1, windowSize: 30, recent: [['1', 1, 'completed', 'success']], tracked: [] }) })).toMatchObject({ changed: true, checkComplete: true });
  });

  it('近期列表失败也保存续扫进度而不删除已有证据', async () => {
    let recentFailed = false;
    const f = fixture(path => path.includes('?') ? { body: { workflow_runs: [] }, status: recentFailed ? 500 : 200 } : { body: run(Number(path.split('/').at(-1))) });
    const first = await f.recreate().verifyScopes('fake', request());
    recentFailed = true;
    const second = await f.recreate().verifyScopes('fake', { ...request(), verificationProgress: first.verificationProgress ?? undefined });
    expect(second.checkComplete).toBe(false);
    expect(second.verificationProgress).toBe(first.verificationProgress);
  });

  it('验证后继抓取展示离近期页的完成运行，并保留其他未完成追踪', async () => {
    const f = fixture(path => ({ body: path.includes('?') ? { workflow_runs: [] } : path.endsWith('/3')
      ? { ...run(3), status: 'completed', conclusion: 'failure' } : run(Number(path.split('/').at(-1))) }));
    const base = request([1, 2, 3]);
    const first = await f.recreate().verifyScopes('fake', base);
    const second = await f.recreate().verifyScopes('fake', { ...base, verificationProgress: first.verificationProgress ?? undefined });
    expect(second).toMatchObject({ changed: true, checkComplete: true });
    const before = f.calls.length;
    const fetched = await f.recreate().fetchScope('fake', { fullName: base.fullName, scope: 'builds', defaultBranch: base.defaultBranch, accessContextRevision: 1,
      cursor: null, limit: 30, observedAt: base.checkedAt, baselineFingerprint: base.baselineFingerprint, verificationProgress: second.verificationProgress ?? undefined });
    expect(f.calls.length - before).toBe(1);
    expect(fetched.coverageComplete).toBe(true);
    expect(fetched.items).toContainEqual(expect.objectContaining({ id: '3', status: 'failure', workflowName: 'ci' }));
    expect(JSON.parse(fetched.fingerprint ?? '{}').tracked.map((tuple: unknown[]) => tuple[0])).toEqual(['1', '2']);
  });

  it('无有效验证进度时有界补读，未完成不交付/不推进指纹，续扫可完成', async () => {
    const f = fixture(path => ({ body: path.includes('?') ? { workflow_runs: [] } : run(Number(path.split('/').at(-1))) }));
    let next = { fullName: 'octo/demo', scope: 'builds' as const, defaultBranch: 'main', accessContextRevision: 1, cursor: null as string | null,
      limit: 30, observedAt: '2026-10-08T01:00:00Z', baselineFingerprint: request().baselineFingerprint };
    for (let round = 0; round < 3; round += 1) {
      const before = f.calls.length;
      const fetched = await f.recreate().fetchScope('fake', next);
      expect(f.calls.length - before).toBeLessThanOrEqual(3);
      expect(fetched.coverageComplete).toBe(round === 2);
      if (round < 2) { expect(fetched.items).toEqual([]); expect(fetched.fingerprint).toBeUndefined(); }
      else expect(fetched.items).toHaveLength(5);
      next = { ...next, cursor: fetched.nextCursor };
    }
    for (const id of [1, 2, 3, 4, 5]) expect(f.calls.filter(path => path.endsWith('/' + id))).toHaveLength(1);
  });

  it('近期页加离窗交付不突破limit，最终仍保留完整追踪指纹', async () => {
    const f = fixture(path => ({ body: path.includes('?') ? { workflow_runs: [run(9), run(8)] } : run(Number(path.split('/').at(-1))) }));
    const req = { fullName: 'octo/demo', scope: 'builds' as const, defaultBranch: 'main', accessContextRevision: 1, cursor: null as string | null,
      limit: 2, observedAt: '2026-10-08T01:00:00Z', baselineFingerprint: request([1, 2, 3]).baselineFingerprint };
    const delivered: unknown[] = []; let cursor: string | null = null;
    for (let batch = 0; batch < 4; batch += 1) {
      const result = await f.recreate().fetchScope('fake', { ...req, cursor });
      expect(result.items.length).toBeLessThanOrEqual(2); delivered.push(...result.items);
      if (result.coverageComplete) break;
      cursor = result.nextCursor;
    }
    expect(delivered.map(item => (item as { id: string }).id)).toEqual(['9', '8', '1', '2', '3']);
  });

  it.each([
    null, ['bad-id', 1, 'in_progress', null], ['1', -1, 'in_progress', null], ['1', {}, 'in_progress', null],
    ['1', 1, 'invalid-status', null], ['1', 1, 'in_progress', {}], ['1', 1, 'completed', 'invalid-result'],
    ['1', 1, 'in_progress', null, {}, null, null], ['1', 1, 'in_progress', null, null, null, []],
  ])('损坏基线字段%j安全重采且不能宣称检查完整', async badTuple => {
    const f = fixture(() => ({ body: { workflow_runs: [] } }));
    for (const field of ['recent', 'tracked']) {
      const malformed = JSON.stringify({ v: 2, windowSize: 30, recent: [], tracked: [], [field]: [badTuple] });
      const result = await f.recreate().verifyScopes('fake', { ...request(), baselineFingerprint: malformed });
      expect(result).toMatchObject({ checkComplete: false, verificationProgress: null });
    }
  });

  it.each(['observed-fields', 'observed-id', 'pending-field', 'pending-id', 'duplicate-conflict', 'identity'] as const)('损坏进度%s不能跳过实际补查', async corruption => {
    const f = fixture(path => ({ body: path.includes('?') ? { workflow_runs: [] } : run(Number(path.split('/').at(-1))) }));
    const first = await f.recreate().verifyScopes('fake', request([1, 2, 3]));
    const progress = JSON.parse(first.verificationProgress!);
    if (corruption === 'observed-fields') progress.observed[0] = ['1', {}, {}, {}, {}, {}, {}];
    if (corruption === 'observed-id') progress.observed[0][0] = '999';
    if (corruption === 'pending-field') progress.pending = [{}];
    if (corruption === 'pending-id') progress.pending = ['999'];
    if (corruption === 'duplicate-conflict') progress.observed.push(['1', 2, 'in_progress', null, 'ci', null, null]);
    if (corruption === 'identity') progress.n = 'octo/other';
    const before = f.calls.length;
    const result = await f.recreate().verifyScopes('fake', { ...request([1, 2, 3]), verificationProgress: JSON.stringify(progress) });
    expect(result.checkComplete).toBe(false);
    expect(f.calls.slice(before).some(path => path.endsWith('/1'))).toBe(true);
    expect(result.fingerprint).toBeUndefined();
  });

  it('抓取拒绝损坏observed，不能把对象字段交付为构建或伪造成功', async () => {
    const f = fixture(path => ({ body: path.includes('?') ? { workflow_runs: [] } : run(Number(path.split('/').at(-1))) }));
    const base = request([1, 2, 3]);
    const checked = await f.recreate().verifyScopes('fake', base);
    const progress = JSON.parse(checked.verificationProgress!);
    progress.observed = progress.observed.map((tuple: unknown[]) => [tuple[0], {}, {}, {}, {}, {}, {}]);
    const before = f.calls.length;
    const result = await f.recreate().fetchScope('fake', { ...base, cursor: null, limit: 30, observedAt: base.checkedAt, verificationProgress: JSON.stringify(progress) });
    expect(result.coverageComplete).toBe(false); expect(result.fingerprint).toBeUndefined();
    expect(f.calls.slice(before).some(path => path.endsWith('/1'))).toBe(true);
  });

  it('合法observed已变化而持久changed误为false时按实际元组重派生变化', async () => {
    const f = fixture(path => ({ body: path.includes('?') ? { workflow_runs: [] } : run(Number(path.split('/').at(-1))) }));
    const base = request([1, 2, 3]);
    const first = await f.recreate().verifyScopes('fake', base);
    const progress = JSON.parse(first.verificationProgress!);
    progress.observed[0][2] = 'completed'; progress.observed[0][3] = 'success'; progress.changed = false;
    const result = await f.recreate().verifyScopes('fake', { ...base, verificationProgress: JSON.stringify(progress) });
    expect(result).toMatchObject({ checkComplete: true, changed: true });
    expect(result.fingerprint).toBeUndefined();
  });
});
