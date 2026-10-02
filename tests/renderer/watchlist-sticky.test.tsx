// @vitest-environment happy-dom
import { readRendererStyles } from './support/styles';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByLabel,
  buttonByText,
  click,
  createStub,
  makeGlance,
  renderApp,
  settle,
  typeInto,
} from './helpers';

let view: RenderResult | null = null;

interface ObserverRecord {
  callback: IntersectionObserverCallback;
  targets: Element[];
  rootMargin: string;
}

async function mount(): Promise<StubHandle> {
  const handle = createStub({ repositories: [makeGlance(1, 'octocat/Hello-World')] });
  view = await renderApp(handle);
  await settle();
  return handle;
}

function installFakeObserver(): { records: ObserverRecord[]; restore: () => void } {
  const records: ObserverRecord[] = [];
  const previous = (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  class FakeIntersectionObserver {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      records.push({ callback, targets: [], rootMargin: options?.rootMargin ?? '' });
    }
    observe(target: Element): void {
      records[records.length - 1]?.targets.push(target);
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    FakeIntersectionObserver;
  return {
    records,
    restore() {
      if (previous === undefined) {
        delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
      } else {
        (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = previous;
      }
    },
  };
}

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  document.documentElement.scrollTop = 0;
});

describe('Watchlist 页面工具栏 · 唯一 DOM 与吸附结构', () => {
  it('同一组新增 / 刷新操作留在页面长容器里，滚动和展开不重建控件', async () => {
    const handle = await mount();

    const page = document.querySelector('.watchlist-page');
    const toolbar = document.querySelector('.watchlist-page-toolbar');
    const addForm = document.querySelector('.watchlist-add-form');
    const refresh = buttonByText('全部刷新');
    expect(toolbar?.closest('.watchlist-page')).toBe(page);
    expect(toolbar?.previousElementSibling?.querySelector('h1')?.textContent).toBe('监控清单');
    expect(toolbar?.contains(addForm)).toBe(true);
    expect(toolbar?.contains(refresh)).toBe(true);
    expect(document.querySelectorAll('.watchlist-page-toolbar')).toHaveLength(1);
    expect(document.querySelectorAll('.watchlist-add-form')).toHaveLength(1);
    expect(
      [...document.querySelectorAll('button')].filter(
        (button) => button.textContent?.trim() === '全部刷新',
      ),
    ).toHaveLength(1);

    const input = document.querySelector<HTMLInputElement>('#add-repository-input');
    const trigger = buttonByLabel('新增仓库');
    await click(trigger);
    await settle();
    expect(document.activeElement).toBe(input);

    // happy-dom 没有 CSS 布局；滚动事件仍能确认没有 JS 监听替换或复制操作节点。
    document.documentElement.scrollTop = 720;
    window.dispatchEvent(new Event('scroll'));
    expect(document.querySelector('.watchlist-page-toolbar')).toBe(toolbar);
    expect(document.querySelector('.watchlist-add-form')).toBe(addForm);
    expect(buttonByText('全部刷新')).toBe(refresh);
    expect(document.activeElement).toBe(input);
    expect(document.querySelectorAll('.watchlist-page-toolbar')).toHaveLength(1);
    expect(document.querySelectorAll('.watchlist-add-form')).toHaveLength(1);

    const releaseRefresh = handle.holdNextRefresh();
    await click(refresh);
    await settle();
    expect(refresh?.getAttribute('aria-busy')).toBe('true');
    releaseRefresh();
    await settle();
    expect(refresh?.getAttribute('aria-busy')).toBe('false');
    expect(document.querySelectorAll('.watchlist-page-toolbar')).toHaveLength(1);
  });

  it('哨兵只切换吸附视觉态，Toolbar、表单和输入焦点保持原样', async () => {
    const fakeObserver = installFakeObserver();
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      if (this.classList.contains('watchlist-toolbar-sentinel')) {
        return {
          x: 0,
          y: 160,
          left: 0,
          top: 160,
          right: 1,
          bottom: 161,
          width: 1,
          height: 1,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (this.tagName === 'HEADER') {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 1024,
          bottom: 67,
          width: 1024,
          height: 67,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return originalRect.call(this);
    };

    try {
      await mount();
      const toolbar = document.querySelector<HTMLElement>('.watchlist-page-toolbar');
      const addForm = document.querySelector('.watchlist-add-form');
      const input = document.querySelector<HTMLInputElement>('#add-repository-input');
      const record = fakeObserver.records.find((item) =>
        item.targets.some((target) => target.classList.contains('watchlist-toolbar-sentinel')),
      );
      const sentinel = record?.targets[0];
      const headerHeight = document.querySelector('header')?.getBoundingClientRect().height;

      expect(record).toBeDefined();
      expect(record?.rootMargin).toBe(`-${headerHeight}px 0px 0px 0px`);
      expect(sentinel?.getAttribute('aria-hidden')).toBe('true');
      expect(toolbar?.dataset.stuck).toBeUndefined();

      await click(buttonByLabel('新增仓库'));
      await settle();
      expect(document.activeElement).toBe(input);

      if (!record || !sentinel) throw new Error('未观察 Watchlist 工具栏哨兵');
      document.documentElement.scrollTop = 720;
      await act(async () => {
        record.callback(
          [{ isIntersecting: false, target: sentinel } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(toolbar?.dataset.stuck).toBe('true');
      expect(document.querySelector('.watchlist-page-toolbar')).toBe(toolbar);
      expect(document.querySelector('.watchlist-add-form')).toBe(addForm);
      expect(document.activeElement).toBe(input);

      if (!input) throw new Error('未找到新增仓库输入框');
      await typeInto(input, 'invalid');
      await settle();
      expect(toolbar?.dataset.stuck).toBe('true');
      const message = toolbar?.querySelector<HTMLElement>(
        '.watchlist-inline-message[data-open="true"]',
      );
      const controlRow = toolbar?.querySelector('.watchlist-add-control-row');
      const action = toolbar?.querySelector('.watchlist-add-action');
      const refresh = buttonByText('全部刷新');
      expect(message).not.toBeNull();
      expect(message?.parentElement).toBe(input?.form);
      expect(controlRow?.parentElement).toBe(input?.form);
      expect(controlRow?.nextElementSibling).toBe(message);
      expect(controlRow?.contains(input)).toBe(true);
      expect(controlRow?.contains(action ?? null)).toBe(true);
      expect(toolbar?.contains(refresh)).toBe(true);
      expect(controlRow?.contains(refresh)).toBe(false);

      await act(async () => {
        record.callback(
          [{ isIntersecting: true, target: sentinel } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      expect(toolbar?.dataset.stuck).toBeUndefined();
      expect(document.querySelector('.watchlist-page-toolbar')).toBe(toolbar);
      expect(document.activeElement).toBe(input);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      fakeObserver.restore();
    }
  });

  it('使用 Header 实测高度、页面背景和低于浮层的层级；不改工具栏宽度', () => {
    const css = readRendererStyles().replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const toolbar = css.match(/\.watchlist-page-toolbar\s*\{[^}]*\}/)?.[0] ?? '';
    const stuckToolbar =
      css.match(/\.watchlist-page-toolbar\[data-stuck='true'\]\s*\{[^}]*\}/)?.[0] ?? '';
    const message = css.match(/\.watchlist-inline-message\s*\{[^}]*\}/)?.[0] ?? '';
    const sentinel = css.match(/\.watchlist-toolbar-sentinel\s*\{[^}]*\}/)?.[0] ?? '';
    const pageGap =
      css.match(/\.watchlist-page\s*>\s*:not\(\[hidden\]\)[^{]*\{[^}]*\}/)?.[0] ?? '';
    const overlay = css.match(/\.repository-action-positioner\s*\{[^}]*\}/)?.[0] ?? '';
    const narrowAddForm =
      css.match(
        /@media\s*\(max-width:\s*35rem\)\s*\{[\s\S]*?\.watchlist-add-form\[data-expanded='true'\]\s*\{[^}]*\}/,
      )?.[0] ?? '';
    const reducedTransitions = css.match(
      /\.watchlist-add-form,\s*\.watchlist-add-content,\s*\.watchlist-add-control-row,\s*\.watchlist-add-field,\s*\.watchlist-add-trigger,\s*\.watchlist-add-action,\s*\.watchlist-inline-message\s*\{[^}]*\}/,
    )?.[0] ?? '';
    const reducedTransform =
      css.match(/\.watchlist-add-field,\s*\.watchlist-add-action,\s*\.watchlist-inline-message\s*\{[^}]*\}/)?.[0] ?? '';
    const app = readFileSync(resolve(process.cwd(), 'src/renderer/pages/App.tsx'), 'utf8');
    const header = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/watchlist/WatchlistHeader.tsx'),
      'utf8',
    );
    const form = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/watchlist/RepositoryOmnibox.tsx'),
      'utf8',
    );

    expect(toolbar).toContain('position: sticky');
    expect(toolbar).toContain('top: var(--app-header-height, 0px)');
    expect(toolbar).toContain('z-index: 5');
    expect(toolbar).toContain('width: 100%');
    expect(toolbar).toContain('border-bottom: 1px solid transparent');
    expect(toolbar).toContain('background-color: transparent');
    expect(toolbar).toContain('align-items: flex-start');
    expect(toolbar).toContain('padding-block: 8px');
    expect(toolbar).not.toContain('align-items: center');
    expect(toolbar).toContain('background-color 130ms var(--motion-ease-out)');
    expect(toolbar).toContain('border-color 130ms var(--motion-ease-out)');
    expect(stuckToolbar).toContain('border-bottom-color: rgb(var(--color-border-subtle))');
    expect(stuckToolbar).toContain('background-color: rgb(var(--color-app))');
    const stuckProperties = [...stuckToolbar.matchAll(/^\s*([a-z-]+)\s*:/gm)].map(
      (match) => match[1],
    );
    expect(stuckProperties.sort()).toEqual(['background-color', 'border-bottom-color'].sort());
    expect(sentinel).toContain('position: absolute');
    expect(sentinel).toContain('top: calc(100% + var(--watchlist-page-gap))');
    expect(pageGap).toContain('margin-block-start: var(--watchlist-page-gap)');
    expect(toolbar).not.toContain('position: fixed');
    expect(toolbar).not.toContain('max-width');
    expect(toolbar).not.toContain('backdrop-filter');
    expect(message).toContain('display: grid');
    expect(message).toContain('grid-template-rows: minmax(0, 0fr)');
    expect(message).not.toContain('position: absolute');
    expect(reducedTransitions).toContain('transition: none !important');
    expect(reducedTransform).toContain('transform: none !important');
    expect(header).toContain('watchlist-toolbar flex w-full flex-wrap items-start gap-2');
    expect(form).toContain('watchlist-add-trigger inline-flex h-9');
    expect(form).toContain('className={`h-9 w-full');
    expect(form).toContain('watchlist-add-action relative inline-flex');
    expect(narrowAddForm).toContain('width: calc(100% - 7rem)');
    expect(narrowAddForm).toContain('min-width: min(16rem, 100%)');
    expect(app).toContain('app-global-header sticky top-0 z-10');
    expect(overlay).toContain('z-index: 20');
  });
});
