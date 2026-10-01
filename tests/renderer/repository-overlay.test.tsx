// @vitest-environment happy-dom
import { readRendererStyles } from './support/styles';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  buttonByText,
  click,
  createStub,
  dialog,
  makeGlance,
  menu,
  menuItem,
  pressEscape,
  renderApp,
  repoActionsButton,
  resetReducedMotion,
  setReducedMotion,
  settle,
  settleMotion,
  settleOverlayClose,
} from './helpers';

const FULL_NAME = 'octocat/Hello-World';
const DEFAULT_INNER_HEIGHT = window.innerHeight;

let handle: StubHandle;
let view: RenderResult | null = null;

async function mount(options: StubOptions = {}): Promise<void> {
  handle = createStub({ repositories: [makeGlance(1, FULL_NAME)], ...options });
  view = await renderApp(handle);
  await settle();
}

async function openMenu(): Promise<void> {
  await click(repoActionsButton(FULL_NAME));
  await settle();
}

async function openConfirm(): Promise<void> {
  await openMenu();
  await click(menuItem('从监控清单移除'));
  await settle();
}

function positioner(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.repository-action-positioner');
}

function surface(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.repository-action-surface');
}

function content(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.repository-action-content');
}

function outgoing(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.repository-action-content-out');
}

/** happy-dom 没有布局：几何尺寸全靠显式桩进去，组件读到的就是这些值。 */
function stubRect(element: Element, rect: { top: number; bottom: number; right: number }): void {
  (element as HTMLElement).getBoundingClientRect = () =>
    ({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.right - 32,
      right: rect.right,
      width: 32,
      height: rect.bottom - rect.top,
      x: rect.right - 32,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function stubHeight(element: Element, height: number | (() => number)): void {
  (element as HTMLElement).getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: typeof height === 'function' ? height() : height,
      left: 0,
      right: 176,
      width: 176,
      height: typeof height === 'function' ? height() : height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function stubViewportHeight(height: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

/** 把触发器放到窗口底部附近，并把视口压矮：模拟"清单最后一张卡片"。 */
async function mountAtViewportBottom(): Promise<void> {
  await mount();
  stubViewportHeight(600);
  const trigger = repoActionsButton(FULL_NAME);
  if (!trigger) throw new Error('未找到 ··· 入口');
  stubRect(trigger, { top: 558, bottom: 590, right: 1000 });
  await openMenu();
}

afterEach(async () => {
  if (view) {
    await view.unmount();
    view = null;
  }
  resetReducedMotion();
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: DEFAULT_INNER_HEIGHT });
});

describe('仓库操作浮层 · 分层与动画参数', () => {
  it('菜单挂在 positioner / surface / content 三层里，位置由 placement 属性决定', async () => {
    await mount();
    await openMenu();

    expect(positioner()).not.toBeNull();
    expect(surface()).not.toBeNull();
    expect(content()).not.toBeNull();
    expect(positioner()?.dataset.placement).toBe('bottom');
    expect(surface()?.dataset.swapping).toBeUndefined();
    expect(surface()?.dataset.closing).toBeUndefined();
    // 菜单本体还是那个 role=menu / aria-busy 的容器，无障碍契约没变
    expect(menu()?.getAttribute('aria-busy')).toBe('false');
  });

  it('进场 / 关闭 / 尺寸补间 / 内容交叉淡化的时长都写死在样式表里，没有 transition-all', () => {
    const css = readRendererStyles();

    expect(css).toContain('.repository-action-positioner');
    expect(css).toContain('repository-action-enter 160ms var(--motion-ease-out)');
    expect(css).toContain('repository-action-close 120ms var(--motion-ease-in) forwards');
    expect(css).toContain('repository-action-resize 170ms var(--motion-ease-out)');
    expect(css).toContain('repository-action-content-out 170ms var(--motion-ease-out)');
    expect(css).toContain('translateY(var(--overlay-enter-shift)) scale(0.985)');
    expect(css).toContain('translateX(-3px)');
    expect(css).not.toContain('transition-all');
  });
});

describe('仓库操作浮层 · Menu → Confirm 连续过渡', () => {
  it('同一个外壳换内容：不卸载，旧菜单带着 aria-hidden 留在 out 层淡出', async () => {
    await mount();
    await openMenu();
    const beforePositioner = positioner();
    const beforeSurface = surface();

    await click(menuItem('从监控清单移除'));
    await settle();

    // 外壳是同一个节点（没有 unmount → 没有跳变）
    expect(positioner()).toBe(beforePositioner);
    expect(surface()).toBe(beforeSurface);
    expect(positioner()?.dataset.swapping).toBe('true');

    const out = outgoing();
    expect(out).not.toBeNull();
    expect(out?.getAttribute('aria-hidden')).toBe('true');
    expect(out?.hasAttribute('inert')).toBe(true);
    expect(out?.querySelector('[role="menu"]')).not.toBeNull();

    // live 查询只剩确认框：旧菜单不算"当前界面"
    expect(menu()).toBeNull();
    expect(dialog()).not.toBeNull();
    // 尺寸补间还没播完，焦点已经在取消按钮上了
    expect(document.activeElement).toBe(buttonByText('取消'));
  });

  it('尺寸补间结束后 out 层清掉，外壳只留新内容', async () => {
    await mount();
    await openConfirm();
    expect(outgoing()).not.toBeNull();

    await settleMotion();

    expect(outgoing()).toBeNull();
    expect(positioner()?.dataset.swapping).toBeUndefined();
    expect(dialog()).not.toBeNull();
  });

  it('关闭走 120ms 动画：外壳先留在原位，播完才卸载', async () => {
    await mount();
    await openMenu();
    const beforeSurface = surface();

    await pressEscape();
    await settle();

    expect(surface()).toBe(beforeSurface);
    expect(surface()?.dataset.closing).toBe('true');

    await settleOverlayClose();
    expect(positioner()).toBeNull();
    expect(menu()).toBeNull();
  });
});

describe('仓库操作浮层 · Reduced Motion', () => {
  it('降级后不做尺寸补间、不留交叉淡化的旧内容', async () => {
    setReducedMotion(true);
    await mount();
    await openMenu();

    await click(menuItem('从监控清单移除'));
    await settle();

    expect(outgoing()).toBeNull();
    expect(positioner()?.dataset.swapping).toBeUndefined();
    expect(dialog()).not.toBeNull();

    await pressEscape();
    await settleOverlayClose();
    expect(positioner()).toBeNull();
  });
});

describe('仓库操作浮层 · 视口碰撞', () => {
  it('下方放得下：placement = bottom', async () => {
    await mount();
    stubViewportHeight(1000);
    const trigger = repoActionsButton(FULL_NAME);
    if (!trigger) throw new Error('未找到 ··· 入口');
    stubRect(trigger, { top: 100, bottom: 132, right: 1000 });

    await openMenu();

    expect(positioner()?.dataset.placement).toBe('bottom');
    expect(surface()?.dataset.placement).toBe('bottom');
    // 1000 - 132 - 12 - 8
    expect(positioner()?.style.getPropertyValue('--overlay-max-height')).toBe('848px');
  });

  it('最后一张卡片：下方放不下就翻到上方', async () => {
    await mountAtViewportBottom();

    expect(positioner()?.dataset.placement).toBe('top');
    expect(surface()?.dataset.placement).toBe('top');
    // 558 - 12 - 8
    expect(positioner()?.style.getPropertyValue('--overlay-max-height')).toBe('538px');
  });

  it('确认框比菜单高：换内容时重新 measure，flip 到上方并限高', async () => {
    await mount();
    stubViewportHeight(600);
    const trigger = repoActionsButton(FULL_NAME);
    if (!trigger) throw new Error('未找到 ··· 入口');
    stubRect(trigger, { top: 300, bottom: 332, right: 1000 });
    await openMenu();
    expect(positioner()?.dataset.placement).toBe('bottom');

    // 菜单自然高 80（下方放得下），确认框自然高 320（上下都放不下）
    const box = content();
    if (!box) throw new Error('浮层内容未渲染');
    stubHeight(box, () => (box.querySelector('.repository-action-content-in [role="menu"]') ? 80 : 320));

    await click(menuItem('从监控清单移除'));
    await settle();

    // 下方 256 / 上方 288：都放不下 → 取更大的一侧，并把高度压进 280
    expect(positioner()?.dataset.placement).toBe('top');
    expect(positioner()?.style.getPropertyValue('--overlay-height')).toBe('320px');
    expect(positioner()?.style.getPropertyValue('--overlay-max-height')).toBe('280px');
    expect(surface()?.dataset.clamped).toBe('true');
  });

  it('错误提示让浮层变高：重新 measure 后 placement 跟着变', async () => {
    await mount({ openExternalResult: { ok: false, reason: 'open_failed' } });
    stubViewportHeight(600);
    const trigger = repoActionsButton(FULL_NAME);
    if (!trigger) throw new Error('未找到 ··· 入口');
    stubRect(trigger, { top: 300, bottom: 332, right: 1000 });
    await openMenu();
    expect(positioner()?.dataset.placement).toBe('bottom');

    // 报错前 80 高（下方放得下），报错后 320 高（只剩上方能放）
    const box = content();
    if (!box) throw new Error('浮层内容未渲染');
    stubHeight(box, () => (box.querySelector('[role="alert"]') ? 320 : 80));

    await click(menuItem('在 GitHub 打开'));
    await settle();

    expect(positioner()?.dataset.placement).toBe('top');
    expect(positioner()?.style.getPropertyValue('--overlay-height')).toBe('320px');
  });
});
