// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlanceFact } from '../../src/renderer/components/GlanceFact';
import { RepositoryHeader } from '../../src/renderer/components/detail/RepositoryHeader';
import { DETAIL_REVEAL_TOTAL_MS } from '../../src/renderer/lib/motion';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  buttonByText,
  click,
  createStub,
  factSwaps,
  loadingSlot,
  makeGlance,
  renderApp,
  renderNode,
  repoOpenButton,
  resetReducedMotion,
  resetSystemTheme,
  revealPhase,
  setReducedMotion,
  setSystemTheme,
  settle,
  settleMotion,
  tab,
} from './helpers';

const FIRST = 'octocat/Hello-World';
/** 揭示窗口 + 余量：正模式下组件就是靠这段虚拟时间把 revealing 收成 ready 的。 */
const REVEAL_WINDOW = DETAIL_REVEAL_TOTAL_MS + 200;

let handle: StubHandle;
let view: RenderResult | null = null;

beforeEach(() => {
  // 动画窗口由测试推进的虚拟时间决定，真实耗时不影响 revealing / ready 的观测
  vi.useFakeTimers();
});

afterEach(async () => {
  if (view) {
    await view.unmount();
    view = null;
  }
  resetReducedMotion();
  resetSystemTheme();
  vi.useRealTimers();
});

async function mount(options: StubOptions = {}): Promise<void> {
  handle = createStub({ repositories: [makeGlance(1, FIRST)], ...options });
  view = await renderApp(handle);
  await settle();
}

/** 点开详情。返回值用来放行被挂起的抓取（模拟"数据到达"）。 */
async function openDetail(): Promise<() => void> {
  const release = handle.holdNextDetail();
  await click(repoOpenButton(FIRST));
  await settle();
  return release;
}

async function finishReveal(): Promise<void> {
  await settleMotion(REVEAL_WINDOW);
}

describe('详情揭示 · 首次抓取', () => {
  it('抓取中只有 Loading；数据到达那一帧换成完整详情，没有空白帧', async () => {
    await mount();
    const release = await openDetail();

    expect(revealPhase()).toBe('loading');
    expect(loadingSlot()?.dataset.state).toBe('visible');
    expect(document.body.textContent).toContain('正在抓取全量信息…');
    expect(document.querySelector('[role="tabpanel"]')).toBeNull();
    // 指标还是占位符
    expect(document.body.textContent).not.toContain('1,001');

    release();
    await settle();

    // 真内容在同一帧挂载，Loading 只是同时原地淡出
    expect(revealPhase()).toBe('revealing');
    expect(loadingSlot()?.dataset.state).toBe('exiting');
    expect(document.querySelector('[role="tabpanel"]')?.id).toBe('detail-panel-overview');
    expect(document.body.textContent).toContain('1,001');
    expect(document.body.textContent).toContain('正在抓取全量信息…');

    // 窗口走完：Loading 卡卸掉，揭示阶段收起
    await finishReveal();
    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
    expect(factSwaps()).toHaveLength(0);
  });

  it('表头不换结构：揭示前后是同一个节点，指标从占位符淡换到真实值', async () => {
    await mount();
    const release = await openDetail();

    const title = document.querySelector('h1');
    const back = buttonByText('← 返回监控清单');
    expect(factSwaps()).toHaveLength(0);

    release();
    await settle();

    expect(document.querySelector('h1')).toBe(title);
    expect(buttonByText('← 返回监控清单')).toBe(back);
    // 四条指标各自把 `—` 放进不占位的旧值层里淡出，真值原位淡入
    const layers = factSwaps();
    expect(layers).toHaveLength(4);
    for (const layer of layers) {
      expect(layer.getAttribute('aria-hidden')).toBe('true');
      expect(layer.textContent).toBe('—');
      expect(layer.className).toContain('absolute');
    }

    await finishReveal();
    expect(factSwaps()).toHaveLength(0);
    expect(document.body.textContent).toContain('1,001');
  });

  it('抓取只发生一次，揭示本身不额外发请求', async () => {
    await mount();
    const release = await openDetail();
    expect(handle.calls.fetchDetail).toBe(1);

    release();
    await settle();
    await finishReveal();

    expect(handle.calls.fetchDetail).toBe(1);
  });

  it('默认 Tab 仍是概览，键盘与点击都不受影响', async () => {
    await mount();
    (await openDetail())();
    await settle();

    // 动画还在播的时候界面就该是可用、可交互的
    expect(tab('概览')?.getAttribute('aria-selected')).toBe('true');
    await click(tab('发版'));
    await settle();
    expect(document.querySelector('[role="tabpanel"]')?.id).toBe('detail-panel-releases');
  });

  it('揭示收起时不会给已挂载的面板补上内容进场（否则会当场重播一次、闪一下）', async () => {
    await mount();
    (await openDetail())();
    await settle();
    expect(revealPhase()).toBe('revealing');

    const panel = document.querySelector('[role="tabpanel"]');
    expect(panel?.className).not.toContain('tab-panel-enter');

    await finishReveal();
    expect(revealPhase()).toBe('ready');
    // 同一个节点、同一个类名：类名若在归位那一帧被补上，浏览器会立刻从 opacity 0 重播一次
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    expect(panel?.className).not.toContain('tab-panel-enter');

    // 真正切 Tab 时才挂动画层
    await click(tab('发版'));
    await settle();
    expect(document.querySelector('[role="tabpanel"]')?.className).toContain('tab-panel-enter');
  });
});

describe('详情揭示 · 只播一次', () => {
  it('手动重新抓取：旧数据继续显示，不回到 Loading 也不重播', async () => {
    await mount();
    (await openDetail())();
    await settle();
    await finishReveal();
    expect(revealPhase()).toBe('ready');

    const panel = document.querySelector('[role="tabpanel"]');
    const release = handle.holdNextDetail();
    await click(buttonByText('重新抓取'));
    await settle();

    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    expect(document.body.textContent).toContain('正在更新…');

    release();
    await settle();

    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
    expect(handle.calls.fetchDetail).toBe(2);
  });

  it('切 Tab 不重播揭示', async () => {
    await mount();
    (await openDetail())();
    await settle();
    await finishReveal();

    await click(tab('发版'));
    await settle();

    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
    expect(factSwaps()).toHaveLength(0);
    expect(document.querySelector('[role="tabpanel"]')?.id).toBe('detail-panel-releases');
  });

  it('换主题不重播揭示', async () => {
    await mount();
    (await openDetail())();
    await settle();
    await finishReveal();

    await act(async () => {
      setSystemTheme('dark');
    });
    await settle();

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
  });

  it('缓存命中重进：首帧就是最终状态，不补播一次', async () => {
    await mount();
    (await openDetail())();
    await settle();
    await finishReveal();

    await click(buttonByText('← 返回监控清单'));
    await settle();
    await click(repoOpenButton(FIRST));
    await settle();

    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
    expect(factSwaps()).toHaveLength(0);
    expect(document.querySelector('[role="tabpanel"]')?.id).toBe('detail-panel-overview');
    expect(handle.calls.fetchDetail).toBe(1);
  });
});

describe('详情揭示 · 失败与降级', () => {
  it('首次抓取失败：不误进 Ready，保持错误与重试语义', async () => {
    await mount({ detailFails: true });
    await click(repoOpenButton(FIRST));
    await settle();

    expect(revealPhase()).toBe('loading');
    expect(loadingSlot()).toBeNull();
    expect(document.querySelector('[role="tabpanel"]')).toBeNull();
    expect(document.body.textContent).toContain('抓取全量信息失败');
    expect(document.body.textContent).toContain('暂无全量信息');
  });

  it('prefers-reduced-motion：数据到达直接就是最终状态，没有 revealing 阶段', async () => {
    setReducedMotion(true);
    await mount();
    const release = await openDetail();

    expect(revealPhase()).toBe('loading');
    expect(loadingSlot()?.dataset.state).toBe('visible');

    release();
    await settle();

    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
    expect(factSwaps()).toHaveLength(0);
    expect(document.body.textContent).toContain('1,001');
  });

  it('样式表：揭示只用 opacity / transform，且降级规则齐全', () => {
    // 去掉注释再切片：注释里会提到 tab-panel-enter（说明"为什么不能抑制它"），那是文字不是规则
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const reveal = css.slice(css.indexOf('.detail-reveal {'), css.indexOf('@keyframes detail-item-reveal'));
    const keyframes = css.slice(
      css.indexOf('@keyframes detail-item-reveal'),
      css.indexOf('@keyframes detail-fact-out'),
    );

    expect(reveal).not.toContain('transition-all');
    expect(reveal).toContain('animation: detail-item-reveal var(--reveal-ms, 200ms) var(--motion-ease-out)');
    expect(reveal).toContain('var(--motion-ease-in)');
    // 揭示块里不能出现对 tab-panel-enter 的抑制：那条规则失效的瞬间会把已挂载的面板重播一次
    expect(reveal).not.toContain('tab-panel-enter');

    // 没有宽度 / 高度补间，也没有模糊
    expect(keyframes).not.toContain('width');
    expect(keyframes).not.toContain('height');
    expect(keyframes).not.toContain('filter');
    expect(keyframes).not.toContain('blur');

    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.detail-reveal-item');
    expect(reduced).toContain('.detail-fact-from');
    expect(reduced).toContain('animation: none !important');
  });
});

describe('详情揭示 · 表头细节', () => {
  it('指标交叉淡化：旧值层绝对定位不占位，真值仍在文档流里', async () => {
    handle = createStub();
    view = await renderNode(
      handle,
      <RepositoryHeader
        fullName={FIRST}
        repository={makeGlance(1, FIRST)}
        fetching={false}
        revealing
        onBack={() => {}}
        onRefetch={() => {}}
      />,
    );
    await settle();

    const layers = factSwaps();
    expect(layers).toHaveLength(4);
    for (const layer of layers) {
      expect(layer.className).toContain('absolute');
      expect(layer.className).toContain('whitespace-nowrap');
    }
    expect(document.body.textContent).toContain('1,001');
    expect(document.body.textContent).toContain('v1.0.1');
  });

  it('不给揭示窗口时就是普通展示，没有旧值层', async () => {
    handle = createStub();
    view = await renderNode(
      handle,
      <RepositoryHeader
        fullName={FIRST}
        repository={makeGlance(1, FIRST)}
        fetching={false}
        revealing={false}
        onBack={() => {}}
        onRefetch={() => {}}
      />,
    );
    await settle();

    expect(factSwaps()).toHaveLength(0);
  });

  it('crossfadeFrom 与当前值相同时不淡化', async () => {
    handle = createStub();
    view = await renderNode(handle, <GlanceFact label="Stars" value="—" crossfadeFrom="—" />);
    await settle();

    expect(factSwaps()).toHaveLength(0);
    expect(document.body.textContent).toContain('—');
  });

  it('抓取按钮：文案在两种状态间切换，宽度由 min-width 兜住', async () => {
    await mount();
    const release = await openDetail();

    const busy = buttonByText('抓取中…');
    expect(busy).not.toBeNull();
    expect(busy?.disabled).toBe(true);
    expect(busy?.className).toContain('min-w-[6.5rem]');

    release();
    await settle();

    const idle = buttonByText('重新抓取');
    expect(idle).not.toBeNull();
    expect(buttonByText('抓取中…')).toBeNull();
    expect(idle?.className).toContain('min-w-[6.5rem]');
  });
});
