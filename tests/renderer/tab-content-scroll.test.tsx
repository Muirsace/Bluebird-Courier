// @vitest-environment happy-dom
import { readRendererStyles } from './support/styles';
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
 * 切 Tab 的滚动归属验收：**条件式**落位。
 *
 * 判定依据是"用户触发切换那一刻 Tabs 是否已经吸附"（真实吸附状态，不是 scrollY 阈值）：
 *   未吸附（页面还在顶部 / 只是轻微滚动）→ 原地换内容，window.scrollY 一点不动，
 *                                          Repository Header 继续可见；
 *   已吸附（用户已经滚到 Tab 深处）        → 落到 Tab Content 起点（Sticky Tabs 下沿 + 8px）。
 *
 * happy-dom 没有布局引擎，所以不写像素断言：桩住 `Element.prototype.scrollIntoView` 记录
 * "滚的是谁、什么参数、调用了几次"，用假 IntersectionObserver 驱动吸附状态。
 */
let view: RenderResult | null = null;
let realScrollIntoView: typeof Element.prototype.scrollIntoView;
let scrollIntoViewCalls: Array<{ target: Element; options: ScrollIntoViewOptions | undefined }> = [];
let realScrollTo: typeof window.scrollTo;
let scrollCalls: ScrollToOptions[] = [];

beforeEach(() => {
  realScrollIntoView = Element.prototype.scrollIntoView;
  scrollIntoViewCalls = [];
  Element.prototype.scrollIntoView = function scrollIntoView(
    this: Element,
    options?: boolean | ScrollIntoViewOptions,
  ): void {
    scrollIntoViewCalls.push({
      target: this,
      options: typeof options === 'object' ? options : undefined,
    });
  };
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
  Element.prototype.scrollIntoView = realScrollIntoView;
  window.scrollTo = realScrollTo;
  document.documentElement.scrollTop = 0;
  resetSystemTheme();
  resetReducedMotion();
});

// ---------- 吸附状态：假 IntersectionObserver ----------

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

/** 只挑出 Tabs 吸附哨兵那一个观察器（详情里还有"当前仓库"上下文那个）。 */
function tabsRecord(records: ObserverRecord[]): ObserverRecord {
  const record = records.find((item) =>
    item.targets[0]?.className.includes('detail-tabs-sentinel'),
  );
  if (!record) throw new Error('没有创建 Tabs 吸附观察器');
  return record;
}

/** isIntersecting=false 就是哨兵越过视口顶端 = Tabs 已吸附。 */
async function setStuck(record: ObserverRecord | undefined, stuck: boolean): Promise<void> {
  if (!record) throw new Error('没有创建吸附观察器');
  await act(async () => {
    record.callback([{ isIntersecting: !stuck } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
  await settle();
}

// ---------- 装置 ----------

async function mount(repositories: Glance[] = [makeGlance(1, 'octocat/Hello-World')]): Promise<void> {
  view = await renderApp(createStub({ repositories }));
  await settle();
}

async function openDetail(fullName = 'octocat/Hello-World'): Promise<void> {
  await click(repoOpenButton(fullName));
  await settle();
}

/** 当前 Tab 内容的起点：吸附状态下切 Tab 的滚动落点就是它。 */
function anchor(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.detail-tab-content-anchor');
}

/** 只统计"滚内容起点"这件事，别的滚动调用（例如导航收尾）不算。 */
function contentResets(): Array<{ target: Element; options: ScrollIntoViewOptions | undefined }> {
  // 按类名而不是节点身份过滤：详情重挂后 anchor 是另一个节点，身份比较会漏掉上一次的调用
  return scrollIntoViewCalls.filter((call) =>
    (call.target as HTMLElement).classList?.contains('detail-tab-content-anchor'),
  );
}

function activeTabLabel(): string | null {
  return (
    document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.textContent?.trim() ??
    null
  );
}

function panelId(): string | null {
  return document.querySelector('[role="tabpanel"]')?.id ?? null;
}

async function switchTab(label: string): Promise<void> {
  await click(tab(label));
  await settle();
}

async function pressArrowRight(): Promise<void> {
  const current = document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
  current?.focus();
  await act(async () => {
    current?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

/** 假 ResizeObserver：happy-dom 的真件从不回调，这里手动驱动"尺寸变化后重新测量"。 */
function installFakeResizeObserver(): { callbacks: ResizeObserverCallback[]; restore: () => void } {
  const original = window.ResizeObserver;
  const callbacks: ResizeObserverCallback[] = [];
  class FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  return {
    callbacks,
    restore: () => {
      (window as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
    },
  };
}

async function fireResize(callbacks: ResizeObserverCallback[]): Promise<void> {
  await act(async () => {
    for (const callback of callbacks) callback([], {} as ResizeObserver);
  });
  await settle();
}

// ---------- 未吸附：原地换内容 ----------

describe('Tabs 未吸附 · 切 Tab 不动滚动', () => {
  it('页面还在顶部时切 Tab：只换内容，不把 Repository Header 滚走', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      // 刚进详情：哨兵在视口内 → 未吸附
      expect(anchor()).not.toBeNull();

      await switchTab('发版');

      expect(activeTabLabel()).toBe('发版');
      expect(panelId()).toBe('detail-panel-releases');
      expect(contentResets()).toHaveLength(0);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('轻微滚动、Tabs 仍未吸附时切 Tab：保持当前 scrollY', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      document.documentElement.scrollTop = 120;

      await switchTab('提交');

      expect(contentResets()).toHaveLength(0);
      expect(document.documentElement.scrollTop).toBe(120);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('从吸附态滚回顶部后再切：又回到"不滚动"', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await setStuck(tabsRecord(records), true);
      document.documentElement.scrollTop = 900;
      await switchTab('发版');
      expect(contentResets()).toHaveLength(1);

      // 用户自己滚回顶部：哨兵重新进入视口 → 未吸附
      document.documentElement.scrollTop = 0;
      await setStuck(tabsRecord(records), false);
      await switchTab('提交');

      expect(contentResets()).toHaveLength(1);
      expect(document.documentElement.scrollTop).toBe(0);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('键盘切 Tab（未吸附）同样原地换内容', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();

      await pressArrowRight();

      expect(activeTabLabel()).toBe('发版');
      expect(contentResets()).toHaveLength(0);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });
});

// ---------- 已吸附：落到内容起点 ----------

describe('Tabs 已吸附 · 切 Tab 落到内容起点', () => {
  it('滚到深处（已吸附）切 Tab：落到 Tab Content 起点，一次、瞬时', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await setStuck(tabsRecord(records), true);
      document.documentElement.scrollTop = 900;

      await switchTab('发版');

      expect(activeTabLabel()).toBe('发版');
      expect(contentResets()).toHaveLength(1);
      const options = contentResets()[0]?.options;
      expect(options?.block).toBe('start');
      expect(options?.behavior).toBe('auto');
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('连续切多个 Tab：每次切换各落位一次', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await setStuck(tabsRecord(records), true);

      await switchTab('发版');
      await switchTab('提交');
      await switchTab('趋势');

      expect(activeTabLabel()).toBe('趋势');
      expect(contentResets()).toHaveLength(3);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('键盘切 Tab（已吸附）与鼠标落点一致', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await setStuck(tabsRecord(records), true);

      await pressArrowRight();

      expect(activeTabLabel()).toBe('发版');
      expect(contentResets()).toHaveLength(1);
      expect(contentResets()[0]?.options?.behavior).toBe('auto');
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('切完 Tab 之后哨兵才翻转：不会再补一次落位', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();

      // 未吸附时切 Tab：原地换内容，这一次确实"激活"过
      await switchTab('发版');
      expect(contentResets()).toHaveLength(0);

      // 用户随后自己往下滚 → Tabs 吸附
      await setStuck(tabsRecord(records), true);

      // 吸附状态翻转本身不是切 Tab：不能因为它变了就补滚一次
      expect(contentResets()).toHaveLength(0);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('判定用的是"点下去那一刻"的吸附状态：同一次批处理里翻转也不会漏掉落位', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await setStuck(tabsRecord(records), true);

      // 长 Tab → 短 Tab：重排可能把哨兵又推回视口（isIntersecting=true = 不再吸附）。
      // 这里让"状态翻转"与"激活"落在同一次批处理里：该不该落位由点下去那一刻决定，
      // 不能等 commit 之后再拿新状态去判断。
      await act(async () => {
        tabsRecord(records)?.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
        tab('发版')?.click();
      });
      await settle();

      expect(activeTabLabel()).toBe('发版');
      expect(contentResets()).toHaveLength(1);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('标记读完就清掉：之后的无关重渲染不会再滚一次', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await setStuck(tabsRecord(records), true);
      await switchTab('发版');
      expect(contentResets()).toHaveLength(1);

      await click(buttonByText('重新抓取'));
      await settle();
      await act(async () => {
        setSystemTheme('dark');
      });
      await settle();

      expect(contentResets()).toHaveLength(1);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });
});

// ---------- 空操作 ----------

describe('点击当前已选中的 Tab · 空操作', () => {
  it('未吸附与已吸附两种状态下都不滚动、不重挂', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await switchTab('发版');
      const panel = document.querySelector('[role="tabpanel"]');

      await switchTab('发版');
      expect(contentResets()).toHaveLength(0);
      expect(document.querySelector('[role="tabpanel"]')).toBe(panel);

      await setStuck(tabsRecord(records), true);
      await switchTab('发版');

      expect(contentResets()).toHaveLength(0);
      expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });
});

// ---------- 与导航无关的变化 ----------

describe('切 Tab 之外的变化一律不落位', () => {
  it('进入详情不算切 Tab：页面仍从顶部开始', async () => {
    installFakeObserver();
    try {
      await mount();
      document.documentElement.scrollTop = 687;

      await openDetail();

      expect(contentResets()).toHaveLength(0);
      expect(scrollCalls[scrollCalls.length - 1]).toEqual({ top: 0, behavior: 'auto' });
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('抓取完成、数据到达（Query 更新）不落位', async () => {
    installFakeObserver();
    try {
      const handle = createStub({ repositories: [makeGlance(1, 'octocat/Hello-World')] });
      const release = handle.holdNextDetail();
      view = await renderApp(handle);
      await settle();

      await openDetail();
      expect(anchor()).toBeNull();

      await act(async () => {
        release();
      });
      await settle();

      expect(document.querySelector('[role="tabpanel"]')).not.toBeNull();
      expect(contentResets()).toHaveLength(0);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('重新抓取不落位（即使正处于吸附态）', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await setStuck(tabsRecord(records), true);

      await click(buttonByText('重新抓取'));
      await settle();

      expect(contentResets()).toHaveLength(0);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('主题切换不落位（即使正处于吸附态）', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await setStuck(tabsRecord(records), true);

      await act(async () => {
        setSystemTheme('dark');
      });
      await settle();

      expect(contentResets()).toHaveLength(0);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('窗口尺寸变化（重新测量 / 吸附状态可能翻转）不落位', async () => {
    const fake = installFakeResizeObserver();
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await switchTab('发版');
      const before = contentResets().length;

      await fireResize(fake.callbacks);
      await setStuck(tabsRecord(records), true);
      await fireResize(fake.callbacks);

      expect(contentResets()).toHaveLength(before);
      expect(activeTabLabel()).toBe('发版');
    } finally {
      fake.restore();
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });
});

// ---------- 与其它滚动规则协同 ----------

describe('与其它滚动规则协同', () => {
  it('Esc 返回仍恢复进详情前的清单位置', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      document.documentElement.scrollTop = 687;
      await openDetail();
      await setStuck(tabsRecord(records), true);
      await switchTab('提交');

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await settle();

      expect(window.scrollY).toBe(687);
      expect(scrollCalls[scrollCalls.length - 1]).toEqual({ top: 687, behavior: 'auto' });
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('返回清单后再进详情：仍从页面顶部开始，且不残留上次的落位标记', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      document.documentElement.scrollTop = 300;
      await openDetail();
      await setStuck(tabsRecord(records), true);
      await switchTab('发版');

      await click(buttonByText('← 返回监控清单'));
      await settle();
      expect(document.documentElement.scrollTop).toBe(300);

      await openDetail();
      expect(document.documentElement.scrollTop).toBe(0);
      expect(contentResets()).toHaveLength(1);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('Reduced Motion 不改变条件规则：仍是瞬时落位', async () => {
    setReducedMotion(true);
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      await switchTab('发版');
      expect(contentResets()).toHaveLength(0);

      await setStuck(tabsRecord(records), true);
      await switchTab('提交');

      expect(contentResets()).toHaveLength(1);
      expect(contentResets()[0]?.options?.behavior).toBe('auto');
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('切 Tab 不是页面导航：导航层（window.scrollTo）不参与', async () => {
    const records = installFakeObserver();
    try {
      await mount();
      await openDetail();
      const before = scrollCalls.length;

      await switchTab('趋势');
      await setStuck(tabsRecord(records), true);
      await switchTab('趋势');

      expect(scrollCalls).toHaveLength(before);
      expect(navButton('监控清单')).toBeNull();
      expect(navButton('设置')?.getAttribute('aria-current')).toBeNull();
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });
});

// ---------- 落点的结构与样式不变量 ----------

describe('落点的结构与样式不变量', () => {
  it('anchor 是 tabpanel 外面的一层普通 div：不放 role / tabIndex，也不复制 Tabs', async () => {
    installFakeObserver();
    try {
      await mount();
      await openDetail();

      const node = anchor();
      expect(node).not.toBeNull();
      expect(node?.tagName).toBe('DIV');
      expect(node?.getAttribute('role')).toBeNull();
      expect(node?.getAttribute('tabindex')).toBeNull();
      expect(node?.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
      expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
      expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
      expect(document.querySelectorAll('.detail-tabs-sentinel')).toHaveLength(1);
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it('样式表：落点 = 顶部栏 + Tabs 两个实测高度 + 安全间距，且不做滚动动画', () => {
    const css = readRendererStyles().replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );

    const rule = css.match(/\.detail-tab-content-anchor\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('scroll-margin-top');
    expect(rule).toContain('var(--app-header-height');
    expect(rule).toContain('var(--detail-tabs-height');
    // 短 Tab 也得有落点：内容比一屏矮时，没有这段最小高度文档就滚不动
    expect(rule).toContain('min-height');
    expect(rule).toContain('100vh');
    // 落点本身是布局行为：不带过渡、不做动画，也不自己写位移
    expect(rule).not.toContain('transition');
    expect(rule).not.toContain('animation');
    expect(rule).not.toContain('transform');
    // 全局禁用平滑滚动：滚动策略只有"瞬时"一种
    expect(css).not.toContain('smooth');
  });

  it('Tabs 高度由实测写成 CSS 变量（落点偏移的唯一来源之一）', async () => {
    installFakeObserver();
    try {
      await mount();
      await openDetail();
      // happy-dom 没有布局，量到 0px 也算数：这里断言的是"接线"
      expect(document.documentElement.style.getPropertyValue('--detail-tabs-height')).not.toBe('');
    } finally {
      delete (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });
});
