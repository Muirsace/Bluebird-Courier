// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommitItem, ReleaseItem } from '../../src/shared/types';
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
  setSystemTheme,
  tab,
} from './helpers';

let view: RenderResult | null = null;

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  resetSystemTheme();
});

function makeRelease(tagName: string): ReleaseItem {
  return { tagName, title: tagName, publishedAt: '2026-09-24T10:00:00.000Z' };
}

function makeCommit(index: number): CommitItem {
  return {
    sha: `${index}7b4f4${index}f0e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6`.slice(0, 40),
    message: `第 ${index} 条提交`,
    authorName: 'Turtle',
    committedAt: '2026-09-24T09:00:00.000Z',
  };
}

async function mount(): Promise<StubHandle> {
  const handle = createStub({
    repositories: [makeGlance(1, 'octocat/Hello-World')],
    detail: { releases: [makeRelease('v9.9.9')], commits: [makeCommit(1)] },
  });
  view = await renderApp(handle);
  await settle();
  return handle;
}

/** 页面切换容器：只有它换节点，Header / 导航 / 背景都在它外面。 */
function transitionNode(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-testid="page-transition"]');
  if (!node) throw new Error('页面切换容器不存在');
  return node;
}

function motionKind(): string | null {
  return transitionNode().dataset.viewMotion ?? null;
}

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="tabpanel"]');
}

async function openDetail(fullName = 'octocat/Hello-World'): Promise<void> {
  await click(repoOpenButton(fullName));
  await settle();
}

async function goBack(): Promise<void> {
  await click(buttonByText('← 返回监控清单'));
  await settle();
}

describe('页面切换 · 顶级导航（监控清单 ↔ 设置）', () => {
  it('两个顶级页仍然互相可达，切换方向是同级', async () => {
    await mount();
    expect(document.body.textContent).toContain('监控清单');
    expect(navButton('设置')).not.toBeNull();
    expect(navButton('监控清单')).toBeNull();
    expect(document.querySelectorAll('header nav button')).toHaveLength(1);
    expect(navButton('设置')?.getAttribute('aria-current')).toBeNull();

    await click(navButton('设置'));
    await settle();
    expect(motionKind()).toBe('top');
    expect(document.body.textContent).toContain('访问令牌');
    expect(navButton('监控清单')).not.toBeNull();
    expect(navButton('设置')).toBeNull();
    expect(document.querySelectorAll('header nav button')).toHaveLength(1);

    await click(navButton('监控清单'));
    await settle();
    expect(motionKind()).toBe('top');
    expect(repoSlot('octocat/Hello-World')).not.toBeNull();
  });

  it('首屏不播切换动画：应用刚起来时容器不带方向', async () => {
    await mount();
    expect(motionKind()).toBeNull();
  });
});

describe('页面切换 · 仓库详情（清单 ↔ 详情）', () => {
  it('进详情是 forward，返回是 back', async () => {
    await mount();
    await openDetail();
    expect(motionKind()).toBe('forward');
    expect(buttonByText('← 返回监控清单')).not.toBeNull();

    await goBack();
    expect(motionKind()).toBe('back');
    expect(repoSlot('octocat/Hello-World')).not.toBeNull();
  });

  it('详情 Header 只提供设置目的地；返回清单继续走页面内 Back', async () => {
    await mount();
    await openDetail();
    expect(navButton('设置')).not.toBeNull();
    expect(navButton('监控清单')).toBeNull();

    await click(navButton('设置'));
    await settle();
    expect(motionKind()).toBe('top');
    expect(navButton('监控清单')).not.toBeNull();
  });

  it('只有内容容器换节点：Header / Logo 在切换前后是同一个节点', async () => {
    await mount();
    const header = document.querySelector('header');
    const brand = document.querySelector('.app-brand-mark');
    const contentBefore = transitionNode();

    await openDetail();
    expect(document.querySelector('header')).toBe(header);
    expect(document.querySelector('.app-brand-mark')).toBe(brand);
    expect(transitionNode()).not.toBe(contentBefore);
  });
});

describe('页面切换 · 刷新与数据更新不重播', () => {
  it('全部刷新不触发导航：容器节点与方向都不变', async () => {
    await mount();
    const node = transitionNode();

    await click(buttonByText('全部刷新'));
    await settle();

    expect(transitionNode()).toBe(node);
    expect(motionKind()).toBeNull();
  });

  it('主题切换不重播页面动画', async () => {
    await mount();
    await openDetail();
    const node = transitionNode();

    await act(async () => {
      setSystemTheme('dark');
    });
    await settle();
    expect(transitionNode()).toBe(node);
    expect(motionKind()).toBe('forward');
  });

  it('重新抓取不重置 activeTab，也不重建 Tab 内容节点', async () => {
    await mount();
    await openDetail();
    await click(tab('发版'));
    await settle();
    expect(panel()?.id).toBe('detail-panel-releases');
    const contentNode = panel();
    const contentClass = contentNode?.className;

    await click(buttonByText('重新抓取'));
    await settle();

    expect(panel()).toBe(contentNode);
    expect(panel()?.className).toBe(contentClass);
    expect(panel()?.id).toBe('detail-panel-releases');
    expect(tab('发版')?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('页面切换 · 详情 Tab', () => {
  it('切 Tab 换的是内容，激活态与 aria 关系跟着走', async () => {
    await mount();
    await openDetail();
    expect(panel()?.id).toBe('detail-panel-overview');
    expect(tab('概览')?.getAttribute('aria-selected')).toBe('true');

    await click(tab('发版'));
    await settle();
    expect(panel()?.id).toBe('detail-panel-releases');
    expect(tab('发版')?.getAttribute('aria-selected')).toBe('true');
    expect(tab('概览')?.getAttribute('aria-selected')).toBe('false');
    expect(panel()?.getAttribute('aria-labelledby')).toBe('detail-tab-releases');
    expect(panel()?.textContent).toContain('v9.9.9');
  });

  it('键盘左右 / Home / End 仍然工作', async () => {
    await mount();
    await openDetail();
    await click(tab('发版'));
    await settle();

    const pressOnTab = async (id: string, key: string): Promise<void> => {
      const button = document.querySelector<HTMLButtonElement>(`#detail-tab-${id}`);
      if (!button) throw new Error(`Tab ${id} 未渲染`);
      await act(async () => {
        button.focus();
        button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
      await settle();
    };

    await pressOnTab('releases', 'ArrowRight');
    expect(document.activeElement?.id).toBe('detail-tab-commits');
    expect(panel()?.id).toBe('detail-panel-commits');

    await pressOnTab('commits', 'End');
    expect(document.activeElement?.id).toBe('detail-tab-trend');

    await pressOnTab('trend', 'Home');
    expect(document.activeElement?.id).toBe('detail-tab-overview');
  });

  it('内容进场层只属于切 Tab：首屏交给揭示，切一次才挂上（indicator 量到几何才渲染）', async () => {
    await mount();
    await openDetail();
    // 首屏由 Detail Reveal 的 Section 错峰带进来，不叠 tab-panel-enter；
    // 归位瞬间才补类名的话，浏览器会把已挂载的面板从 opacity 0 重播一次（闪一下）
    expect(panel()?.className).not.toContain('tab-panel-enter');
    expect(document.querySelector('.tab-indicator')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(6);

    await click(tab('发版'));
    await settle();
    expect(panel()?.className).toContain('tab-panel-enter');
  });

  /**
   * 不变量：横滑条必须关掉块轴溢出。
   * overflow-x-auto 会把 overflow-y 也算成 auto，于是按 Tab 时那 1px 位移就成了块轴溢出，
   * 条里冒出一条竖向滚动条并把内容宽度挤掉 9px（真实浏览器实测，happy-dom 测不出布局）。
   */
  it('横滑条关掉块轴溢出：按下 Tab 不会在条里冒出滚动条', async () => {
    await mount();
    await openDetail();
    expect(document.querySelector('[role="tablist"]')?.className).toContain('overflow-y-hidden');
  });

  it('点击「提交」同样切到提交内容', async () => {
    await mount();
    await openDetail();

    await click(tab('提交'));
    await settle();
    expect(panel()?.id).toBe('detail-panel-commits');
    expect(tab('提交')?.getAttribute('aria-selected')).toBe('true');
    expect(panel()?.className).toContain('tab-panel-enter');
  });

  /**
   * 不变量：选中态没变就什么都不做。
   * 首屏的 tabContentSwitched 还是 null，若照直写下去，点一下当前的「概览」就会把它翻成
   * 'overview'，给已经挂载的面板补上 tab-panel-enter，当场重播一次内容进场。
   */
  it('点当前的 Tab 不重播内容进场', async () => {
    await mount();
    await openDetail();

    const first = panel();
    expect(first?.className).not.toContain('tab-panel-enter');
    await click(tab('概览'));
    await settle();
    expect(panel()).toBe(first);
    expect(panel()?.className).not.toContain('tab-panel-enter');

    await click(tab('发版'));
    await settle();
    const switched = panel();
    expect(switched?.className).toContain('tab-panel-enter');

    await click(tab('发版'));
    await settle();
    expect(panel()).toBe(switched);
    expect(panel()?.className).toContain('tab-panel-enter');
    expect(panel()?.id).toBe('detail-panel-releases');
  });

  it('切 Tab 只是同一份数据的本地视图：不产生任何抓取', async () => {
    const handle = await mount();
    await openDetail();
    const before = handle.calls.fetchDetail;

    for (const label of ['发版', '提交', 'Issue & PR', '构建', '趋势', '概览']) {
      await click(tab(label));
      await settle();
    }

    expect(handle.calls.fetchDetail).toBe(before);
    expect(handle.calls.refreshGlance).toBe(0);
  });

  it('主题切换不改变 activeTab，也不重播内容进场', async () => {
    await mount();
    await openDetail();
    await click(tab('发版'));
    await settle();
    const node = panel();

    await act(async () => {
      setSystemTheme('dark');
    });
    await settle();

    expect(panel()).toBe(node);
    expect(panel()?.id).toBe('detail-panel-releases');
    expect(panel()?.className).toContain('tab-panel-enter');
    expect(tab('发版')?.getAttribute('aria-selected')).toBe('true');
  });

  /**
   * 不变量：Tab 内容**不许**从透明淡入，也**不许**做重位移。
   *
   * 整块内容区在整段动画里半透明，就是浅色主题下"白卡消失、灰底露出来"的那次闪——
   * 起手必须接近最终透明度（或干脆不写 opacity），落位感只由那两三像素的 Y 提供。
   * 这里只卡区间不卡死数值：改时长/改位移幅度都行，改回全透明淡入或大位移就红。
   */
  it('内容进场不淡入：起手接近不透明，位移只有几像素', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );

    const rule = css.match(/\.tab-panel-enter\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('tab-panel-soft-enter');
    expect(rule).not.toContain('transition-all');
    const duration = Number(rule.match(/(\d+)ms/)?.[1]);
    expect(duration).toBeGreaterThanOrEqual(100);
    expect(duration).toBeLessThanOrEqual(200);

    const from = css.match(/@keyframes tab-panel-soft-enter\s*\{\s*from\s*\{[^}]*\}/)?.[0] ?? '';
    expect(from).not.toBe('');
    const opacity = from.match(/opacity:\s*([\d.]+)/);
    if (opacity) expect(Number(opacity[1])).toBeGreaterThanOrEqual(0.9);
    const shift = Math.abs(Number(from.match(/translateY\((-?[\d.]+)px\)/)?.[1]));
    expect(shift).toBeGreaterThan(0);
    expect(shift).toBeLessThanOrEqual(4);
  });
});

describe('页面切换 · 返回清单不重播卡片动画', () => {
  it('已存在的卡片回来时直接显示，不重新进场也不再高亮', async () => {
    await mount();
    await openDetail();
    await goBack();

    const slot = repoSlot('octocat/Hello-World');
    expect(slot?.dataset.motion).toBe('idle');
    expect(slot?.dataset.highlight).toBeUndefined();
    expect(document.querySelectorAll('main ul > li')).toHaveLength(1);
  });
});

describe('页面切换 · Reduced Motion 降级机制', () => {
  /**
   * 这一层是纯 CSS 动画，JS 侧没有开关可测，所以这里只断言降级规则确实还在样式表里：
   * 位移全部关掉、indicator 立即落位。真实引擎下的表现由验证台人工核对。
   */
  it('样式表在 prefers-reduced-motion 下关掉位移与过渡', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles.css'), 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));

    expect(reduced).toContain('.view-transition');
    expect(reduced).toContain('.tab-panel-enter');
    expect(reduced).toContain('.tab-indicator');
    expect(reduced).toContain('animation: none');
    expect(reduced).toContain('transition: none');
  });
});
