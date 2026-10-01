// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByText, click, createStub, makeGlance, menuItem, navButton, openAddInput, refreshAllButton, renderApp,
  repoActionsButton, repoMotion, repoOpenButton, repoSlot, resetReducedMotion,
  resetSystemTheme, setReducedMotion, setSystemTheme, setViewportWidth, settle,
  settleMotion, submitForm, tab, typeInto,
} from './helpers';

let view: RenderResult | null = null;
let stub: StubHandle;
const A = 'MeteorNOX/DeepSeek-Balance-Whale-Widget';
const B = 'owner/B';
const repos = [makeGlance(1, A), makeGlance(2, B)];
const list = (): HTMLElement => document.querySelector('.repository-list-viewport')!;
const workspace = (): HTMLElement => document.querySelector('.app-shell-workspace')!;
const input = (): HTMLInputElement => document.querySelector('#add-repository-input')!;
const token = (): HTMLInputElement => document.querySelector('#accessToken-input')!;
const motion = (): string | undefined => document.querySelector<HTMLElement>('.view-transition')?.dataset.viewMotion;
beforeEach(() => setViewportWidth(1152));
afterEach(async () => {
  await view?.unmount();
  view = null;
  document.documentElement.scrollTop = 0;
  resetReducedMotion();
  resetSystemTheme();
  setViewportWidth(768);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(width = 1152): Promise<void> {
  setViewportWidth(width);
  stub = createStub({ repositories: repos });
  view = await renderApp(stub);
  await settle();
}
async function resize(width: number): Promise<void> {
  await act(async () => setViewportWidth(width));
  await settle();
}
async function open(name = A): Promise<void> {
  await click(repoOpenButton(name));
  await settle();
}
function expectDetail(desktop: boolean): void {
  expect(document.querySelector('.repository-header-name')?.textContent).toBe(A);
  expect(document.querySelector('.app-shell') !== null).toBe(desktop);
  expect(buttonByText('← 返回监控清单') !== null).toBe(!desktop);
  expect(document.querySelectorAll('.compact-repo-context')).toHaveLength(1);
  if (desktop) {
    expect(repoOpenButton(A)?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.view-transition')).toBeNull();
  } else {
    expect(document.querySelector('.desktop-sidebar-brand')).toBeNull();
    expect(document.querySelector('.watchlist-page')).toBeNull();
    expect(motion()).toBeUndefined();
  }
}

describe('one product state across two layout shells', () => {
  it.each([1152, 899])('Detail / active tab survive round-trip from %ipx without extra requests', async (width) => {
    await mount(width);
    await open();
    await click(tab('Issue & PR'));
    const panel = document.querySelector('[role="tabpanel"]');
    const calls = { ...stub.calls };
    for (const next of [width >= 900 ? 899 : 1366, 899, 1366, 768, 1152, 900, 899, 901]) {
      await resize(next);
      expectDetail(next >= 900);
      expect(tab('Issue & PR')?.getAttribute('aria-selected')).toBe('true');
      expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    }
    expect(stub.calls).toEqual(calls);
  });

  it('Desktop Empty maps to Narrow Watchlist, then back to Empty without selecting a repo', async () => {
    await mount();
    await resize(899);
    expect(document.querySelector('.watchlist-page')).not.toBeNull();
    expect(document.querySelector('.repository-header')).toBeNull();
    expect(motion()).toBeUndefined();
    await resize(900);
    expect(document.querySelector('.workspace-empty')).not.toBeNull();
    expect(repoOpenButton(A)?.getAttribute('aria-pressed')).toBe('false');
  });

  it('resize while Detail is fetching retains one request and the selected identity', async () => {
    await mount();
    const finish = stub.holdNextDetail();
    await click(repoOpenButton(A));
    for (const width of [899, 1152, 768]) {
      await resize(width);
      expect(document.querySelector('.repository-header-name')?.textContent).toBe(A);
      expect(document.querySelector('.detail-loading-slot[data-state="visible"]')).not.toBeNull();
      expect(stub.calls.fetchDetail).toBe(1);
    }
    await act(async () => finish());
    await settle();
    expect(document.querySelector('[role="tabpanel"]')).not.toBeNull();
    await resize(1152);
    expect(stub.calls.fetchDetail).toBe(1);
    expectDetail(true);
  });

  it('Settings save completion navigates using the current Narrow layout, including its original transition', async () => {
    await mount();
    await click(navButton('设置')); await settle();
    await typeInto(token(), 'fixture-token');
    let finish!: () => void;
    stub.api.saveAccessToken = () => new Promise(resolve => { finish = () => resolve({ ok: true, error: null }); });
    await submitForm(token().form!);
    await resize(899);
    await act(async () => finish()); await settle();
    await settleMotion(950);
    expect(document.querySelector('.watchlist-page')).not.toBeNull();
    expect(document.querySelector('.settings-page')).toBeNull();
    expect(motion()).toBe('top');
  });

  it('Narrow Watchlist / Back remain Watchlist when expanded; remembered identity is not auto-selected', async () => {
    await mount(899);
    await open();
    await click(buttonByText('← 返回监控清单'));
    expect(motion()).toBe('back');
    await resize(901);
    expect(document.querySelector('.workspace-empty')).not.toBeNull();
    expect(repoOpenButton(A)?.getAttribute('aria-pressed')).toBe('false');
  });

  it.each([1152, 899])('Settings input, visibility, error and view survive resize from %ipx', async (width) => {
    await mount(width);
    await click(navButton('设置'));
    await settle();
    const field = token();
    await typeInto(field, 'fixture-token');
    await click(document.querySelector('button[aria-label="显示令牌"]'));
    stub.api.validateAccessToken = async () => ({ ok: false, error: { kind: 'network', message: 'fixture' } });
    await click(buttonByText('测试连接'));
    await settle();
    const calls = { ...stub.calls };
    for (const next of [768, 1152, 899, 900]) {
      await resize(next);
      expect(token()).toBe(field);
      expect(token().value).toBe('fixture-token');
      expect(token().type).toBe('text');
      expect(document.body.textContent).toContain('无法连接 GitHub');
      expect(document.querySelector('.repository-header,[role="tablist"]')).toBeNull();
      if (next >= 900) {
        expect(navButton('设置')?.getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('.repository-sidebar-row[data-selected="true"]')).toBeNull();
      }
    }
    expect(stub.calls).toEqual(calls);
  });

  it.each(['saving', 'validating'] as const)('Settings %s pending survives resize with one request', async (operation) => {
    await mount();
    await click(navButton('设置'));
    await settle();
    await typeInto(token(), 'fixture-token');
    let finish!: (result: { ok: boolean; error: null }) => void;
    const request = vi.fn(() => new Promise<{ ok: boolean; error: null }>(resolve => { finish = resolve; }));
    if (operation === 'saving') stub.api.saveAccessToken = request;
    else stub.api.validateAccessToken = request;
    if (operation === 'saving') await submitForm(token().form!);
    else await click(buttonByText('测试连接'));
    for (const next of [899, 1152, 768]) {
      await resize(next);
      expect(buttonByText(operation === 'saving' ? '验证中…' : '测试中…')?.disabled).toBe(true);
      expect(token().value).toBe('fixture-token');
      expect(request).toHaveBeenCalledOnce();
    }
    await act(async () => finish({ ok: true, error: null }));
    await settle();
    expect(document.body.textContent).toContain(operation === 'saving' ? '令牌已保存并验证' : 'GitHub 连接正常');
  });
});

describe('scroll belongs to the active layout', () => {
  it('Desktop list scroll returns after Narrow Detail without polluting window or Workspace', async () => {
    await mount();
    list().scrollTop = 800;
    await open();
    workspace().scrollTop = 540;
    await resize(899);
    expect(window.scrollY).toBe(0);
    await resize(1152);
    expect(list().scrollTop).toBe(800);
    expect(workspace().scrollTop).toBe(0);
    expect(window.scrollY).toBe(0);
  });

  it('Narrow window position is independent from Desktop list and original navigation restore', async () => {
    await mount(899);
    document.documentElement.scrollTop = 400;
    await resize(1152);
    expect(window.scrollY).toBe(0);
    expect(list().scrollTop).toBe(0);
    list().scrollTop = 800;
    await resize(899);
    expect(window.scrollY).toBe(400);
    await open();
    expect(window.scrollY).toBe(0);
    expect(motion()).toBe('forward');
    await click(buttonByText('← 返回监控清单'));
    expect(window.scrollY).toBe(400);
    expect(motion()).toBe('back');
    await resize(1152);
    expect(list().scrollTop).toBe(800);
  });
});

describe('in-progress Watchlist interactions', () => {
  it.each([1152, 899])('Add input and form expansion survive both modes from %ipx without focus jumps', async (width) => {
    await mount(width);
    await openAddInput();
    await typeInto(input(), 'facebook/react');
    const field = input();
    const focus = vi.spyOn(field, 'focus');
    for (const next of [899, 1366, 480, 900]) {
      await resize(next);
      expect(input()).toBe(field);
      expect(field.value).toBe('facebook/react');
      expect(document.querySelector<HTMLElement>('.watchlist-add-form')?.dataset.expanded).toBe('true');
      expect(buttonByText('加入')).not.toBeNull();
    }
    expect(focus).not.toHaveBeenCalled();
    expect(stub.calls.addRepository).toBe(0);
  });

  it('an Add request and its feedback stay single through layout changes', async () => {
    await mount();
    await openAddInput();
    await typeInto(input(), 'owner/new');
    const finish = stub.holdNextAdd();
    await submitForm(input().form!);
    await resize(899);
    expect(buttonByText('加入中…')?.disabled).toBe(true);
    await resize(1152);
    await act(async () => finish());
    await settle();
    expect(document.body.textContent).toContain('已加入监控清单');
    await resize(899);
    expect(document.body.textContent).toContain('已加入监控清单');
    expect(stub.calls.addRepository).toBe(1);
    expect([...document.querySelectorAll<HTMLElement>('.repo-row-slot')].every(row => row.style.opacity !== '0')).toBe(true);
    expect(repoMotion('owner/new')).toBe('idle');
  });

  it('offscreen success retains View location, without automatically scrolling or submitting on resize', async () => {
    await mount();
    list().scrollTop = 800;
    await openAddInput();
    await typeInto(input(), 'owner/new');
    await submitForm(input().form!);
    await settle();
    expect(buttonByText('查看位置')).not.toBeNull();
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    for (const next of [899, 1152, 768, 1152]) await resize(next);
    expect(buttonByText('查看位置')).not.toBeNull();
    expect(input().value).toBe('owner/new');
    expect(scroll).not.toHaveBeenCalled();
    expect(stub.calls.addRepository).toBe(1);
  });

  it('Refresh pending and disabled state survive both shells without duplicate IPC', async () => {
    await mount();
    const finish = stub.holdNextRefresh();
    const calls = stub.calls.refreshGlance;
    await click(refreshAllButton());
    for (const next of [899, 1152, 480]) {
      await resize(next);
      expect(refreshAllButton()?.disabled).toBe(true);
      expect(stub.calls.refreshGlance).toBe(calls + 1);
    }
    await act(async () => finish());
    await settle();
    expect(refreshAllButton()?.disabled).toBe(false);
  });

  it('an interrupted View location releases old scroll listeners and cannot highlight the new layout from stale events', async () => {
    await mount();
    list().scrollTop = 800;
    Object.defineProperty(list(), 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(list(), 'scrollHeight', { configurable: true, value: 3000 });
    await openAddInput();
    await typeInto(input(), 'owner/new');
    await submitForm(input().form!); await settle();
    const oldRoot = list();
    const add = vi.spyOn(oldRoot, 'addEventListener');
    const remove = vi.spyOn(oldRoot, 'removeEventListener');
    const target = repoSlot('owner/new')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 50, 336, 72));
    await click(buttonByText('查看位置'));
    const listeners = add.mock.calls.filter(([type]) => type === 'scroll' || type === 'scrollend');
    expect(listeners.map(([type]) => type)).toEqual(['scroll', 'scrollend']);
    await resize(899);
    for (const [type, callback] of listeners) expect(remove).toHaveBeenCalledWith(type, callback);
    await act(async () => {
      oldRoot.dispatchEvent(new Event('scroll'));
      oldRoot.dispatchEvent(new Event('scrollend'));
    });
    expect(repoSlot('owner/new')?.dataset.highlightOnly).toBeUndefined();
    await settleMotion(750);
    expect(document.querySelector<HTMLElement>('.watchlist-add-form')?.dataset.expanded).toBe('false');
    expect(window.scrollY).toBe(0);
  });

  it.each([1152, 899])('an open menu closes on layout switch from %ipx, with no focus restoration to a detached trigger', async (width) => {
    await mount(width);
    const trigger = repoActionsButton(A)!;
    await click(trigger);
    await settle();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    const focus = vi.spyOn(trigger, 'focus');
    await resize(width >= 900 ? 899 : 1152);
    expect(document.querySelector('[role="menu"],[role="dialog"],.repository-action-positioner')).toBeNull();
    expect(trigger.isConnected).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(repoActionsButton(A)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('removing the selected repo while resizing clears identity in the current shell', async () => {
    await mount();
    await open();
    const finish = stub.holdNextRemove();
    await click(repoActionsButton(A));
    await click(menuItem('从监控清单移除'));
    await click(buttonByText('移除'));
    await resize(899);
    expectDetail(false);
    stub.setRepositories([repos[1]!]);
    await act(async () => finish());
    await settle();
    expect(document.querySelector('.repository-header,.compact-repo-context,[role="tablist"]')).toBeNull();
    await settleMotion(200);
    expect(repoSlot(A)).toBeNull();
    expect(repoSlot(B)).not.toBeNull();
    await resize(1152);
    expect(document.querySelector('.workspace-empty')).not.toBeNull();
    expect(repoOpenButton(B)?.getAttribute('aria-pressed')).toBe('false');
  });

  it('resize during add enter / delete exit leaves no inert or exiting nodes', async () => {
    await mount();
    await openAddInput();
    await typeInto(input(), 'owner/new');
    await submitForm(input().form!);
    await settle();
    await resize(899);
    expect(repoMotion('owner/new')).toBe('idle');
    await click(repoActionsButton('owner/new'));
    await click(menuItem('从监控清单移除'));
    stub.setRepositories(repos);
    await click(buttonByText('移除'));
    await resize(1152);
    await settleMotion(300);
    expect(repoSlot('owner/new')).toBeNull();
    expect(document.querySelector('li[inert],.repository-action-positioner')).toBeNull();
  });
});

describe('breakpoint, observers and animation ownership', () => {
  it('899 / 900 / 901 and 50 toggles retain identity/tab, suppress resize transitions and keep requests bounded', async () => {
    await mount();
    await open();
    await click(tab('Issue & PR'));
    const requests = { ...stub.calls };
    const errors = vi.spyOn(console, 'error');
    for (let i = 0; i < 50; i++) {
      const width = [898, 901, 899, 900, 897, 902][i % 6]!;
      await resize(width);
      expectDetail(width >= 900);
      expect(tab('Issue & PR')?.getAttribute('aria-selected')).toBe('true');
    }
    expect(stub.calls).toEqual(requests);
    expect(errors).not.toHaveBeenCalled();
  });

  it('sticky/context observers disconnect and switch roots; old callbacks cannot change the new context', async () => {
    const records: Array<{ callback: IntersectionObserverCallback; options?: IntersectionObserverInit; target?: Element; disconnected: boolean }> = [];
    class Observer {
      record: (typeof records)[number];
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = { callback, options, disconnected: false }; records.push(this.record);
      }
      observe(target: Element): void { this.record.target = target; }
      disconnect(): void { this.record.disconnected = true; }
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    await mount();
    await open();
    for (const next of [899, 1152, 899, 900]) {
      const old = records.filter(record => !record.disconnected);
      const previousContext = old.find(record => record.target?.matches('.repo-context-sentinel'))!;
      await resize(next);
      expect(old.every(record => record.disconnected)).toBe(true);
      const observers = records.filter(record => !record.disconnected);
      expect(observers).toHaveLength(2);
      expect(observers.every(record => record.options?.root === (next >= 900 ? workspace() : null))).toBe(true);
      await act(async () => previousContext.callback([{ intersectionRatio: 0 } as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(document.querySelector('.compact-repo-context')?.getAttribute('data-visible')).toBe('false');
      const current = observers.find(record => record.target?.matches('.repo-context-sentinel'))!;
      await act(async () => current.callback([{ intersectionRatio: 0 } as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(document.querySelector('.compact-repo-context')?.getAttribute('data-visible')).toBe('true');
      expect(document.querySelectorAll('.compact-repo-context')).toHaveLength(1);
    }
    await view?.unmount(); view = null;
    expect(records.every(record => record.disconnected)).toBe(true);
  });

  it('global header offsets measure Narrow and clear Desktop, including obsolete ResizeObserver callbacks', async () => {
    const records: Array<{ callback: ResizeObserverCallback; target?: Element; disconnected: boolean }> = [];
    class Observer {
      record: (typeof records)[number];
      constructor(callback: ResizeObserverCallback) { this.record = { callback, disconnected: false }; records.push(this.record); }
      observe(target: Element): void { this.record.target = target; }
      disconnect(): void { this.record.disconnected = true; }
    }
    vi.stubGlobal('ResizeObserver', Observer);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      return new DOMRect(0, 0, 900, this.matches('.app-global-header') ? 67 : 0);
    });
    await mount();
    await resize(899);
    expect(document.documentElement.style.getPropertyValue('--app-header-height')).toBe('67px');
    expect(document.documentElement.style.getPropertyValue('--app-chrome-height')).toBe('67px');
    const old = records.filter(record => record.target?.matches('.app-global-header')).at(-1)!;
    await resize(900);
    expect(old.disconnected).toBe(true);
    await act(async () => old.callback([], {} as ResizeObserver));
    expect(document.documentElement.style.getPropertyValue('--app-header-height')).toBe('0px');
    expect(document.documentElement.style.getPropertyValue('--app-chrome-height')).toBe('0px');
  });

  it.each(['light', 'dark', 'system'] as const)('%s theme + runtime resize keep one current view', async (theme) => {
    stub = createStub({ repositories: repos, preferences: { theme } });
    view = await renderApp(stub); await settle();
    await open();
    await act(async () => setSystemTheme('dark'));
    await resize(899);
    expect(document.documentElement.dataset.theme).toBe(theme === 'light' ? 'light' : 'dark');
    await act(async () => setSystemTheme('light'));
    await resize(1152);
    expect(document.documentElement.dataset.theme).toBe(theme === 'dark' ? 'dark' : 'light');
    expectDetail(true);
  });

  it('Reduced Motion keeps resize direct and Narrow navigation semantics available', async () => {
    setReducedMotion(true);
    await mount(); await open();
    await click(tab('Issue & PR'));
    await resize(899);
    expect(motion()).toBeUndefined();
    expect(tab('Issue & PR')?.getAttribute('aria-selected')).toBe('true');
    await click(buttonByText('← 返回监控清单'));
    expect(motion()).toBe('back');
    await resize(900);
    expect(document.querySelector('.view-transition')).toBeNull();
    expect(repoMotion(A)).toBe('idle');
  });
});
