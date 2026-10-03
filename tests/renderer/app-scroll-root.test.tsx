// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findSidebarScrollRoot, resolveAppScrollRoot, scrollPositionElement, scrollTarget, scrollViewportHeight } from '../../src/renderer/lib/app-scroll-root';
import type { RenderResult } from './helpers';
import { buttonByText, click, createStub, makeGlance, openAddInput, renderApp, repoOpenButton, repoSlot, resetSystemTheme, setViewportWidth, settle, submitForm, tab, typeInto } from './helpers';

let view: RenderResult | null = null;
const list = (): HTMLElement => document.querySelector('.watchlist-page')!;
const sidebar = (): HTMLElement => document.querySelector('.repository-list-viewport')!;
const workspace = (): HTMLElement => document.querySelector('.app-shell-workspace')!;
const repo = 'owner/A';
async function mount(width: number) {
  setViewportWidth(width);
  const stub = createStub({ repositories: [makeGlance(1, repo)] });
  view = await renderApp(stub);
  await settle();
  return stub;
}
async function resize(width: number) {
  await act(async () => setViewportWidth(width));
  await settle();
}
afterEach(async () => {
  await view?.unmount(); view = null;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.documentElement.scrollTop = 0;
  setViewportWidth(768); resetSystemTheme();
});

describe('AppScrollRoot DOM ownership', () => {
  it('Narrow Watchlist selects window events and document position storage', async () => {
    await mount(899);
    const root = resolveAppScrollRoot(repoOpenButton(repo));
    expect(root).toEqual({ kind: 'window', element: null });
    expect(scrollTarget(root)).toBe(window);
    expect(scrollPositionElement(root)).toBe(document.scrollingElement ?? document.documentElement);
    expect(findSidebarScrollRoot(list())).toBeNull();
  });

  it('Desktop Watchlist selects its Sidebar viewport, independently of Workspace', async () => {
    await mount(900);
    const root = resolveAppScrollRoot(repoOpenButton(repo));
    expect(root).toEqual({ kind: 'sidebar', element: sidebar() });
    expect(scrollTarget(root)).toBe(sidebar());
    expect(scrollPositionElement(root)).toBe(sidebar());
    expect(findSidebarScrollRoot(list())).toEqual(root);
    expect(root.element).not.toBe(workspace());
  });

  it('Desktop Detail selects Workspace and Narrow Detail selects window after rehosting', async () => {
    const stub = await mount(900);
    await click(repoOpenButton(repo)); await settle();
    await click(tab('Issue & PR'));
    const detail = document.querySelector<HTMLElement>('.detail-page')!;
    const panel = document.querySelector('[role="tabpanel"]');
    const calls = { ...stub.calls };
    for (const width of [899, 900, 899, 900]) {
      await resize(width);
      const root = resolveAppScrollRoot(detail);
      expect(root.kind).toBe(width >= 900 ? 'workspace' : 'window');
      expect(root.element).toBe(width >= 900 ? workspace() : null);
      expect(document.querySelector('.detail-page')).toBe(detail);
      expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
      expect(tab('Issue & PR')?.getAttribute('aria-selected')).toBe('true');
    }
    expect(stub.calls).toEqual(calls);
  });

  it('899 ↔ 900 five round trips restore window 400 and Sidebar 240 independently', async () => {
    const stub = await mount(899);
    const page = list();
    const input = await openAddInput();
    await typeInto(input, 'owner/draft');
    document.documentElement.scrollTop = 400;
    await resize(900); sidebar().scrollTop = 240;
    const calls = { ...stub.calls };
    for (let i = 0; i < 5; i++) {
      await resize(899);
      expect(window.scrollY).toBe(400);
      expect(resolveAppScrollRoot(repoOpenButton(repo)).kind).toBe('window');
      await resize(900);
      expect(sidebar().scrollTop).toBe(240);
      expect(window.scrollY).toBe(0);
      expect(workspace().scrollTop).toBe(0);
      expect(resolveAppScrollRoot(repoOpenButton(repo)).element).toBe(sidebar());
      expect(list()).toBe(page);
      expect(document.querySelector('#add-repository-input')).toBe(input);
      expect(input.value).toBe('owner/draft');
    }
    expect(stub.calls).toEqual(calls);
  });

  it('Narrow navigation still captures before leaving and restores with auto', async () => {
    await mount(899);
    document.documentElement.scrollTop = 400;
    const scroll = vi.spyOn(window, 'scrollTo');
    await click(repoOpenButton(repo)); await settle();
    expect(scroll).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
    await click(buttonByText('← 返回监控清单')); await settle();
    expect(scroll).toHaveBeenLastCalledWith({ top: 400, behavior: 'auto' });
    expect(window.scrollY).toBe(400);
  });

  it('window fallback preserves scrollingElement and viewport-height precedence', () => {
    const root = resolveAppScrollRoot(null);
    const element = document.createElement('div');
    vi.spyOn(document, 'scrollingElement', 'get').mockReturnValue(element);
    expect(scrollPositionElement(root)).toBe(element);
    vi.spyOn(document, 'scrollingElement', 'get').mockReturnValue(null);
    expect(scrollPositionElement(root)).toBe(document.documentElement);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(700);
    expect(scrollViewportHeight(root)).toBe(700);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(0);
    expect(scrollViewportHeight(root)).toBe(window.innerHeight);
  });

  it('Detail Sticky and Compact Context retain observer options and clean up both old roots', async () => {
    const observers: Array<{ options?: IntersectionObserverInit; target?: Element; disconnected: boolean }> = [];
    class Observer {
      record: (typeof observers)[number];
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = { options, disconnected: false }; observers.push(this.record);
      }
      observe(target: Element) { this.record.target = target; }
      disconnect() { this.record.disconnected = true; }
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    await mount(900); await click(repoOpenButton(repo)); await settle();
    for (const width of [899, 900, 899]) {
      const previous = observers.filter(o => !o.disconnected);
      await resize(width);
      expect(previous.every(o => o.disconnected)).toBe(true);
      const live = observers.filter(o => !o.disconnected);
      const root = width >= 900 ? workspace() : null;
      expect(live.find(o => o.target?.matches('.detail-tabs-sentinel'))?.options).toEqual({ root });
      expect(live.find(o => o.target?.matches('.repo-context-sentinel'))?.options).toEqual({ root, threshold: [0, 1] });
    }
    await view?.unmount(); view = null;
    expect(observers.every(o => o.disconnected)).toBe(true);
  });

  it('Narrow reveal removes window listeners on switching to Sidebar; stale events cannot highlight', async () => {
    await mount(899);
    document.documentElement.scrollTop = 800;
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(3000);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600);
    const input = await openAddInput(); await typeInto(input, 'owner/new');
    await submitForm(input.form!); await settle();
    const target = repoSlot('owner/new')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 50, 336, 72));
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    await click(buttonByText('查看位置'));
    const listeners = add.mock.calls.filter(([type]) => type === 'scroll' || type === 'scrollend');
    expect(listeners.map(([type]) => type)).toEqual(['scroll', 'scrollend']);
    await resize(900);
    for (const [type, callback] of listeners) expect(remove).toHaveBeenCalledWith(type, callback);
    await act(async () => { window.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('scrollend')); });
    expect(repoSlot('owner/new')?.dataset.highlightOnly).toBeUndefined();
  });
});
