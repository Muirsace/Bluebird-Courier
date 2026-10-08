// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByLabel,
  buttonByText,
  click,
  createStub,
  makeGlance,
  renderApp,
  repoRows,
  repoMotionForSlot,
  resetReducedMotion,
  settle,
  settleMotion,
  setReducedMotion,
  submitForm,
  typeInto,
} from './helpers';

let view: RenderResult | null = null;
let realScrollTo: typeof window.scrollTo;
let realScrollIntoView: typeof Element.prototype.scrollIntoView;
let realGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;
let scrollToCalls: ScrollToOptions[] = [];
let scrollIntoViewCalls: Array<{ target: Element; options?: ScrollIntoViewOptions }> = [];
let scrollRoot: Element;
let originalScrollHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  realScrollTo = window.scrollTo;
  realScrollIntoView = Element.prototype.scrollIntoView;
  realGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  scrollToCalls = [];
  scrollIntoViewCalls = [];
  scrollRoot = document.scrollingElement ?? document.documentElement;
  originalScrollHeight = Object.getOwnPropertyDescriptor(scrollRoot, 'scrollHeight');
  window.scrollTo = ((options: ScrollToOptions) => {
    scrollToCalls.push({ ...options });
    if (options.behavior !== 'smooth') scrollRoot.scrollTop = options.top ?? 0;
  }) as typeof window.scrollTo;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    if (this.matches('li[data-repository-id="9"]') ||
      this.closest('li[data-repository-id="9"]')) {
      const top = 200 - scrollRoot.scrollTop;
      return {
        top, bottom: top + 100, height: 100, left: 0, right: 500,
        width: 500, x: 0, y: top, toJSON: () => ({}),
      };
    }
    return realGetBoundingClientRect.call(this);
  };
  Element.prototype.scrollIntoView = function scrollIntoView(options?: ScrollIntoViewOptions): void {
    scrollIntoViewCalls.push({ target: this, options });
  };
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  window.scrollTo = realScrollTo;
  Element.prototype.scrollIntoView = realScrollIntoView;
  Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
  if (originalScrollHeight) {
    Object.defineProperty(scrollRoot, 'scrollHeight', originalScrollHeight);
  } else {
    Reflect.deleteProperty(scrollRoot, 'scrollHeight');
  }
  scrollRoot.scrollTop = 0;
  resetReducedMotion();
});

async function mount(repositoryCount = 3): Promise<StubHandle> {
  const repositories = Array.from({ length: repositoryCount }, (_, index) =>
    makeGlance(index + 1, `octo/repo-${index + 1}`),
  );
  const handle = createStub({ repositories });
  view = await renderApp(handle);
  await settle();
  return handle;
}

async function addRepository(fullName: string): Promise<void> {
  await click(buttonByLabel('新增仓库'));
  const input = document.querySelector<HTMLInputElement>('#add-repository-input');
  if (!input) throw new Error('未找到新增仓库输入框');
  await typeInto(input, fullName);
  if (!input.form) throw new Error('输入框不在表单内');
  await submitForm(input.form);
  await settle();
}

/**
 * 点击「查看位置」并模拟浏览器接受 smooth 滚动后的第一帧。
 *
 * happy-dom 里 scrollIntoView 是桩、位置不会真的变，也就没有 scroll 事件；
 * 而实现会在"一帧内没看到任何位移"时重发同一条 smooth 请求（防 Chromium 偶发吞掉
 * 整次 scroll-into-view）。真实浏览器接受请求后必然派发 scroll，这里补上，
 * 让测试环境的"没滚动"不被误判成"被吞掉"。
 */
async function clickReveal(): Promise<void> {
  await act(async () => {
    const revealButton = buttonByText('查看位置');
    if (!revealButton) throw new Error('未找到查看位置按钮');
    revealButton.click();
    window.dispatchEvent(new Event('scroll'));
  });
}

async function finishSmoothReveal(): Promise<void> {
  if ('onscrollend' in window) {
    await act(async () => {
      scrollRoot.scrollTop = 0;
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('scrollend'));
    });
  }
  await settle();
}

function watchlistSlotIds(): string[] {
  return repoRows().map((row) => row.dataset.repositoryId ?? '');
}

describe('Watchlist 新增位置', () => {
  it('顶部附近新增时最新仓库排第一并播放完整进场，不显示位置提示', async () => {
    await mount();
    scrollRoot.scrollTop = 144;

    await addRepository('octo/new-top');

    expect(watchlistSlotIds()).toEqual(['4', '1', '2', '3']);
    expect(repoMotionForSlot(repoRows()[0])).toBe('entering');
    expect(repoRows()[0]?.dataset.highlight).toBe('true');
    expect(buttonByText('查看位置')).toBeNull();
    expect(scrollToCalls).toHaveLength(0);
  });

  it('下方新增按真实高度瞬时补偿 viewport，提示定位后只高亮、不进详情', async () => {
    const handle = await mount(8);
    let heightRead = 0;
    Object.defineProperty(scrollRoot, 'scrollHeight', {
      configurable: true,
      get: () => (heightRead++ === 0 ? 2200 : 2350),
    });
    scrollRoot.scrollTop = 640;

    await addRepository('octo/new-scrolled');

    expect(watchlistSlotIds()).toEqual(['9', '1', '2', '3', '4', '5', '6', '7', '8']);
    expect(repoMotionForSlot(repoRows()[0])).toBe('idle');
    expect(repoRows()[0]?.dataset.highlight).toBeUndefined();
    expect(scrollToCalls).toEqual([{ top: 790, behavior: 'instant' }]);
    expect(buttonByText('查看位置')).not.toBeNull();
    expect(document.body.textContent).toContain('octo/new-scrolled 已加入监控清单');
    expect(document.querySelector('.watchlist-added-notice')).toBeNull();
    expect(document.querySelector('.watchlist-add-form .watchlist-inline-message')?.getAttribute('data-open')).toBe(
      'true',
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });
    expect(buttonByText('查看位置')).not.toBeNull();
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector<HTMLElement>('.watchlist-add-action')?.dataset.actionKind).toBe('added');

    await click(document.querySelector<HTMLButtonElement>('.watchlist-add-action'));
    expect(document.querySelector<HTMLElement>('.watchlist-add-action')?.dataset.actionKind).toBe('clear');
    expect(buttonByText('查看位置')).not.toBeNull();

    const newCard = repoRows()[0];
    if (!newCard) throw new Error('新仓库卡片未挂载');
    let cardTop = -400;
    newCard.getBoundingClientRect = () => ({
      top: cardTop,
      bottom: cardTop + 100,
      height: 100,
      left: 0,
      right: 500,
      width: 500,
      x: 0,
      y: cardTop,
      toJSON: () => ({}),
    });
    scrollToCalls = [];
    scrollIntoViewCalls = [];
    act(() => {
      const revealButton = buttonByText('查看位置');
      if (!revealButton) throw new Error('未找到查看位置按钮');
      revealButton.click();
    });
    expect(scrollToCalls).toHaveLength(0);
    expect(scrollIntoViewCalls).toHaveLength(1);
    expect(scrollIntoViewCalls[0]?.target.matches('li[data-repository-id]')).toBe(true);
    expect(scrollIntoViewCalls[0]?.options).toEqual({ behavior: 'smooth', block: 'center' });
    expect(handle.calls.fetchDetail).toBe(0);
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('true');
    expect(buttonByText('查看位置')?.disabled).toBe(true);
    expect(document.querySelector('.watchlist-page-heading h1')?.textContent).toBe('监控清单');
    expect(newCard?.dataset.highlightOnly).toBeUndefined();
    expect(repoMotionForSlot(newCard)).toBe('idle');
    // 提示在滚动期间保持可见：还没到位就收起会让工具栏变矮，卡片会被再挪一次。
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('true');
    expect(buttonByText('查看位置')?.disabled).toBe(true);
    expect(document.querySelector<HTMLElement>('.watchlist-add-action')?.dataset.actionKind).toBe('clear');

    await finishSmoothReveal();
    expect(newCard?.dataset.highlightOnly).toBe('true');
    expect(repoMotionForSlot(newCard)).toBe('idle');
    expect(newCard?.dataset.highlight).toBeUndefined();
    // 到位后不是立刻收起，先停留一段（等用户看见高亮）。
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('true');
    expect(buttonByText('查看位置')).not.toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 760));
    });
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('false');
    // 停留结束连同输入框一起收回：不留一个空表单占着版面。
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector<HTMLInputElement>('#add-repository-input')?.disabled).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(buttonByText('查看位置')).toBeNull();
    expect(scrollIntoViewCalls).toHaveLength(1);
    expect(scrollIntoViewCalls[0]?.options).toEqual({ behavior: 'smooth', block: 'center' });
  });

  it('下方新增但卡片落在视口下方时不补偿 viewport（活动时间排序下位置不定）', async () => {
    await mount(8);
    let heightRead = 0;
    Object.defineProperty(scrollRoot, 'scrollHeight', {
      configurable: true,
      get: () => (heightRead++ === 0 ? 2200 : 2350),
    });
    scrollRoot.scrollTop = 640;
    // 新卡片这次按活动时间排在列表末尾：插入点在视口下方，视口上方的内容没有变化。
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      if (this.matches('li[data-repository-id="9"]') || this.closest('li[data-repository-id="9"]')) {
        return {
          top: 900, bottom: 1000, height: 100, left: 0, right: 500,
          width: 500, x: 0, y: 900, toJSON: () => ({}),
        };
      }
      return realGetBoundingClientRect.call(this);
    };

    await addRepository('octo/new-below');

    expect(watchlistSlotIds()).toContain('9');
    expect(scrollToCalls).toHaveLength(0);
    expect(buttonByText('查看位置')).not.toBeNull();
  });

  it('顶部新增但卡片落在视口下方：给出「查看位置」且不自动收起', async () => {
    await mount(8);
    scrollRoot.scrollTop = 0;
    // nearTop 不再等价于可见：卡片按活动时间落到了视口下方。
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      if (this.matches('li[data-repository-id="9"]') || this.closest('li[data-repository-id="9"]')) {
        return {
          top: 900, bottom: 1000, height: 100, left: 0, right: 500,
          width: 500, x: 0, y: 900, toJSON: () => ({}),
        };
      }
      return realGetBoundingClientRect.call(this);
    };

    await addRepository('octo/new-low');

    expect(buttonByText('查看位置')).not.toBeNull();
    // 不可见时不走「可见新增」的 1.4s 自动收起：等到 1.6s 提示仍在、可点「查看位置」。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('true');
    expect(buttonByText('查看位置')).not.toBeNull();
  });

  it('滚动中新增但卡片落进视口：不出「查看位置」，改发定位脉冲并照常自动收起', async () => {
    await mount(8);
    scrollRoot.scrollTop = 640;
    // 卡片这次落在用户正看着的视口内（没有进场动画，靠脉冲指出它落在哪）。
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      if (this.matches('li[data-repository-id="9"]') || this.closest('li[data-repository-id="9"]')) {
        return {
          top: 300, bottom: 400, height: 100, left: 0, right: 500,
          width: 500, x: 0, y: 300, toJSON: () => ({}),
        };
      }
      return realGetBoundingClientRect.call(this);
    };

    await addRepository('octo/new-seen');

    const newCard = repoRows()[0];
    expect(buttonByText('查看位置')).toBeNull();
    expect(newCard?.dataset.highlightOnly).toBe('true');
    expect(scrollToCalls).toHaveLength(0);
    // 可见新增沿用自动收起：约 1.4s 后提示与输入框一起收回。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('false');
    expect(buttonByText('查看位置')).toBeNull();
  });

  it('上一条滚动的 scrollend 残留不会提前收尾（高亮必须等滚动真的开始）', async () => {
    await mount(8);
    scrollRoot.scrollTop = 640;
    await addRepository('octo/new-stale-scrollend');
    const newCard = repoRows()[0];
    if (!newCard) throw new Error('新仓库卡片未挂载');
    newCard.getBoundingClientRect = () => ({
      top: -400, bottom: -300, height: 100,
      left: 0, right: 500, width: 500, x: 0, y: -400, toJSON: () => ({}),
    });

    await click(buttonByText('查看位置'));
    // 用户刚滚完就点了「查看位置」：浏览器补派上一条滚动的 scrollend，此时我们的滚动还没动过。
    await act(async () => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(newCard.dataset.highlightOnly).toBeUndefined();

    await finishSmoothReveal();
    expect(newCard.dataset.highlightOnly).toBe('true');
  });

  it('scroll-into-view 被静默吞掉时重发同一条请求，绝不降级成瞬移', async () => {
    await mount(8);
    scrollRoot.scrollTop = 640;
    await addRepository('octo/new-swallowed');
    const newCard = repoRows()[0];
    if (!newCard) throw new Error('新仓库卡片未挂载');
    newCard.getBoundingClientRect = () => ({
      top: -400, bottom: -300, height: 100,
      left: 0, right: 500, width: 500, x: 0, y: -400, toJSON: () => ({}),
    });

    // 点击后浏览器什么都没滚（既没有位移，也没有 scroll 事件）。
    act(() => {
      const revealButton = buttonByText('查看位置');
      if (!revealButton) throw new Error('未找到查看位置按钮');
      revealButton.click();
    });
    expect(scrollIntoViewCalls).toHaveLength(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(scrollIntoViewCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of scrollIntoViewCalls) {
      expect(call.target.matches('li[data-repository-id]')).toBe(true);
      expect(call.options).toEqual({ behavior: 'smooth', block: 'center' });
    }
    expect(scrollToCalls).toHaveLength(0);

    // 一旦滚动真的开始（浏览器派发 scroll），就不再重发。
    const settledCount = scrollIntoViewCalls.length;
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(scrollIntoViewCalls).toHaveLength(settledCount);
  });

  it('滚动被打断（落点没到、scrollend 缺失）时高亮与表单收尾照样落地', async () => {
    await mount(8);
    scrollRoot.scrollTop = 640;
    await addRepository('octo/new-interrupted');
    const newCard = repoRows()[0];
    if (!newCard) throw new Error('新仓库卡片未挂载');
    newCard.getBoundingClientRect = () => ({
      top: -400, bottom: -300, height: 100,
      left: 0, right: 500, width: 500, x: 0, y: -400, toJSON: () => ({}),
    });

    await clickReveal();
    expect(scrollIntoViewCalls).toHaveLength(1);
    // 用户中途滚了一下（有 scroll 事件），但滚动被顶掉、再也没派发 scrollend。
    await act(async () => {
      scrollRoot.scrollTop = 300;
      window.dispatchEvent(new Event('scroll'));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });

    expect(repoMotionForSlot(newCard)).toBe('idle');
    expect(newCard.dataset.highlightOnly).toBe('true');
    expect(newCard.dataset.highlight).toBeUndefined();
    // 兜底收尾同样先停留再收起：1600ms 时消息已关，内容再走 200ms 退场。
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('false');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(buttonByText('查看位置')).toBeNull();
  });

  it('到位信号只认一次：重复 scrollend 不会重播高亮', async () => {
    await mount(8);
    scrollRoot.scrollTop = 640;
    await addRepository('octo/new-single-highlight');
    const newCard = repoRows()[0];
    if (!newCard) throw new Error('新仓库卡片未挂载');
    newCard.getBoundingClientRect = () => ({
      top: -400, bottom: -300, height: 100,
      left: 0, right: 500, width: 500, x: 0, y: -400, toJSON: () => ({}),
    });

    await click(buttonByText('查看位置'));
    await finishSmoothReveal();
    expect(newCard.dataset.highlightOnly).toBe('true');
    await act(async () => {
      window.dispatchEvent(new Event('scrollend'));
    });
    expect(newCard.dataset.highlight).toBeUndefined();
    expect(repoMotionForSlot(newCard)).toBe('idle');
  });

  it('卡片一直没出现时定位请求不会锁死提示，用户仍能清除', async () => {
    const handle = await mount(8);
    scrollRoot.scrollTop = 640;
    await addRepository('octo/never-commits');
    // 清单刷新后仍然没有这张卡：定位只能挂成 pending。
    handle.setRepositories(Array.from({ length: 8 }, (_, index) =>
      makeGlance(index + 1, `octo/repo-${index + 1}`),
    ));
    await click(buttonByText('检查更新'));
    await settle();
    await settleMotion(250);
    expect(watchlistSlotIds()).not.toContain('9');

    await click(buttonByText('查看位置'));
    expect(scrollIntoViewCalls).toHaveLength(0);
    expect(buttonByText('查看位置')?.disabled).toBe(true);
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('true');

    // 目标卡片始终没提交：收尾按钮必须仍然可用，否则这段反馈就再也关不掉了。
    const action = document.querySelector<HTMLButtonElement>('.watchlist-add-action');
    expect(action?.disabled).toBe(false);
    await click(action);
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('false');
    expect(document.activeElement).toBe(document.querySelector('#add-repository-input'));
  });

  it('查看位置在新卡片尚未进入已渲染列表时保留请求，卡片出现后再滚动并只高亮', async () => {
    const handle = await mount(8);
    scrollRoot.scrollTop = 640;
    await addRepository('octo/new-pending');

    const newlyAdded = makeGlance(9, 'octo/new-pending');
    handle.setRepositories(Array.from({ length: 8 }, (_, index) =>
      makeGlance(index + 1, `octo/repo-${index + 1}`),
    ));
    await click(buttonByText('检查更新'));
    await settle();
    await settleMotion(250);
    expect(watchlistSlotIds()).not.toContain('9');
    expect(buttonByText('查看位置')).not.toBeNull();

    await click(buttonByText('查看位置'));
    expect(scrollIntoViewCalls).toHaveLength(0);
    expect(handle.calls.fetchDetail).toBe(0);
    expect(buttonByText('查看位置')?.disabled).toBe(true);

    handle.setRepositories([newlyAdded, ...Array.from({ length: 8 }, (_, index) =>
      makeGlance(index + 1, `octo/repo-${index + 1}`),
    )]);
    await click(buttonByText('检查更新'));
    await settle();

    const newCard = document.querySelector<HTMLElement>(
      'ul.repo-list > li[data-repository-id="9"]',
    );
    expect(newCard).not.toBeNull();
    // 卡片一提交就立刻定位。"确认滚动真的开始了"的探针可能补发同一请求，
    // 但每一次都必须是对这张卡片的 smooth / center —— 不能出现第二条不同的滚动意图。
    expect(scrollIntoViewCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of scrollIntoViewCalls) {
      expect(call.target.matches('li[data-repository-id="9"]')).toBe(true);
      expect(call.options).toEqual({ behavior: 'smooth', block: 'center' });
    }
    await finishSmoothReveal();
    expect(repoMotionForSlot(newCard)).toBe('idle');
    expect(newCard?.dataset.highlightOnly).toBe('true');
    expect(newCard?.dataset.highlight).toBeUndefined();
    expect(handle.calls.fetchDetail).toBe(0);
    // 到位后停留一段才收起提示（并连同输入框一起收回）。
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('true');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 760));
    });
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('false');
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(buttonByText('查看位置')).toBeNull();
  });

  it('目标卡片已挂载时立即发起 smooth reveal，不等待长计时器', async () => {
    await mount(8);
    scrollRoot.scrollTop = 640;
    await addRepository('octo/new-retry');
    const newCard = repoRows()[0];
    if (!newCard) throw new Error('新仓库卡片未挂载');
    let cardTop = -400;
    newCard.getBoundingClientRect = () => ({
      top: cardTop, bottom: cardTop + 100, height: 100,
      left: 0, right: 500, width: 500, x: 0, y: cardTop, toJSON: () => ({}),
    });

    scrollToCalls = [];
    scrollIntoViewCalls = [];
    await clickReveal();
    expect(scrollToCalls).toHaveLength(0);
    expect(scrollIntoViewCalls).toHaveLength(1);
    expect(scrollIntoViewCalls[0]?.target.matches('li[data-repository-id]')).toBe(true);
    expect(scrollIntoViewCalls[0]?.options).toEqual({ behavior: 'smooth', block: 'center' });
    expect(repoMotionForSlot(newCard)).toBe('idle');
    // 滚动调用发生在点击的事件周期内，提示不排在它前面也不等它，而是在到位后才收。
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('true');
    await finishSmoothReveal();
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('true');
    expect(newCard.dataset.highlightOnly).toBe('true');
    expect(buttonByText('查看位置')?.disabled).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 760));
    });
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('false');
  });

  it('减少动态效果时查看位置使用瞬时滚动', async () => {
    setReducedMotion(true);
    await mount(8);
    scrollRoot.scrollTop = 640;
    await addRepository('octo/new-reduced');

    const newCard = repoRows()[0];
    act(() => {
      const revealButton = buttonByText('查看位置');
      if (!revealButton) throw new Error('未找到查看位置按钮');
      revealButton.click();
    });

    expect(scrollToCalls).toHaveLength(0);
    expect(scrollIntoViewCalls).toHaveLength(1);
    expect(scrollIntoViewCalls[0]?.options).toEqual({ behavior: 'auto', block: 'center' });
    expect(repoMotionForSlot(newCard)).toBe('idle');
    expect(newCard?.dataset.highlightOnly).toBeUndefined();
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(newCard?.dataset.highlightOnly).toBe('true');
    expect(repoMotionForSlot(newCard)).toBe('idle');
    // 降级路径同样要"到位后停留一段再收"。
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('true');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 760));
    });
    expect(document.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('false');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(buttonByText('查看位置')).toBeNull();
  });
});
