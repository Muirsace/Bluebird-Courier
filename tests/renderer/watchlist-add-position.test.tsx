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
  resetReducedMotion,
  settle,
  setReducedMotion,
  submitForm,
  typeInto,
} from './helpers';

let view: RenderResult | null = null;
let realScrollTo: typeof window.scrollTo;
let realScrollIntoView: typeof Element.prototype.scrollIntoView;
let scrollToCalls: ScrollToOptions[] = [];
let scrollIntoViewCalls: Array<{ target: Element; options?: ScrollIntoViewOptions }> = [];
let scrollRoot: Element;
let originalScrollHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  realScrollTo = window.scrollTo;
  realScrollIntoView = Element.prototype.scrollIntoView;
  scrollToCalls = [];
  scrollIntoViewCalls = [];
  scrollRoot = document.scrollingElement ?? document.documentElement;
  originalScrollHeight = Object.getOwnPropertyDescriptor(scrollRoot, 'scrollHeight');
  window.scrollTo = ((options: ScrollToOptions) => {
    scrollToCalls.push({ ...options });
    scrollRoot.scrollTop = options.top ?? 0;
  }) as typeof window.scrollTo;
  Element.prototype.scrollIntoView = function scrollIntoView(options?: ScrollIntoViewOptions): void {
    scrollIntoViewCalls.push({ target: this, options });
  };
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  window.scrollTo = realScrollTo;
  Element.prototype.scrollIntoView = realScrollIntoView;
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

function watchlistSlotIds(): string[] {
  return repoRows().map((row) => row.dataset.repositoryId ?? '');
}

describe('Watchlist 新增位置', () => {
  it('顶部附近新增时最新仓库排第一并播放完整进场，不显示位置提示', async () => {
    await mount();
    scrollRoot.scrollTop = 144;

    await addRepository('octo/new-top');

    expect(watchlistSlotIds()).toEqual(['4', '1', '2', '3']);
    expect(repoRows()[0]?.dataset.motion).toBe('entering');
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
    expect(repoRows()[0]?.dataset.motion).toBe('idle');
    expect(repoRows()[0]?.dataset.highlight).toBeUndefined();
    expect(scrollToCalls).toEqual([{ top: 790, behavior: 'instant' }]);
    expect(buttonByText('查看位置')).not.toBeNull();
    expect(document.body.textContent).toContain('octo/new-scrolled 已加入监控清单');

    const newCard = repoRows()[0];
    await click(buttonByText('查看位置'));
    expect(scrollIntoViewCalls).toEqual([
      {
        target: newCard,
        options: { behavior: 'smooth', block: 'start', inline: 'nearest' },
      },
    ]);
    expect(handle.calls.fetchDetail).toBe(0);
    expect(document.querySelector('.watchlist-page-heading h1')?.textContent).toBe('监控清单');
    expect(newCard?.dataset.highlightOnly).toBeUndefined();
    expect(newCard?.dataset.motion).toBe('idle');

    await act(async () => {
      document.dispatchEvent(new Event('scrollend'));
    });
    await settle();
    expect(newCard?.dataset.highlightOnly).toBe('true');
    expect(newCard?.dataset.motion).toBe('idle');
    expect(newCard?.dataset.highlight).toBeUndefined();
  });

  it('减少动态效果时查看位置使用瞬时滚动', async () => {
    setReducedMotion(true);
    await mount(8);
    scrollRoot.scrollTop = 640;
    await addRepository('octo/new-reduced');

    const newCard = repoRows()[0];
    await click(buttonByText('查看位置'));

    expect(scrollIntoViewCalls[0]?.target).toBe(newCard);
    expect(scrollIntoViewCalls[0]?.options?.behavior).toBe('auto');
    expect(newCard?.dataset.highlightOnly).toBe('true');
    expect(newCard?.dataset.motion).toBe('idle');
  });
});
