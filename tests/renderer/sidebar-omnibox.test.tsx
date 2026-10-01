// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  buttonByLabel, buttonByText, click, createStub, makeGlance, navButton, openAddInput,
  pressEscape, refreshAllButton, renderApp, repoOpenButton, repoSlot,
  resetReducedMotion, setReducedMotion, setViewportWidth, settle, settleMotion,
  submitForm, typeInto,
} from './helpers';

let view: RenderResult | null = null;
let stub: StubHandle;
const repos = [makeGlance(1, 'owner/A'), makeGlance(2, 'owner/B')];
const input = (): HTMLInputElement => document.querySelector('#add-repository-input')!;
const action = (): HTMLButtonElement => document.querySelector('.watchlist-add-action')!;
const chrome = (): HTMLElement => document.querySelector('.watchlist-sidebar-chrome')!;
const viewport = (): HTMLElement => document.querySelector('.repository-list-viewport')!;
const workspace = (): HTMLElement => document.querySelector('.app-shell-workspace')!;
beforeEach(() => setViewportWidth(1152));
afterEach(async () => {
  await view?.unmount(); view = null;
  setViewportWidth(768); resetReducedMotion();
  document.documentElement.scrollTop = 0;
  vi.restoreAllMocks();
});
async function mount(options: StubOptions = {}): Promise<void> {
  stub = createStub({ repositories: repos, ...options });
  view = await renderApp(stub); await settle();
}
async function resize(width: number): Promise<void> {
  await act(async () => setViewportWidth(width)); await settle();
}
async function add(name: string): Promise<void> {
  await typeInto(input(), name); await submitForm(input().form!); await settle();
}

describe('Desktop Repository Omnibox shell', () => {
  it.each([900, 1152, 1366])('%ipx has one persistent input and Refresh inside the title row', async (width) => {
    setViewportWidth(width); await mount();
    expect(buttonByLabel('新增仓库')).toBeNull();
    expect(document.querySelector('.watchlist-add-trigger')).toBeNull();
    expect(input().disabled).toBe(false);
    expect(input().tabIndex).toBe(0);
    expect(input().placeholder).toBe('输入 owner/repo 添加仓库…');
    expect(action().getAttribute('aria-hidden')).toBe('true');
    expect(action().disabled).toBe(true);
    const refresh = refreshAllButton()!;
    expect(refresh.getAttribute('aria-label')).toBe('全部刷新');
    expect(refresh.title).toBe('全部刷新');
    expect(refresh.textContent?.trim()).toBe('');
    expect(refresh.closest('.watchlist-page-heading')?.querySelector('h2')?.textContent).toBe('监控清单');
    expect(chrome().contains(input())).toBe(true);
    expect(viewport().contains(input())).toBe(false);
    expect(viewport().dataset.appScrollRoot).toBe('sidebar');
    expect(document.activeElement).not.toBe(input());
  });

  it.each([899, 768, 480])('%ipx keeps Legacy Add and text Refresh', async (width) => {
    setViewportWidth(width); await mount();
    expect(buttonByLabel('新增仓库')).not.toBeNull();
    expect(input().disabled).toBe(true);
    expect(input().placeholder).toBe('owner/repo 或 GitHub 网址');
    expect(buttonByText('全部刷新')).not.toBeNull();
    await openAddInput();
    expect(input().disabled).toBe(false);
    expect(document.activeElement).toBe(input());
  });

  it('typing does not filter the list, fetch or replace the current Workspace', async () => {
    await mount(); await click(repoOpenButton('owner/A')); await settle();
    const content = workspace().querySelector('[role="tabpanel"]');
    const rows = [...viewport().querySelectorAll('li')];
    const calls = { ...stub.calls };
    for (const value of ['o', 'owner/', 'owner/B', 'unknown/repo', '']) {
      await typeInto(input(), value);
      expect([...viewport().querySelectorAll('li')]).toEqual(rows);
      expect(workspace().querySelector('[role="tabpanel"]')).toBe(content);
      expect(repoOpenButton('owner/A')?.getAttribute('aria-pressed')).toBe('true');
    }
    expect(stub.calls).toEqual(calls);
    expect(action().tabIndex).toBe(-1);
  });

  it('the existing form submission adds once and updates the live count', async () => {
    await mount(); await add('owner/new');
    expect(stub.addInputs).toEqual(['owner/new']);
    expect(chrome().querySelector('.watchlist-count')?.textContent).toBe('3');
    expect(repoOpenButton('owner/new')).not.toBeNull();
    expect(workspace().querySelector('.workspace-empty')).not.toBeNull();
    expect(input().form?.querySelector('[role="status"]')?.textContent).toContain('已加入监控清单');
    expect(stub.calls.fetchDetail).toBe(0);
  });

  it('already-added feedback belongs to the input; only Open detail changes selection', async () => {
    await mount(); await typeInto(input(), 'owner/B');
    expect(action().type).toBe('button');
    expect(action().textContent).toContain('已添加');
    expect(input().form?.querySelector('#add-repository-duplicate')?.textContent).toContain('已在监控清单中');
    expect(workspace().querySelector('.workspace-empty')).not.toBeNull();
    await submitForm(input().form!);
    expect(stub.calls.addRepository).toBe(0);
    await click(buttonByLabel('打开 owner/B 详情')); await settle();
    expect(repoOpenButton('owner/B')?.getAttribute('aria-pressed')).toBe('true');
    expect(stub.calls.fetchDetail).toBe(1);
  });

  it('already-added action retains the original manual clear path', async () => {
    await mount(); await typeInto(input(), 'owner/A');
    await click(action());
    expect(action().getAttribute('aria-label')).toBe('清除输入框');
    await click(action());
    expect(input().value).toBe('');
    expect(input().disabled).toBe(false);
    expect(input().form?.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('false');
  });

  it('success auto-clear leaves the same Desktop input available', async () => {
    await mount(); const field = input(); await add('owner/new');
    await settleMotion(1550);
    expect(input()).toBe(field);
    expect(field.value).toBe('');
    expect(field.disabled).toBe(false);
    expect(buttonByLabel('新增仓库')).toBeNull();
    expect(input().form?.querySelector('.watchlist-inline-message')?.getAttribute('data-open')).toBe('false');
  });

  it('invalid and remote error stay under the field, with the existing clear action', async () => {
    await mount({ addResult: { ok: false, repository: null, error: { kind: 'unknown', message: '很长的添加失败信息 '.repeat(15) } } });
    await typeInto(input(), 'invalid');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    await submitForm(input().form!);
    expect(stub.calls.addRepository).toBe(0);
    await add('owner/new');
    const error = input().form?.querySelector('[role="alert"]');
    expect(error?.textContent).toContain('添加失败信息');
    expect(input().getAttribute('aria-describedby')).toBe(error?.id);
    expect(action().getAttribute('aria-label')).toBe('清除输入框');
    expect(viewport().querySelector('[role="alert"]')).toBeNull();
  });

  it('Esc clears the Desktop shell without removing it or moving focus', async () => {
    await mount(); input().focus(); const field = input();
    await typeInto(field, 'owner/new'); await pressEscape(); await settle();
    expect(input()).toBe(field); expect(field.value).toBe('');
    expect(field.disabled).toBe(false); expect(document.activeElement).toBe(field);
    await resize(899);
    expect(field.disabled).toBe(true);
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('false');
  });

  it.each([1152, 899])('input and pending share one owner across resize from %ipx', async (width) => {
    setViewportWidth(width); await mount(); const field = await openAddInput();
    await typeInto(field, 'owner/new'); const finish = stub.holdNextAdd();
    await submitForm(field.form!);
    for (const next of [899, 1152, 480, 900]) {
      await resize(next); expect(input()).toBe(field); expect(field.value).toBe('owner/new');
      expect(action().disabled).toBe(true); expect(stub.calls.addRepository).toBe(1);
    }
    await act(async () => finish()); await settle();
    expect(chrome().textContent).toContain('已加入监控清单');
  });

  it('Settings preserves Omnibox input / DOM and list scroll', async () => {
    await mount(); const field = input(); const root = viewport();
    root.scrollTop = 500; await typeInto(field, 'owner/draft');
    await click(navButton('设置')); await settle();
    expect(workspace().querySelector('.settings-page')).not.toBeNull();
    expect(input()).toBe(field); expect(field.value).toBe('owner/draft');
    expect(viewport()).toBe(root); expect(root.scrollTop).toBe(500);
    await click(repoOpenButton('owner/A')); await settle();
    expect(input()).toBe(field); expect(field.value).toBe('owner/draft');
  });

  it('View location still uses only the list viewport and clears feedback after settling', async () => {
    await mount({
      repositories: Array.from({ length: 25 }, (_, i) => makeGlance(i + 1, `owner/repo-${i}`)),
    });
    const root = viewport(); root.scrollTop = 650;
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 700 });
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 2500 });
    const windowScroll = vi.spyOn(window, 'scrollTo'); workspace().scrollTop = 320;
    await add('owner/new'); const target = repoSlot('owner/new')!;
    const reveal = vi.spyOn(target, 'scrollIntoView');
    await click(buttonByText('查看位置'));
    expect(reveal).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    await act(async () => { root.dispatchEvent(new Event('scroll')); root.dispatchEvent(new Event('scrollend')); });
    expect(target.dataset.highlightOnly).toBe('true');
    expect(workspace().scrollTop).toBe(320); expect(windowScroll).not.toHaveBeenCalled();
    await settleMotion(800); expect(input().value).toBe(''); expect(input().disabled).toBe(false);
  });

  it('0 repos still have an enabled input, Refresh and one existing list empty state', async () => {
    await mount({ repositories: [] });
    expect(chrome().querySelector('.watchlist-count')?.textContent).toBe('0');
    expect(input().disabled).toBe(false); expect(refreshAllButton()?.disabled).toBe(false);
    expect(viewport().textContent?.split('还没有监控仓库')).toHaveLength(2);
    expect(chrome().textContent).not.toContain('还没有监控仓库');
  });

  it('a long owner/repo remains editable and leaves the Add action available', async () => {
    await mount(); const name = 'very-long-owner-name/very-long-repository-name';
    await typeInto(input(), name); expect(input().value).toBe(name);
    expect(action().disabled).toBe(false); expect(action().type).toBe('submit');
    expect([...viewport().querySelectorAll('li')]).toHaveLength(2);
  });

  it('natural DOM keyboard order is Settings / Refresh / Input / Add / rows', async () => {
    await mount(); await typeInto(input(), 'owner/new');
    const controls = [navButton('设置')!, refreshAllButton()!, input(), action(), repoOpenButton('owner/A')!];
    for (let i = 1; i < controls.length; i++) {
      expect(controls[i - 1]!.compareDocumentPosition(controls[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    }
    expect(controls.every(control => control.tabIndex === 0)).toBe(true);
  });

  it.each([false, true])('Refresh pending, error and resize retain one request (reduced=%s)', async (reduced) => {
    setReducedMotion(reduced); await mount(); const finish = stub.holdNextRefresh();
    const calls = stub.calls.refreshGlance; await click(refreshAllButton());
    for (const width of [1152, 899, 1152]) {
      await resize(width); expect(refreshAllButton()?.disabled).toBe(true);
      expect(refreshAllButton()?.getAttribute('aria-busy')).toBe('true');
      expect(stub.calls.refreshGlance).toBe(calls + 1);
    }
    await act(async () => finish()); await settle();
    expect(refreshAllButton()?.disabled).toBe(false);
    stub.api.refreshGlance = async () => { throw new Error('fixture'); };
    await click(refreshAllButton()); await settle();
    expect(chrome().textContent).toContain('抓取失败，请稍后重试');
    expect(viewport().textContent).not.toContain('抓取失败');
  });
});
