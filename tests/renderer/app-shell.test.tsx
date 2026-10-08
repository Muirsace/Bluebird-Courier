// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByText, click, createStub, makeGlance, navButton, openAddInput, renderApp,
  openRepositoryActions, repoOpenButton, resetSystemTheme, setViewportWidth,
  settle, submitForm, tab, typeInto,
} from './helpers';

let view: RenderResult | null = null;
const sidebar = (): HTMLElement => document.querySelector<HTMLElement>('.app-shell-sidebar')!;
const listViewport = (): HTMLElement => document.querySelector<HTMLElement>('.repository-list-viewport')!;
const workspace = (): HTMLElement => document.querySelector<HTMLElement>('.app-shell-workspace')!;

beforeEach(() => setViewportWidth(1152));
afterEach(async () => {
  await view?.unmount();
  view = null;
  setViewportWidth(768);
  resetSystemTheme();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(configured = true, repositories = [makeGlance(1, 'owner/A'), makeGlance(2, 'owner/B')]): Promise<StubHandle> {
  const stub = createStub({ repositories });
  stub.api.accessTokenState = async () => ({ configured });
  view = await renderApp(stub);
  await settle();
  return stub;
}

async function open(name = 'owner/A'): Promise<void> {
  await click(repoOpenButton(name));
  await settle();
}

describe('Desktop AppShell', () => {
  it('提供三个槽位，隐藏 Rail，未选仓库时不自动抓取详情', async () => {
    const stub = await mount();
    const shell = document.querySelector('.app-shell')!;
    expect([...shell.children].map((node) => node.className)).toEqual([
      'app-shell-rail', 'app-shell-sidebar', 'app-shell-workspace',
    ]);
    expect(shell.querySelector<HTMLElement>('.app-shell-rail')?.hidden).toBe(true);
    expect(sidebar().querySelector('.watchlist-page')).not.toBeNull();
    expect(workspace().querySelector('.workspace-empty')?.textContent).toContain('从左侧选择一个仓库');
    expect(stub.calls.fetchDetail).toBe(0);
    expect(document.querySelector('.view-transition')).toBeNull();
  });

  it('仓库选择只替换 Workspace，清单节点、输入状态与侧栏滚动保持', async () => {
    await mount();
    const list = sidebar().querySelector('.watchlist-page');
    const slot = sidebar();
    await openAddInput();
    const input = document.querySelector<HTMLInputElement>('#add-repository-input')!;
    await typeInto(input, 'draft/repo');
    listViewport().scrollTop = 420;
    await open();
    expect(sidebar()).toBe(slot);
    expect(sidebar().querySelector('.watchlist-page')).toBe(list);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe('draft/repo');
    expect(listViewport().scrollTop).toBe(420);
    expect(workspace().querySelector('.repository-header-name')?.getAttribute('aria-label')).toBe('owner/A');
    expect(sidebar().querySelector('.repo-context-scope')).toBeNull();
    workspace().scrollTop = 650;
    await open('owner/B');
    expect(workspace().scrollTop).toBe(0);
    expect(listViewport().scrollTop).toBe(420);
    expect(sidebar().querySelector('.watchlist-page')).toBe(list);
    expect(workspace().querySelector('.repository-header-name')?.getAttribute('aria-label')).toBe('owner/B');
  });

  it('换仓库重新显示概览，Refresh 保持滚动且只刷新当前仓库', async () => {
    const stub = await mount();
    await open();
    await click(tab('发版'));
    await open('owner/B');
    expect(tab('概览')?.getAttribute('aria-selected')).toBe('true');
    workspace().scrollTop = 250;
    listViewport().scrollTop = 300;
    const before = stub.calls.fetchDetail;
    await click(buttonByText('重新抓取'));
    await settle();
    expect(stub.calls.fetchDetail).toBe(before + 1);
    expect(workspace().scrollTop).toBe(250);
    expect(listViewport().scrollTop).toBe(300);
  });

  it('Settings 显示在 Workspace，返回仓库时 Sidebar 仍保持', async () => {
    await mount();
    const list = sidebar().querySelector('.watchlist-page');
    listViewport().scrollTop = 420;
    await click(navButton('设置'));
    await settle();
    expect(workspace().querySelector('.settings-page')).not.toBeNull();
    expect(sidebar().querySelector('.watchlist-page')).toBe(list);
    expect(listViewport().scrollTop).toBe(420);
    await open();
    await settle();
    expect(workspace().querySelector('.repository-header')).not.toBeNull();
    expect(listViewport().scrollTop).toBe(420);
  });

  it('新增仓库的视口补偿归 Sidebar，不改变 Workspace', async () => {
    await mount();
    const slot = listViewport();
    slot.scrollTop = 420;
    workspace().scrollTop = 180;
    Object.defineProperty(slot, 'scrollHeight', {
      configurable: true,
      get: () => repoOpenButton('new/Repo') ? 2600 : 2400,
    });
    await openAddInput();
    await typeInto(document.querySelector<HTMLInputElement>('#add-repository-input')!, 'new/Repo');
    await settle();
    await submitForm(document.querySelector<HTMLFormElement>('.watchlist-add-form form')!);
    await settle();
    expect(repoOpenButton('new/Repo')).not.toBeNull();
    expect(slot.scrollTop).toBe(620);
    expect(workspace().scrollTop).toBe(180);
    expect(document.body.textContent).toContain('查看位置');
  });

  it('未配置令牌但有本地清单：侧栏保留清单，不再强制设置页', async () => {
    const stub = await mount(false);
    expect(sidebar().querySelector('.watchlist-page')).not.toBeNull();
    expect(workspace().querySelector('.workspace-empty')?.textContent).toContain('从左侧选择一个仓库');
    expect(workspace().querySelector('#accessToken-input')).toBeNull();
    expect(navButton('设置')?.getAttribute('aria-pressed')).toBe('false');
    // 只读一次本地清单用于判定入口，不做任何自动抓取
    expect(stub.calls.listRepositories).toBe(1);
    expect(stub.calls.fetchDetail).toBe(0);
  });

  it('未配置令牌且没有本地清单：仍走启动闸门', async () => {
    const stub = await mount(false, []);
    expect(workspace().querySelector('#accessToken-input')).not.toBeNull();
    expect(sidebar().querySelector('.watchlist-page')).toBeNull();
    expect(navButton('监控清单')).toBeNull();
    expect(navButton('设置')?.getAttribute('aria-pressed')).toBe('true');
    expect(stub.calls.listRepositories).toBe(1);
    expect(stub.calls.fetchDetail).toBe(0);
  });

  it('不把焦点拉进 Workspace，Repo 与 Detail Tabs 仍为可聚焦按钮', async () => {
    await mount();
    const button = repoOpenButton('owner/A')!;
    button.focus();
    await open();
    expect(document.activeElement).toBe(button);
    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);
    expect(tab('概览')?.tabIndex).toBe(0);
  });

  it('桌面详情没有 Back，导航不写 window 滚动', async () => {
    await mount();
    const scroll = vi.spyOn(window, 'scrollTo');
    await open();
    expect(buttonByText('← 返回监控清单')).toBeNull();
    await click(navButton('设置'));
    await open();
    await settle();
    expect(workspace().querySelector('.repository-header')).not.toBeNull();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('Detail 两个观察器使用 Workspace，固定 Watchlist Chrome 不安装吸附观察器', async () => {
    const records: Array<{ target?: Element; options?: IntersectionObserverInit }> = [];
    class Observer {
      record: (typeof records)[number];
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = { options };
        records.push(this.record);
      }
      observe(target: Element): void { this.record.target = target; }
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    await mount();
    await open();
    const rootFor = (selector: string): Element | Document | null | undefined =>
      records.find((record) => record.target?.matches(selector))?.options?.root;
    expect(rootFor('.watchlist-toolbar-sentinel')).toBeUndefined();
    expect(document.querySelector('.watchlist-toolbar-sentinel')).toBeNull();
    expect(rootFor('.detail-tabs-sentinel')).toBe(workspace());
    expect(rootFor('.repo-context-sentinel')).toBe(workspace());
  });

  it('Sidebar 菜单进入 top layer，原 DOM 归属不变', async () => {
    const show = vi.fn();
    const hide = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: show });
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: hide });
    try {
      await mount();
      await openRepositoryActions('owner/A');
      await settle();
      const surface = sidebar().querySelector<HTMLElement>('.repository-action-positioner')!;
      expect(surface.dataset.shellOverlay).toBe('true');
      expect(surface.getAttribute('popover')).toBe('manual');
      expect(show).toHaveBeenCalledOnce();
      expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
      await view?.unmount();
      view = null;
      expect(hide).toHaveBeenCalledOnce();
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
      delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
    }
  });
});

describe('900px breakpoint / legacy navigation', () => {
  it.each([900, 1366])('%ipx 使用双栏', async (width) => {
    setViewportWidth(width);
    await mount();
    expect(document.querySelector('.app-shell')).not.toBeNull();
  });

  it.each([899, 768, 480])('%ipx 仍整页下钻、返回恢复与 PageTransition', async (width) => {
    setViewportWidth(width);
    await mount();
    expect(document.querySelector('.app-shell')).toBeNull();
    document.documentElement.scrollTop = 420;
    await open();
    expect(document.querySelector('.watchlist-page')).toBeNull();
    expect(document.querySelector<HTMLElement>('.view-transition')?.dataset.viewMotion).toBe('forward');
    await click(buttonByText('← 返回监控清单'));
    await settle();
    expect(document.querySelector('.watchlist-page')).not.toBeNull();
    expect(document.documentElement.scrollTop).toBe(420);
    document.documentElement.scrollTop = 0;
  });

  it('窗口跨过 breakpoint 时保留当前仓库导航', async () => {
    await mount();
    await open();
    await act(async () => setViewportWidth(768));
    expect(document.querySelector('.app-shell')).toBeNull();
    expect(document.querySelector('.repository-header-name')?.getAttribute('aria-label')).toBe('owner/A');
    await act(async () => setViewportWidth(900));
    expect(workspace().querySelector('.repository-header-name')?.getAttribute('aria-label')).toBe('owner/A');
    expect(sidebar().querySelector('.watchlist-page')).not.toBeNull();
  });
});
