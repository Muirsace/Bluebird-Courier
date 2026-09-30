// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByText,
  click,
  createStub,
  makeGlance,
  navButton,
  renderApp,
  repoOpenButton,
  repoSlot,
  resetSystemTheme,
  settle,
  tab,
} from './helpers';

/**
 * 本轮两件事的验收：Tabs 吸附（布局 + 语义不变）与 Esc 返回（复用统一返回路径）。
 *
 * happy-dom 没有布局引擎，吸附的像素表现由真实引擎人工核对；这里只断言
 * 结构、状态机、handler 与键盘守卫，以及样式表里那几条不变量（不写 top === 61px 这类脆断言）。
 */
let view: RenderResult | null = null;
let realScrollTo: typeof window.scrollTo;
let scrollCalls: ScrollToOptions[] = [];

beforeEach(() => {
  realScrollTo = window.scrollTo.bind(window);
  scrollCalls = [];
  window.scrollTo = ((options: ScrollToOptions): void => {
    scrollCalls.push({ ...options });
    realScrollTo(options);
  }) as typeof window.scrollTo;
  document.documentElement.scrollTop = 0;
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  window.scrollTo = realScrollTo;
  document.documentElement.scrollTop = 0;
  resetSystemTheme();
});

async function mount(): Promise<StubHandle> {
  const handle = createStub({
    repositories: [makeGlance(1, 'octocat/Hello-World')],
    detail: { releases: [{ tagName: 'v9.9.9', title: 'v9.9.9', publishedAt: '2026-09-24T10:00:00.000Z' }] },
  });
  view = await renderApp(handle);
  await settle();
  return handle;
}

function transitionNode(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-testid="page-transition"]');
  if (!node) throw new Error('页面切换容器不存在');
  return node;
}

function motionKind(): string | null {
  return transitionNode().dataset.viewMotion ?? null;
}

function tablist(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="tablist"]');
}

function inDetail(): boolean {
  return buttonByText('← 返回监控清单') !== null;
}

async function openDetail(): Promise<void> {
  await click(repoOpenButton('octocat/Hello-World'));
  await settle();
}

async function pressEscapeOn(target: EventTarget, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }),
    );
  });
  await settle();
}

// ---------- 吸附判定用的假观察器 ----------

interface ObserverRecord {
  callback: IntersectionObserverCallback;
  targets: Element[];
  disconnected: boolean;
}

function installFakeObserver(): ObserverRecord[] {
  const records: ObserverRecord[] = [];
  class FakeIntersectionObserver {
    root = null;
    rootMargin = '';
    thresholds: number[] = [];
    constructor(callback: IntersectionObserverCallback) {
      records.push({ callback, targets: [], disconnected: false });
    }
    observe(target: Element): void {
      records[records.length - 1]?.targets.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      const record = records[records.length - 1];
      if (record) record.disconnected = true;
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    FakeIntersectionObserver;
  return records;
}

/** 详情里有不止一个哨兵（Tabs 吸附 / 当前仓库上下文），按目标类名挑出 Tabs 那个。 */
function tabsRecord(records: ObserverRecord[]): ObserverRecord {
  const record = records.find((item) =>
    item.targets[0]?.className.includes('detail-tabs-sentinel'),
  );
  if (!record) throw new Error('没有创建 Tabs 吸附观察器');
  return record;
}

async function crossStuckLine(record: ObserverRecord, isIntersecting: boolean): Promise<void> {
  await act(async () => {
    record.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
  await settle();
}

describe('Detail Tabs 吸附 · 结构与状态', () => {
  it('吸附容器就是原来那一套 Tabs：单 tablist / 单 indicator / 哨兵不进语义树', async () => {
    await mount();
    await openDetail();

    const sticky = document.querySelector<HTMLElement>('.detail-tabs-sticky');
    expect(sticky).not.toBeNull();
    // 没有复制第二套：吸附容器里的 tablist 就是全局唯一那个
    expect(sticky?.querySelector('[role="tablist"]')).toBe(tablist());
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(6);
    expect(document.querySelectorAll('.tab-indicator')).toHaveLength(1);
    expect(sticky?.querySelector('.tab-indicator')?.getAttribute('aria-hidden')).toBe('true');
    // 分隔线还在这条 tablist 自己身上（吸附只换它的颜色）
    expect(tablist()?.className).toContain('border-b');

    const sentinel = document.querySelector('.detail-tabs-sentinel');
    expect(sentinel?.getAttribute('aria-hidden')).toBe('true');
    expect(sentinel?.getAttribute('tabindex')).toBeNull();
    expect(sentinel?.getAttribute('role')).toBeNull();
    expect(sentinel?.closest('[role="tablist"]')).toBeNull();
    // 哨兵挂在揭示容器下、且不在 space-y-4 里：绝对定位不占位，不会挤动 Tabs
    expect(sentinel?.parentElement?.className).toContain('detail-reveal');
  });

  it('吸入吸附态只由哨兵穿越驱动：data-stuck 随之开关', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();

      const record = tabsRecord(records);
      expect(record.targets[0]?.className).toContain('detail-tabs-sentinel');
      // 刚进详情是在页面顶部：还没有吸附强调
      expect(tablist()?.getAttribute('data-stuck')).toBeNull();

      await crossStuckLine(record, false);
      expect(tablist()?.getAttribute('data-stuck')).toBe('true');

      await crossStuckLine(record, true);
      expect(tablist()?.getAttribute('data-stuck')).toBeNull();
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('吸附态下切 Tab：aria / indicator 照旧，且不产生任何抓取', async () => {
    const records = installFakeObserver();
    try {
      const handle = await mount();
      await openDetail();
      const record = tabsRecord(records);
      await crossStuckLine(record, false);
      const before = handle.calls.fetchDetail;

      await click(tab('发版'));
      await settle();

      expect(tablist()?.getAttribute('data-stuck')).toBe('true');
      expect(document.querySelector('[role="tabpanel"]')?.id).toBe('detail-panel-releases');
      expect(tab('发版')?.getAttribute('aria-selected')).toBe('true');
      expect(document.querySelectorAll('.tab-indicator')).toHaveLength(1);
      expect(handle.calls.fetchDetail).toBe(before);
      expect(handle.calls.refreshGlance).toBe(0);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('顶部栏高度由 App 实测后写成 CSS 变量（吸附线的唯一来源）', async () => {
    await mount();
    // happy-dom 没有布局，量到 0px 也算数：这里断言的是"接线"，不是像素
    expect(document.documentElement.style.getPropertyValue('--app-header-height')).not.toBe('');
  });

  /**
   * 不变量：吸附只允许改纵向定位与分隔线颜色。
   * 写死 top 数值、改宽度 / 外边距、加毛玻璃或阴影都会让"吸附只是布局行为"这条失效。
   */
  it('样式表：吸附容器只改纵向定位，stuck 只换分隔线颜色', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );

    const rule = css.match(/\.detail-tabs-sticky\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('position: sticky');
    expect(rule).toContain('top: var(--app-header-height');
    expect(rule).toContain('background-color: rgb(var(--color-app))');
    expect(rule).not.toContain('width');
    expect(rule).not.toContain('margin');
    expect(rule).not.toContain('transform');
    expect(rule).not.toContain('backdrop');
    expect(rule).not.toContain('box-shadow');

    const stuck = css.match(/\[data-stuck='true'\]\s*\{[^}]*\}/)?.[0] ?? '';
    expect(stuck).toContain('border-color');
    expect(stuck).not.toContain('box-shadow');
    expect(stuck).not.toContain('transform');

    const transition = css.match(/\.detail-tabs-sticky \[role='tablist'\]\s*\{[^}]*\}/)?.[0] ?? '';
    expect(transition).toContain('border-color');
    expect(transition).toContain('var(--motion-ease-out)');

    const sentinel = css.match(/\.detail-tabs-sentinel\s*\{[^}]*\}/)?.[0] ?? '';
    expect(sentinel).toContain('position: absolute');
    expect(sentinel).toContain('var(--app-header-height');
  });

  it('Reduced Motion 下吸附态的换色同样瞬时（由全局降级规则接管）', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles.css'), 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('transition-duration: 0.01ms !important');
  });
});

describe('Detail Esc 返回 · 复用统一返回路径', () => {
  it('详情里按 Esc 等价于点「← 返回监控清单」', async () => {
    await mount();
    await openDetail();
    expect(inDetail()).toBe(true);
    expect(motionKind()).toBe('forward');

    await pressEscapeOn(document);

    expect(inDetail()).toBe(false);
    expect(repoSlot('octocat/Hello-World')).not.toBeNull();
    // 与鼠标返回同样是 back 方向：两种退出方式视觉语义一致
    expect(motionKind()).toBe('back');
  });

  it('Esc 返回同样恢复进详情前的清单滚动位置', async () => {
    await mount();
    document.documentElement.scrollTop = 687;
    await openDetail();
    expect(document.documentElement.scrollTop).toBe(0);

    await pressEscapeOn(document);

    expect(window.scrollY).toBe(687);
    expect(scrollCalls[scrollCalls.length - 1]).toEqual({ top: 687, behavior: 'auto' });
  });

  it('鼠标返回与 Esc 走的是同一条路径：方向与恢复值都相同', async () => {
    await mount();
    // 同一个起点跑两遍，只换退出方式——输出必须完全一致，才能说明复用的是一个 handler
    document.documentElement.scrollTop = 420;
    await openDetail();
    await click(buttonByText('← 返回监控清单'));
    await settle();
    const byMouse = { motion: motionKind(), y: window.scrollY, calls: scrollCalls.length };

    document.documentElement.scrollTop = 420;
    await openDetail();
    await pressEscapeOn(document);
    const byEsc = {
      motion: motionKind(),
      y: window.scrollY,
      calls: scrollCalls.length - byMouse.calls,
    };

    expect(byEsc).toEqual(byMouse);
  });
});

describe('Detail Esc 返回 · 不该返回的情况', () => {
  it('清单与设置页里的 Esc 不会切页', async () => {
    await mount();
    await pressEscapeOn(document);
    expect(repoSlot('octocat/Hello-World')).not.toBeNull();
    expect(motionKind()).toBeNull();

    await click(navButton('设置'));
    await settle();
    const node = transitionNode();
    await pressEscapeOn(document);
    expect(transitionNode()).toBe(node);
    expect(document.querySelector('#accessToken-input')).not.toBeNull();
  });

  it('浮层已经消费掉这次 Esc（defaultPrevented）时，详情不返回', async () => {
    await mount();
    await openDetail();

    // 更早的冒泡监听器（浮层都挂在 document 上）把这次 Esc 吃掉
    const swallow = (event: Event): void => event.preventDefault();
    document.addEventListener('keydown', swallow);
    try {
      await pressEscapeOn(document);
    } finally {
      document.removeEventListener('keydown', swallow);
    }

    expect(inDetail()).toBe(true);
    expect(motionKind()).toBe('forward');
  });

  it('输入法组字中的 Esc 不返回', async () => {
    await mount();
    await openDetail();

    await pressEscapeOn(document, { isComposing: true });

    expect(inDetail()).toBe(true);
  });

  it('焦点在输入控件里时 Esc 不返回（Esc 属于取消输入）', async () => {
    await mount();
    await openDetail();

    const editable: HTMLElement[] = [];
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editableDiv = document.createElement('div');
    editableDiv.contentEditable = 'true';
    editable.push(input, textarea, select, editableDiv);
    for (const element of editable) document.body.append(element);

    try {
      for (const element of editable) {
        element.focus();
        await pressEscapeOn(element);
        expect(inDetail()).toBe(true);
      }
    } finally {
      for (const element of editable) element.remove();
    }
  });
});
