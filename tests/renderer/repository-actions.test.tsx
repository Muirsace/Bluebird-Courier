// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  alertTexts,
  bodyText,
  buttonByText,
  click,
  createStub,
  dialog,
  makeGlance,
  menu,
  menuItem,
  pointerDownOutside,
  pressEscape,
  renderApp,
  repoActionsButton,
  repoOpenButton,
  repoRows,
  settle,
} from './helpers';

const FULL_NAME = 'octocat/Hello-World';

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

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

afterEach(async () => {
  if (view) {
    await view.unmount();
    view = null;
  }
});

describe('仓库操作 · 入口', () => {
  it('卡片上不再永久显示删除按钮，只有 ··· 入口', async () => {
    await mount();
    expect(repoActionsButton(FULL_NAME)).not.toBeNull();
    expect(buttonByText('删除')).toBeNull();
    expect(buttonByText('确认删除？')).toBeNull();
    expect(menu()).toBeNull();
    expect(dialog()).toBeNull();
  });

  it('点 ··· 打开菜单，不进入详情、不抓取全量信息', async () => {
    await mount();
    await openMenu();

    expect(menu()).not.toBeNull();
    expect(menuItem('从监控清单移除')).not.toBeNull();
    expect(repoActionsButton(FULL_NAME)?.getAttribute('aria-expanded')).toBe('true');
    expect(handle.calls.fetchDetail).toBe(0);
    expect(repoRows()).toHaveLength(1);
  });

  it('再点 ··· 收起菜单', async () => {
    await mount();
    await openMenu();
    await openMenu();
    expect(menu()).toBeNull();
  });

  it('Esc 关闭菜单', async () => {
    await mount();
    await openMenu();
    await pressEscape();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(repoActionsButton(FULL_NAME));
    expect(handle.calls.removeRepository).toBe(0);
  });

  it('菜单使用方向键、Home 和 End 移动焦点', async () => {
    await mount();
    await openMenu();
    const openItem = menuItem('在 GitHub 打开');
    const removeItem = menuItem('从监控清单移除');
    expect(document.activeElement).toBe(openItem);

    if (!openItem || !removeItem) throw new Error('菜单项未渲染');
    await pressKey(openItem, 'ArrowDown');
    expect(document.activeElement).toBe(removeItem);
    await pressKey(removeItem, 'ArrowUp');
    expect(document.activeElement).toBe(openItem);
    await pressKey(openItem, 'End');
    expect(document.activeElement).toBe(removeItem);
    await pressKey(removeItem, 'Home');
    expect(document.activeElement).toBe(openItem);
  });

  it('Tab 离开菜单时收起菜单', async () => {
    await mount();
    await openMenu();
    const openItem = menuItem('在 GitHub 打开');
    if (!openItem) throw new Error('菜单项未渲染');

    await pressKey(openItem, 'Tab');

    expect(menu()).toBeNull();
    expect(handle.calls.fetchDetail).toBe(0);
  });

  it('点击菜单外部关闭菜单', async () => {
    await mount();
    await openMenu();
    await pointerDownOutside(document.body);
    expect(menu()).toBeNull();
  });

  it('键盘焦点移出菜单时收起菜单并保留新的焦点位置', async () => {
    await mount();
    await openMenu();
    const repoButton = repoOpenButton(FULL_NAME);
    if (!repoButton) throw new Error('仓库详情按钮未渲染');

    await act(async () => repoButton.focus());
    await settle();

    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(repoButton);
    expect(handle.calls.fetchDetail).toBe(0);
  });
});

describe('仓库操作 · 移除确认 Popover', () => {
  it('点「从监控清单移除」打开确认 Popover，菜单同时收起', async () => {
    await mount();
    await openConfirm();

    expect(menu()).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain(FULL_NAME);
    expect(dialog()?.textContent).toContain('这不会删除 GitHub 仓库');
    expect(buttonByText('取消')).not.toBeNull();
    expect(buttonByText('移除')).not.toBeNull();
    expect(handle.calls.removeRepository).toBe(0);
  });

  it('取消不删除，Popover 关闭、仓库保留', async () => {
    await mount();
    await openConfirm();

    await click(buttonByText('取消'));
    await settle();

    expect(dialog()).toBeNull();
    expect(handle.calls.removeRepository).toBe(0);
    expect(repoRows()).toHaveLength(1);
  });

  it('Esc 关闭确认 Popover，不触发删除', async () => {
    await mount();
    await openConfirm();

    await pressEscape();
    await settle();

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(repoActionsButton(FULL_NAME));
    expect(handle.calls.removeRepository).toBe(0);
    expect(repoRows()).toHaveLength(1);
  });

  it('点击外部关闭确认 Popover，不触发删除', async () => {
    await mount();
    await openConfirm();

    await pointerDownOutside(document.body);
    await settle();

    expect(dialog()).toBeNull();
    expect(handle.calls.removeRepository).toBe(0);
    expect(repoRows()).toHaveLength(1);
  });

  it('确认移除：调用一次 removeRepository，成功后仓库从清单消失', async () => {
    await mount();
    await openConfirm();
    handle.setRepositories([]);

    await click(buttonByText('移除'));
    await settle();

    expect(handle.calls.removeRepository).toBe(1);
    expect(repoRows()).toHaveLength(0);
    expect(bodyText()).toContain('0 个仓库');
  });

  it('移除过程中显示处理中状态并禁用两个按钮', async () => {
    await mount();
    await openConfirm();
    const release = handle.holdNextRemove();

    await click(buttonByText('移除'));
    await settle();

    expect(buttonByText('移除中…')).not.toBeNull();
    expect(buttonByText('取消')?.disabled).toBe(true);
    expect(buttonByText('移除中…')?.disabled).toBe(true);
    expect(repoRows()).toHaveLength(1);

    handle.setRepositories([]);
    release();
    await settle();
    expect(dialog()).toBeNull();
    expect(repoRows()).toHaveLength(0);
  });

  it('移除失败：Popover 不关闭、就地提示、仓库保留且可重试', async () => {
    await mount({ removeFails: true });
    await openConfirm();

    await click(buttonByText('移除'));
    await settle();

    expect(dialog()).not.toBeNull();
    expect(alertTexts().join(' ')).toContain('删除失败');
    expect(repoRows()).toHaveLength(1);
    expect(bodyText()).not.toContain('还没有监控仓库');

    await click(buttonByText('移除'));
    await settle();
    expect(handle.calls.removeRepository).toBe(2);
    expect(dialog()).not.toBeNull();
  });
});

describe('仓库操作 · 不影响详情抓取', () => {
  it('菜单与 Popover 来回操作都不触发 fetchDetail', async () => {
    await mount();

    await openMenu();
    await pressEscape();
    await openConfirm();
    await click(buttonByText('取消'));
    await settle();

    expect(handle.calls.fetchDetail).toBe(0);
    expect(repoOpenButton(FULL_NAME)).not.toBeNull();
  });
});
