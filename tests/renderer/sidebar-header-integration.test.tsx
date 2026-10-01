// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Glance } from '../../src/shared/types';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByText, click, createStub, makeGlance, menuItem, navButton, refreshAllButton, renderApp,
  repoActionsButton, repoMotion, repoOpenButton, repoSlot, resetReducedMotion,
  resetSystemTheme, setReducedMotion, setSystemTheme, setViewportWidth,
  settle, settleMotion, submitForm, typeInto,
} from './helpers';
import { readRendererStyles } from './support/styles';

let view: RenderResult | null = null;
let stub: StubHandle;
const repos = [makeGlance(1, 'owner/A'), makeGlance(2, 'owner/B')];
const sidebar = (): HTMLElement => document.querySelector('.app-shell-sidebar')!;
const viewport = (): HTMLElement => document.querySelector('.repository-list-viewport')!;
const workspace = (): HTMLElement => document.querySelector('.app-shell-workspace')!;
const brand = (): HTMLElement | null => document.querySelector('.desktop-sidebar-brand');
const chrome = (): HTMLElement | null => document.querySelector('.watchlist-sidebar-chrome');
const count = (): string | undefined => chrome()?.querySelector('.watchlist-count')?.textContent ?? undefined;

beforeEach(() => setViewportWidth(1152));
afterEach(async () => {
  await view?.unmount();
  view = null;
  resetReducedMotion();
  resetSystemTheme();
  setViewportWidth(768);
  document.documentElement.scrollTop = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(repositories: Glance[] = repos, configured = true): Promise<void> {
  stub = createStub({ repositories });
  stub.api.accessTokenState = async () => ({ configured });
  view = await renderApp(stub);
  await settle();
}
async function open(name = 'owner/A'): Promise<void> {
  await click(repoOpenButton(name));
  await settle();
}
async function add(name: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#add-repository-input')!;
  await typeInto(input, name);
  await submitForm(input.form!);
  await settle();
}

describe('App Chrome ownership / 900px boundary', () => {
  it.each([900, 1152, 1366])('%ipx has one Sidebar brand / Settings control and no global Header', async (width) => {
    setViewportWidth(width);
    await mount();
    expect(document.querySelector('.app-frame > header')).toBeNull();
    expect(document.querySelector('.app-global-header')).toBeNull();
    expect(brand()?.closest('aside')).toBe(sidebar());
    expect(brand()?.querySelector('h1')?.textContent).toBe('青鸟信使');
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(brand()?.querySelector('.app-brand-mark')?.getAttribute('aria-hidden')).toBe('true');
    expect([...brand()!.querySelectorAll('img')].every(img => img.alt === '')).toBe(true);
    const settings = navButton('设置')!;
    expect(settings.title).toBe('设置');
    expect(settings.getAttribute('aria-label')).toBe('设置');
    expect(settings.getAttribute('aria-pressed')).toBe('false');
    expect(settings.tabIndex).toBe(0);
    expect(document.querySelectorAll('button[aria-label="设置"]')).toHaveLength(1);
    expect(chrome()?.querySelector('h2')?.textContent).toBe('监控清单');
    expect(count()).toBe('2');
    expect(chrome()?.querySelector('.watchlist-add-trigger')).toBeNull();
    expect(chrome()?.contains(document.querySelector('#add-repository-input'))).toBe(true);
    expect(chrome()?.contains(refreshAllButton())).toBe(true);
    expect(viewport().contains(brand())).toBe(false);
    expect(viewport().contains(chrome())).toBe(false);
    expect(viewport().dataset.appScrollRoot).toBe('sidebar');
    expect(sidebar().hasAttribute('data-app-scroll-root')).toBe(false);
    expect([...document.querySelectorAll<HTMLElement>('[tabindex]')].every(node => node.tabIndex <= 0)).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--app-chrome-height')).toBe('0px');
  });

  it.each([899, 768, 480])('%ipx retains Global Header and legacy Watchlist without Sidebar brand', async (width) => {
    setViewportWidth(width);
    await mount();
    expect(document.querySelector('.app-frame > .app-global-header')).not.toBeNull();
    expect(brand()).toBeNull();
    expect(document.querySelector('.repository-list-viewport')).toBeNull();
    expect(document.querySelectorAll('.repo-row')).toHaveLength(2);
    expect(navButton('设置')?.textContent).toBe('设置');
    expect(document.querySelector('.watchlist-page-heading h1')?.textContent).toBe('监控清单');
    expect(document.querySelector('.watchlist-count')?.textContent).toBe('2 个仓库');
  });

  it('crossing the boundary measures narrow Header and clears old offsets on return', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, 899, this.matches('.app-global-header') ? 67 : 0);
    });
    await mount();
    await open();
    await act(async () => setViewportWidth(899));
    await settle();
    expect(brand()).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--app-header-height')).toBe('67px');
    expect(document.querySelector('.app-global-header .compact-repo-context')).not.toBeNull();
    expect(document.querySelector('.workspace-repo-context')).toBeNull();
    await act(async () => setViewportWidth(900));
    await settle();
    expect(document.querySelector('.app-global-header')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--app-header-height')).toBe('0px');
    expect(document.documentElement.style.getPropertyValue('--app-chrome-height')).toBe('0px');
    expect(workspace().querySelector('.workspace-repo-context')).not.toBeNull();
    expect(document.querySelectorAll('.compact-repo-context')).toHaveLength(1);
  });

  it('Settings is active only in its Workspace, preserving Chrome / list / scroll / focus', async () => {
    await mount();
    const nodes = { brand: brand(), chrome: chrome(), viewport: viewport(), row: repoSlot('owner/A') };
    viewport().scrollTop = 540;
    await open();
    const settings = navButton('设置')!;
    settings.focus();
    await click(settings);
    await settle();
    expect(document.activeElement).toBe(settings);
    expect(settings.getAttribute('aria-pressed')).toBe('true');
    expect(workspace().querySelector('.settings-page')).not.toBeNull();
    expect(workspace().querySelector('.repository-header,.compact-repo-context,[role="tablist"]')).toBeNull();
    expect(sidebar().querySelector('.repository-sidebar-row[data-selected="true"]')).toBeNull();
    await open('owner/B');
    expect(settings.getAttribute('aria-pressed')).toBe('false');
    expect(repoOpenButton('owner/B')?.getAttribute('aria-pressed')).toBe('true');
    expect(viewport().scrollTop).toBe(540);
    expect(brand()).toBe(nodes.brand);
    expect(chrome()).toBe(nodes.chrome);
    expect(viewport()).toBe(nodes.viewport);
    expect(repoSlot('owner/A')).toBe(nodes.row);
  });

  it('startup gate keeps Sidebar brand / Settings available without fetching a Watchlist', async () => {
    await mount(repos, false);
    expect(brand()).not.toBeNull();
    expect(navButton('设置')?.getAttribute('aria-pressed')).toBe('true');
    expect(workspace().querySelector('.settings-page')).not.toBeNull();
    expect(document.querySelector('.watchlist-page')).toBeNull();
    expect(stub.calls.listRepositories).toBe(0);
  });
});

describe('Sidebar actions / list scroll contract', () => {
  it('count follows add / remove without remounting Chrome or the viewport', async () => {
    setReducedMotion(true);
    await mount();
    const nodes = { chrome: chrome(), viewport: viewport() };
    await add('owner/new');
    expect(count()).toBe('3');
    await click(repoActionsButton('owner/new'));
    await click(menuItem('从监控清单移除'));
    await settle();
    stub.setRepositories(repos);
    await click(buttonByText('移除'));
    await settle();
    expect(count()).toBe('2');
    expect(chrome()).toBe(nodes.chrome);
    expect(viewport()).toBe(nodes.viewport);
  });

  it('loading count stays absent until the original list query completes', async () => {
    stub = createStub({ repositories: repos });
    const release = stub.holdNextList();
    view = await renderApp(stub);
    await settle();
    expect(count()).toBeUndefined();
    expect(viewport().textContent).toContain('正在加载监控清单');
    await act(async () => release());
    await settle();
    expect(count()).toBe('2');
  });

  it('Refresh retains its pending / disabled behavior, feedback belongs to fixed Chrome', async () => {
    await mount();
    const release = stub.holdNextRefresh();
    const before = stub.calls.refreshGlance;
    await click(refreshAllButton());
    await settle();
    const busy = refreshAllButton()!;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await click(busy);
    expect(stub.calls.refreshGlance).toBe(before + 1);
    await act(async () => release());
    await settle();
    expect(refreshAllButton()?.disabled).toBe(false);
    stub.api.refreshGlance = async () => { throw new Error('fixture'); };
    await click(refreshAllButton());
    await settle();
    expect(chrome()?.textContent).toContain('抓取失败，请稍后重试');
    expect(viewport().textContent).not.toContain('抓取失败，请稍后重试');
    expect(repoOpenButton('owner/A')).not.toBeNull();
  });

  it('View location uses list viewport events, with Header / Workspace / window unchanged', async () => {
    await mount(Array.from({ length: 25 }, (_, i) => makeGlance(i + 1, `owner/repo-${i}`)));
    const root = viewport();
    root.scrollTop = 650;
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 700 });
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 2500 });
    workspace().scrollTop = 320;
    const windowScroll = vi.spyOn(window, 'scrollTo');
    await add('owner/new');
    expect(chrome()?.textContent).toContain('查看位置');
    const target = repoSlot('owner/new')!;
    expect(target.closest('[data-app-scroll-root]')).toBe(root);
    const reveal = vi.spyOn(target, 'scrollIntoView');
    await click(buttonByText('查看位置'));
    expect(reveal).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    await act(async () => {
      root.dispatchEvent(new Event('scroll'));
      root.dispatchEvent(new Event('scrollend'));
    });
    expect(target.dataset.highlightOnly).toBe('true');
    expect(workspace().scrollTop).toBe(320);
    expect(sidebar().scrollTop).toBe(0);
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it('25 repos keep initial motion idle and preserve row nodes through selection and Settings', async () => {
    await mount(Array.from({ length: 25 }, (_, i) => makeGlance(i + 1, `owner/repo-${i}`)));
    const rows = [...viewport().querySelectorAll('li')];
    expect(rows).toHaveLength(25);
    expect(repoMotion('owner/repo-0')).toBe('idle');
    viewport().scrollTop = 680;
    for (const name of ['owner/repo-2', 'owner/repo-10', 'owner/repo-24']) await open(name);
    await click(navButton('设置'));
    await open('owner/repo-0');
    expect(viewport().scrollTop).toBe(680);
    expect([...viewport().querySelectorAll('li')]).toEqual(rows);
    expect(document.querySelector('.view-transition')).toBeNull();
  });

  it('0 repos retain count / actions / list empty state and Workspace Empty', async () => {
    await mount([]);
    expect(count()).toBe('0');
    expect(chrome()?.querySelector<HTMLInputElement>('#add-repository-input')?.disabled).toBe(false);
    expect(refreshAllButton()?.disabled).toBe(false);
    expect(viewport().textContent).toContain('还没有监控仓库');
    expect(workspace().querySelector('.workspace-empty')).not.toBeNull();
  });

  it.each(['light', 'dark', 'system'] as const)('%s theme keeps Chrome identity and follows the existing theme provider', async (theme) => {
    stub = createStub({ repositories: repos, preferences: { theme } });
    view = await renderApp(stub);
    await settle();
    const before = brand();
    await act(async () => setSystemTheme('dark'));
    await settle();
    expect(brand()).toBe(before);
    expect(document.documentElement.dataset.theme).toBe(theme === 'light' ? 'light' : 'dark');
  });

  it('Reduced Motion keeps add / delete lifecycle and the independent viewport', async () => {
    setReducedMotion(true);
    await mount();
    const root = viewport();
    await add('owner/new');
    expect(repoMotion('owner/new')).toBe('idle');
    await click(repoActionsButton('owner/new'));
    await click(menuItem('从监控清单移除'));
    await settle();
    stub.setRepositories(repos);
    await click(buttonByText('移除'));
    await settleMotion(150);
    expect(repoSlot('owner/new')).toBeNull();
    expect(viewport()).toBe(root);
  });
});

describe('Workspace Compact Context host', () => {
  it('rehosts the original context next to sticky Tabs; keeps observer root and hysteresis', async () => {
    const records: Array<{ callback: IntersectionObserverCallback; target?: Element; options?: IntersectionObserverInit }> = [];
    class Observer {
      record: (typeof records)[number];
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = { callback, options }; records.push(this.record);
      }
      observe(target: Element): void { this.record.target = target; }
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    await mount();
    await open();
    const node = workspace().querySelector('.compact-repo-context')!;
    expect(node.closest('.detail-tabs-sticky')).not.toBeNull();
    const observer = records.find(record => record.target?.matches('.repo-context-sentinel'))!;
    expect(observer.options?.root).toBe(workspace());
    expect(observer.options?.threshold).toEqual([0, 1]);
    expect(node.getAttribute('aria-hidden')).toBe('true');
    for (const ratio of [0, 0.5]) {
      await act(async () => observer.callback([{ intersectionRatio: ratio } as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(node.getAttribute('data-visible')).toBe('true');
    }
    await act(async () => observer.callback([{ intersectionRatio: 1 } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(node.getAttribute('data-visible')).toBe('false');
    const css = readRendererStyles();
    expect(css).toMatch(/\.app-shell-workspace\s*\{[^}]*--app-header-height: var\(--workspace-context-height\)/);
    expect(css).toMatch(/\.workspace-repo-context\s*\{[^}]*position: absolute;[^}]*bottom: 100%/);
    expect(css).toMatch(/\.repository-list-viewport\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto/);
  });
});
