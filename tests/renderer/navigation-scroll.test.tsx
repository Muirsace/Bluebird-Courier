// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Glance } from '../../src/shared/types';
import type { RenderResult } from './helpers';
import {
  buttonByText,
  click,
  createStub,
  makeGlance,
  navButton,
  renderApp,
  repoOpenButton,
  resetSystemTheme,
  setReducedMotion,
  resetReducedMotion,
  setSystemTheme,
  settle,
  tab,
} from './helpers';

/**
 * 滚动位置归谁的验收：前进重置、返回恢复，且都发生在 paint 前。
 *
 * happy-dom 没有真实布局（`scrollHeight` 恒为 0），所以这里只驱动
 * `documentElement.scrollTop` 来模拟用户滚动位置、并用一层 spy 包住 `window.scrollTo`
 * 记录调用参数——不写依赖像素布局的脆弱断言。
 */
let view: RenderResult | null = null;
let realScrollTo: typeof window.scrollTo;
let scrollCalls: ScrollToOptions[] = [];

/** 模拟用户把页面滚到某个位置：happy-dom 的 window.scrollY 就是 documentElement.scrollTop。 */
function setScrollY(value: number): void {
  document.documentElement.scrollTop = value;
}

function scrollY(): number {
  return window.scrollY;
}

function lastScrollCall(): ScrollToOptions | undefined {
  return scrollCalls[scrollCalls.length - 1];
}

beforeEach(() => {
  realScrollTo = window.scrollTo.bind(window);
  scrollCalls = [];
  // 桩一层：既记录参数，又照原样写回 scrollTop，行为断言才有意义
  window.scrollTo = ((options: ScrollToOptions): void => {
    scrollCalls.push({ ...options });
    realScrollTo(options);
  }) as typeof window.scrollTo;
  setScrollY(0);
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  window.scrollTo = realScrollTo;
  setScrollY(0);
  resetSystemTheme();
  resetReducedMotion();
});

async function mount(repositories: Glance[] = [makeGlance(1, 'octocat/Hello-World')]): Promise<void> {
  view = await renderApp(createStub({ repositories }));
  await settle();
}

async function openDetail(fullName = 'octocat/Hello-World'): Promise<void> {
  await click(repoOpenButton(fullName));
  await settle();
}

async function goBack(): Promise<void> {
  await click(buttonByText('← 返回监控清单'));
  await settle();
}

describe('导航滚动 · 前进从顶部开始', () => {
  it('首屏进入清单不写滚动位置（不是导航，也就不该碰 scroll）', async () => {
    await mount();
    expect(scrollCalls).toHaveLength(0);
    expect(scrollY()).toBe(0);
  });

  it('清单滚到中段再进详情：详情第一眼就是顶部', async () => {
    await mount();
    setScrollY(687);

    await openDetail();

    expect(scrollY()).toBe(0);
    expect(lastScrollCall()).toEqual({ top: 0, behavior: 'auto' });
  });

  it('清单滚到中段再进设置：设置也从顶部开始', async () => {
    await mount();
    setScrollY(512);

    await click(navButton('设置'));
    await settle();

    expect(scrollY()).toBe(0);
    expect(lastScrollCall()).toEqual({ top: 0, behavior: 'auto' });
  });
});

describe('导航滚动 · 返回恢复原位置', () => {
  it('详情返回清单：回到离开前的那个确切位置', async () => {
    await mount();
    setScrollY(687);
    await openDetail();

    await goBack();

    expect(scrollY()).toBe(687);
    expect(lastScrollCall()).toEqual({ top: 687, behavior: 'auto' });
  });

  it('换一个仓库再进：保存的是新的位置，不沿用上一次的值', async () => {
    await mount([makeGlance(1, 'octocat/Hello-World'), makeGlance(2, 'MAA1999/M9A')]);

    setScrollY(300);
    await openDetail('octocat/Hello-World');
    await goBack();
    expect(scrollY()).toBe(300);

    setScrollY(940);
    await openDetail('MAA1999/M9A');
    expect(scrollY()).toBe(0);

    await goBack();
    expect(scrollY()).toBe(940);
  });

  it('从设置回清单：恢复清单位置', async () => {
    await mount();
    setScrollY(420);
    await click(navButton('设置'));
    await settle();
    // 先确认设置页确实站到了顶部，否则"回来还是 420"可能只是没人动过它
    expect(scrollY()).toBe(0);

    await click(navButton('监控清单'));
    await settle();

    expect(scrollY()).toBe(420);
  });

  it('详情里绕去设置再回清单：恢复的仍是进详情前的位置', async () => {
    await mount();
    setScrollY(360);
    await openDetail();
    expect(scrollY()).toBe(0);

    // 详情 → 设置不改写清单那份记录（此时用户看的不是清单）
    await click(navButton('设置'));
    await settle();
    await click(navButton('监控清单'));
    await settle();

    expect(scrollY()).toBe(360);
  });
});

describe('导航滚动 · 与导航无关的变化一律不动滚动', () => {
  it('重新抓取只是数据更新：详情的位置原地不动', async () => {
    await mount();
    await openDetail();
    const before = scrollCalls.length;
    setScrollY(180);

    await click(buttonByText('重新抓取'));
    await settle();

    expect(scrollY()).toBe(180);
    expect(scrollCalls).toHaveLength(before);
  });

  it('切 Tab 不改变详情滚动位置', async () => {
    await mount();
    await openDetail();
    const before = scrollCalls.length;
    setScrollY(180);

    await click(tab('发版'));
    await settle();

    expect(scrollY()).toBe(180);
    expect(scrollCalls).toHaveLength(before);
  });

  it('主题切换不改变滚动位置', async () => {
    await mount();
    await openDetail();
    const before = scrollCalls.length;
    setScrollY(180);

    await act(async () => {
      setSystemTheme('dark');
    });
    await settle();

    expect(scrollY()).toBe(180);
    expect(scrollCalls).toHaveLength(before);
  });

  it('清单的查询更新（全部刷新）不把用户拽回顶部', async () => {
    await mount();
    const before = scrollCalls.length;
    setScrollY(260);

    await click(buttonByText('全部刷新'));
    await settle();

    expect(scrollY()).toBe(260);
    expect(scrollCalls).toHaveLength(before);
  });

  it('Reduced Motion 不改变滚动语义：同样是瞬时写位置', async () => {
    setReducedMotion(true);
    await mount();
    setScrollY(687);

    await openDetail();
    expect(lastScrollCall()).toEqual({ top: 0, behavior: 'auto' });

    await goBack();
    expect(lastScrollCall()).toEqual({ top: 687, behavior: 'auto' });
    expect(scrollY()).toBe(687);
  });
});
