// @vitest-environment happy-dom
import { readRendererStyles } from './support/styles';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  resetReducedMotion,
  resetSystemTheme,
  setReducedMotion,
  setSystemTheme,
  settle,
  tab,
} from './helpers';

/**
 * Compact Repository Context 验收：Repository Header 滚出视口后，顶部栏在品牌右侧接管仓库名。
 *
 * happy-dom 没有布局引擎，所以不测像素：用假 IntersectionObserver 直接投递比值，
 * 只断言"什么状态下显示 / 隐藏、显示什么文本、结构是否稳定、样式表里的运动是否只碰 opacity/X"。
 * 真实几何（顶部栏高度、导航是否被推动、省略号）由渲染层人工核对。
 */
let view: RenderResult | null = null;

beforeEach(() => {
  document.documentElement.scrollTop = 0;
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  document.documentElement.scrollTop = 0;
  resetSystemTheme();
  resetReducedMotion();
  delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

// ---------- 吸附 / 上下文哨兵：假观察器 ----------

interface ObserverRecord {
  callback: IntersectionObserverCallback;
  targets: Element[];
  thresholds: number[];
  disconnected: boolean;
}

function installFakeObserver(): ObserverRecord[] {
  const records: ObserverRecord[] = [];
  class FakeIntersectionObserver {
    root = null;
    rootMargin = '0px';
    thresholds: number[];
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      const thresholds = options?.threshold;
      this.thresholds = Array.isArray(thresholds) ? thresholds : thresholds === undefined ? [0] : [thresholds];
      records.push({ callback, targets: [], thresholds: this.thresholds, disconnected: false });
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

/** 取最后一个"当前仓库上下文"哨兵的观察器（进出详情会重建，旧的仍在数组里）。 */
function contextRecord(records: ObserverRecord[]): ObserverRecord {
  const matched = records.filter((item) =>
    item.targets[0]?.className.includes('repo-context-sentinel'),
  );
  const record = matched[matched.length - 1];
  if (!record) throw new Error('没有创建当前仓库上下文的观察器');
  return record;
}

/** 投递一个比值：0 = 哨兵整体滚出视口顶端（表头走了）；1 = 完整在视口里（表头还在）。 */
async function setRatio(record: ObserverRecord, ratio: number): Promise<void> {
  await act(async () => {
    record.callback(
      [{ intersectionRatio: ratio, isIntersecting: ratio > 0 } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
  await settle();
}

// ---------- 装置 ----------

function contextEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.compact-repo-context');
}

function contextName(): string {
  return contextEl()?.querySelector('[title]')?.getAttribute('title') ?? '';
}

/** data-visible：true = 顶部栏正在接管仓库名。 */
function visibleState(): string | null {
  return contextEl()?.dataset.visible ?? null;
}

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

describe('Compact Context · 显示条件', () => {
  it('刚进详情：表头还在顶部，顶部栏不显示仓库名', async () => {
    const records = installFakeObserver();
    await mount();
    await openDetail();

    expect(contextEl()).not.toBeNull();
    expect(visibleState()).toBe('false');
    // 文本早已是当前仓库（不是等到滚动才填），只是还不可见
    expect(contextName()).toBe('octocat/Hello-World');
    // 初始这次投递：哨兵完整在视口里 → 保持隐藏
    expect(contextRecord(records).targets[0]?.className).toContain('repo-context-sentinel');
  });

  it('表头整体滚出视口：顶部栏接管仓库名', async () => {
    const records = installFakeObserver();
    await mount();
    await openDetail();

    await setRatio(contextRecord(records), 0);

    expect(visibleState()).toBe('true');
    expect(contextEl()?.getAttribute('aria-hidden')).toBeNull();
  });

  it('滚回顶部、表头重新露头：交还给它', async () => {
    const records = installFakeObserver();
    await mount();
    await openDetail();
    await setRatio(contextRecord(records), 0);
    expect(visibleState()).toBe('true');

    await setRatio(contextRecord(records), 1);

    expect(visibleState()).toBe('false');
    expect(contextEl()?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Compact Context · 迟滞', () => {
  it('观察器同时盯着两个边界（[0, 1]），才有迟滞可言', async () => {
    const records = installFakeObserver();
    await mount();
    await openDetail();

    const { thresholds } = contextRecord(records);
    expect(thresholds).toContain(0);
    expect(thresholds).toContain(1);
  });

  it('临界带里（0 < ratio < 1）保持现状：显示的不隐藏', async () => {
    const records = installFakeObserver();
    await mount();
    await openDetail();
    await setRatio(contextRecord(records), 0);

    await setRatio(contextRecord(records), 0.5);

    expect(visibleState()).toBe('true');
  });

  it('临界带里保持现状：隐藏的不显示', async () => {
    const records = installFakeObserver();
    await mount();
    await openDetail();
    await setRatio(contextRecord(records), 1);

    await setRatio(contextRecord(records), 0.5);

    expect(visibleState()).toBe('false');
  });

  it('临界点上下轻滚（0.4 → 0.6 → 0.5）不会翻转', async () => {
    const records = installFakeObserver();
    await mount();
    await openDetail();
    const record = contextRecord(records);
    await setRatio(record, 0);
    const states: Array<string | null> = [];
    for (const ratio of [0.4, 0.6, 0.5, 0.9, 0.2]) {
      await setRatio(record, ratio);
      states.push(visibleState());
    }

    expect(states).toEqual(['true', 'true', 'true', 'true', 'true']);
  });
});

describe('Compact Context · 与页面内导航无关', () => {
  it('切 Tab（鼠标 / 键盘 / 点当前 Tab）都不改变可见性、也不重播', async () => {
    const records = installFakeObserver();
    await mount();
    await openDetail();
    await setRatio(contextRecord(records), 0);
    const node = contextEl();
    expect(visibleState()).toBe('true');

    await click(tab('发版'));
    await settle();
    await click(tab('发版'));
    await settle();
    const active = document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    active?.focus();
    await act(async () => {
      active?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    });
    await settle();

    // 节点与可见性都没被换掉：没有第二次 show，导航上下文保持稳定
    expect(contextEl()).toBe(node);
    expect(visibleState()).toBe('true');
  });

  it('换一个仓库：文本立刻换成新的，并从"隐藏"重新开始', async () => {
    const records = installFakeObserver();
    await mount([makeGlance(1, 'octocat/Hello-World'), makeGlance(2, 'MAA1999/M9A')]);
    await openDetail('octocat/Hello-World');
    await setRatio(contextRecord(records), 0);
    expect(visibleState()).toBe('true');

    await goBack();
    await openDetail('MAA1999/M9A');

    expect(contextName()).toBe('MAA1999/M9A');
    expect(visibleState()).toBe('false');
  });

  it('离开详情：顶部栏里不再有这个上下文', async () => {
    const records = installFakeObserver();
    await mount();
    await openDetail();
    await setRatio(contextRecord(records), 0);
    expect(contextEl()).not.toBeNull();

    await goBack();

    expect(contextEl()).toBeNull();
    expect(document.querySelector('.repo-context-sentinel')).toBeNull();
  });
});

describe('Compact Context · 结构与无障碍', () => {
  it('只是展示：不是按钮 / 链接，也没有 tabIndex 与聚焦目标', async () => {
    installFakeObserver();
    await mount();
    await openDetail();
    const node = contextEl();
    if (!node) throw new Error('没有渲染上下文');

    expect(node.tagName).toBe('DIV');
    expect(node.getAttribute('role')).toBeNull();
    expect(node.getAttribute('tabindex')).toBeNull();
    expect(node.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
    // 分隔符只是装饰
    expect(node.querySelector('.compact-repo-context-divider')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('长名字单行省略，完整名走 title', async () => {
    installFakeObserver();
    const fullName = 'haobahaobaenenen/Bluebird-Code-Courier';
    await mount([makeGlance(1, fullName)]);
    await openDetail(fullName);

    const name = contextEl()?.querySelector('.compact-repo-context-name, span:last-child');
    expect(name?.textContent?.trim()).toBe('Bluebird-Code-Courier · haobahaobaenenen');
    expect(name?.getAttribute('title')).toBe(fullName);
    expect(name?.className).toContain('truncate');
    expect(name?.className).toContain('font-mono');
  });

  it('详情里始终挂载（显隐只改属性），顶部栏的其它元素都还在原位', async () => {
    const records = installFakeObserver();
    await mount();
    await openDetail();
    const node = contextEl();

    await setRatio(contextRecord(records), 0);
    await setRatio(contextRecord(records), 1);
    await setRatio(contextRecord(records), 0);

    // 不卸载节点 → flex 布局里那份占位始终在，品牌 / 导航 / 高度都不会被推动
    expect(contextEl()).toBe(node);
    expect(node?.parentElement?.textContent).toContain('青鸟信使');
    expect(navButton('监控清单')).toBeNull();
    expect(navButton('设置')).not.toBeNull();
    expect(document.querySelectorAll('header nav button')).toHaveLength(1);
    // 上下文不在导航里：它是左侧品牌区的一部分，不占 Tabs 那一行
    expect(document.querySelector('.compact-repo-context')?.closest('nav')).toBeNull();
    expect(node?.closest('[role="tablist"]')).toBeNull();
  });
});

describe('Compact Context · 样式不变量', () => {
  const css = readRendererStyles().replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('只动画 opacity 与 X，绝不动宽度 / 外边距 / 内边距', () => {
    const base = css.match(/\.compact-repo-context\s*\{[^}]*\}/)?.[0] ?? '';
    expect(base).toContain('opacity: 0');
    expect(base).toContain('transform: translateX(-4px)');
    expect(base).toContain('var(--motion-ease-in)');
    expect(base).not.toContain('width');
    expect(base).not.toContain('margin');
    expect(base).not.toContain('padding');
    expect(base).not.toContain('scale');
    expect(base).not.toContain('translateY');

    const shown = css.match(/\.compact-repo-context\[data-visible='true'\]\s*\{[^}]*\}/)?.[0] ?? '';
    expect(shown).toContain('opacity: 1');
    expect(shown).toContain('translateX(0)');
    expect(shown).toContain('var(--motion-ease-out)');
    expect(shown).not.toContain('width');
    expect(shown).not.toContain('scale');
    expect(shown).not.toContain('translateY');
  });

  it('哨兵位置按顶部栏实测高度算，临界判定不靠 scroll 监听', () => {
    const sentinel = css.match(/\.repo-context-sentinel\s*\{[^}]*\}/)?.[0] ?? '';
    expect(sentinel).toContain('position: absolute');
    expect(sentinel).toContain('var(--app-header-height');
    expect(sentinel).toContain('pointer-events: none');

    // 页面里没有为了它加滚动监听：实现只依赖 IntersectionObserver
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/pages/DetailPage.tsx'), 'utf8');
    expect(source).toContain('IntersectionObserver');
    expect(source).not.toContain("addEventListener('scroll'");
  });

  it('Reduced Motion：只留一次极短的透明度变化，不做 X 位移', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    const rule =
      reduced.match(/\.compact-repo-context,\s*\.compact-repo-context\[data-visible='true'\]\s*\{[^}]*\}/)?.[0] ??
      '';
    expect(rule).toContain('transform: none !important');
    expect(rule).toContain('opacity');
    expect(rule).not.toContain('translateX');
  });

  it('Reduced Motion 只降级运动，不改可见性判定', async () => {
    setReducedMotion(true);
    const records = installFakeObserver();
    await mount();
    await openDetail();

    await setRatio(contextRecord(records), 0);
    expect(visibleState()).toBe('true');
    await setRatio(contextRecord(records), 1);
    expect(visibleState()).toBe('false');
  });
});
