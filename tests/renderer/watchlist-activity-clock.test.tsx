// @vitest-environment happy-dom
// 共享低频时钟：多行共用一个分钟级定时器，tick 只重绘相对时间，不触发 bridge / 网络调用。
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Glance } from '../../src/shared/types';
import type { RenderResult, StubHandle } from './helpers';
import {
  click, createStub, makeGlance, refreshAllButton, renderApp, repoOpenButton,
  settle, setViewportWidth,
} from './helpers';

const NOW = new Date('2026-11-20T04:00:00.000Z').getTime();
const ago = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();
type ActivityKind = NonNullable<Glance['activityKind']>;

const active = (base: Glance, at: string, kind: ActivityKind = 'code'): Glance =>
  ({ ...base, activityAt: at, activityKind: kind });

let stub: StubHandle;
let view: RenderResult | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.setSystemTime(NOW);
  setViewportWidth(1152);
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  setViewportWidth(768);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(repositories: Glance[]): Promise<void> {
  stub = createStub({ repositories });
  view = await renderApp(stub);
  await settle();
}

const activitySpan = (fullName: string): HTMLElement | null =>
  repoOpenButton(fullName)?.querySelector('.repository-sidebar-activity') ?? null;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

describe('清单活动时间 · 共享低频时钟', () => {
  it('相对时间随共享时钟自然更新，tick 不触发 bridge 调用', async () => {
    await mount(Array.from({ length: 3 }, (_, i) => active(makeGlance(i + 1, `owner/repo-${i}`), ago(30_000))));
    expect(activitySpan('owner/repo-0')?.textContent?.trim()).toBe('刚刚');
    expect(activitySpan('owner/repo-2')?.textContent?.trim()).toBe('刚刚');
    const callsBefore = { ...stub.calls };

    await advance(60_000);
    expect(activitySpan('owner/repo-0')?.textContent?.trim()).toBe('1 分钟前');
    await advance(60_000);
    expect(activitySpan('owner/repo-0')?.textContent?.trim()).toBe('2 分钟前');
    expect(activitySpan('owner/repo-2')?.textContent?.trim()).toBe('2 分钟前');
    expect(stub.calls).toEqual(callsBefore);
  });

  it('多行共享一个分钟级定时器；全部卸载后释放，重新挂载重建', async () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const clearSpy = vi.spyOn(window, 'clearInterval');
    await mount(Array.from({ length: 25 }, (_, i) => active(makeGlance(i + 1, `owner/repo-${i}`), ago(60_000))));
    const minuteTimers = intervalSpy.mock.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call[1] === 60_000);
    expect(minuteTimers).toHaveLength(1);
    const timerId = intervalSpy.mock.results[minuteTimers[0]!.index]!.value as number;

    await view!.unmount();
    view = null;
    expect(clearSpy).toHaveBeenCalledWith(timerId);

    await mount(Array.from({ length: 2 }, (_, i) => active(makeGlance(i + 1, `owner/repo-${i}`), ago(60_000))));
    expect(intervalSpy.mock.calls.filter((call) => call[1] === 60_000)).toHaveLength(2);
  });

  it('数字刷新（Stars 变化）不改活动时间，也不伪装刚刚', async () => {
    const base = active(makeGlance(1, 'octocat/Hello-World'), ago(3_600_000));
    await mount([base]);
    expect(activitySpan('octocat/Hello-World')?.textContent?.trim()).toBe('1 小时前');

    const before = { ...stub.calls };
    stub.setRepositories([{ ...base, stars: 9999 }]);
    await click(refreshAllButton());
    await settle();

    // 数字确实刷新了（检查 + 重读清单），但活动时间保持源时间、不伪装刚刚。
    expect(stub.calls.refreshGlance).toBe(before.refreshGlance + 1);
    expect(stub.calls.listRepositories).toBeGreaterThan(before.listRepositories);
    expect(activitySpan('octocat/Hello-World')?.textContent?.trim()).toBe('1 小时前');
    expect(activitySpan('octocat/Hello-World')?.textContent).not.toContain('刚刚');
    expect(refreshAllButton()?.getAttribute('aria-label')).toBe('检查更新');
  });

  it('活动时间相同的行保持主进程返回顺序，刷新后也不跳动', async () => {
    const at = ago(2 * 3_600_000);
    const order = (): (string | undefined)[] =>
      [...document.querySelectorAll<HTMLElement>('ul.repo-list > li')].map((slot) => slot.dataset.repositoryId);
    await mount([active(makeGlance(2, 'b/second'), at), active(makeGlance(1, 'a/first'), at)]);
    expect(order()).toEqual(['2', '1']);

    await click(refreshAllButton());
    await settle();
    expect(order()).toEqual(['2', '1']);
  });

  it('缺失或显著未来的活动时间显示不可用，不显示刚刚', async () => {
    await mount([
      { ...makeGlance(1, 'a/missing'), activityAt: null, activityKind: null },
      { ...makeGlance(2, 'b/future'), activityAt: new Date(NOW + 10 * 60_000).toISOString(), activityKind: 'code' },
    ]);
    expect(activitySpan('a/missing')?.textContent?.trim()).toBe('—');
    expect(activitySpan('b/future')?.textContent?.trim()).toBe('—');
  });
});
