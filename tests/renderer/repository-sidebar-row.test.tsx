// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Glance } from '../../src/shared/types';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByText, click, createStub, dialog, makeGlance, menu, menuItem, navButton,
  renderApp, repoActionsButton, repoMotion, repoOpenButton, repoSlot, resetReducedMotion,
  resetSystemTheme, setReducedMotion, setViewportWidth, settle, settleMotion, submitForm, typeInto,
} from './helpers';
import { readRendererStyles } from './support/styles';

const A = 'microsoft/TypeScript';
const B = 'MeteorNOX/DeepSeek-Balance-Whale-Widget';
let view: RenderResult | null = null;
let stub: StubHandle;
const sidebar = (): HTMLElement => document.querySelector('.app-shell-sidebar')!;
const listViewport = (): HTMLElement => document.querySelector('.repository-list-viewport')!;
const workspace = (): HTMLElement => document.querySelector('.app-shell-workspace')!;
const selected = (name: string): string | null | undefined => repoOpenButton(name)?.getAttribute('aria-pressed');

beforeEach(() => {
  setViewportWidth(1152);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  resetReducedMotion();
  resetSystemTheme();
  setViewportWidth(768);
  await settleMotion(64);
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function mount(repositories: Glance[] = [makeGlance(1, A), makeGlance(2, B)]): Promise<void> {
  stub = createStub({ repositories });
  view = await renderApp(stub);
  await settle();
}
async function add(name: string): Promise<void> {
  const trigger = document.querySelector('.watchlist-add-trigger')!;
  if (trigger.getAttribute('aria-expanded') !== 'true') await click(trigger);
  const input = document.querySelector<HTMLInputElement>('#add-repository-input')!;
  await typeInto(input, name);
  await submitForm(input.form!);
  await settle();
}
async function remove(name: string, remaining: Glance[]): Promise<void> {
  await click(repoActionsButton(name));
  await click(menuItem('从监控清单移除'));
  await settle();
  stub.setRepositories(remaining);
  await click(buttonByText('移除'));
  await settle();
}

describe('Compact Repository Sidebar', () => {
  it.each([900, 1152, 1366])('%ipx uses compact rows without Stars or fetched time', async (width) => {
    setViewportWidth(width);
    await mount();
    expect(sidebar().querySelectorAll('.repository-sidebar-row')).toHaveLength(2);
    expect(sidebar().querySelector('.repo-row')).toBeNull();
    expect(sidebar().textContent).not.toContain('Stars');
    expect(sidebar().textContent).not.toContain('抓取于');
    expect(repoOpenButton(A)?.textContent).toContain('v1.0.1');
    expect(repoOpenButton(A)?.querySelector('.repository-sidebar-activity')?.getAttribute('aria-label')).toContain('最近活动');
    expect(repoActionsButton(A)?.getAttribute('aria-expanded')).toBe('false');
    expect(selected(A)).toBe('false');
    expect(stub.calls.fetchDetail).toBe(0);
  });

  it.each([899, 768, 480])('%ipx keeps the legacy large Card', async (width) => {
    setViewportWidth(width);
    await mount();
    expect(document.querySelector('.repository-sidebar-row')).toBeNull();
    expect(document.querySelectorAll('.repo-row')).toHaveLength(2);
    expect(repoOpenButton(A)?.textContent).toContain('Stars');
    expect(repoOpenButton(A)?.textContent).toContain('抓取于');
    expect(repoOpenButton(A)?.hasAttribute('aria-pressed')).toBe(false);
  });

  it('switches selection while preserving row, list and Sidebar scroll identity', async () => {
    await mount();
    const slot = sidebar(), a = repoSlot(A), b = repoSlot(B), list = document.querySelector('.repo-list');
    listViewport().scrollTop = 460;
    await click(repoOpenButton(A));
    await settle();
    expect(selected(A)).toBe('true');
    expect(selected(B)).toBe('false');
    expect(workspace().textContent).toContain(A);
    workspace().scrollTop = 300;
    await click(repoOpenButton(B));
    await settle();
    expect(selected(A)).toBe('false');
    expect(selected(B)).toBe('true');
    expect(workspace().textContent).toContain(B);
    expect(workspace().scrollTop).toBe(0);
    expect(sidebar()).toBe(slot);
    expect(listViewport().scrollTop).toBe(460);
    expect(repoSlot(A)).toBe(a);
    expect(repoSlot(B)).toBe(b);
    expect(document.querySelector('.repo-list')).toBe(list);
  });

  it('clicking the selected row keeps Detail mounted, scroll and fetch count', async () => {
    await mount();
    await click(repoOpenButton(A));
    await settle();
    const detail = workspace().querySelector('.repo-context-scope');
    const count = stub.calls.fetchDetail;
    workspace().scrollTop = 330;
    await click(repoOpenButton(A));
    await settle();
    expect(workspace().querySelector('.repo-context-scope')).toBe(detail);
    expect(workspace().scrollTop).toBe(330);
    expect(stub.calls.fetchDetail).toBe(count);
  });

  it('has sibling primary / menu buttons, keyboard focus and selected semantics', async () => {
    await mount();
    const button = repoOpenButton(B)!;
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);
    expect(button.contains(repoActionsButton(B))).toBe(false);
    await click(button);
    expect(selected(B)).toBe('true');
    expect(document.activeElement).toBe(button);
    await click(repoActionsButton(B));
    expect(menu()).not.toBeNull();
    expect(stub.calls.fetchDetail).toBe(1);
  });

  it.each(['v7.0.2', 'v2026.10.1-beta.12', 'release-candidate-very-long-tag-name'])('keeps full name and release %s available with truncation contracts', async (tag) => {
    const name = B + '-Even-Longer-Repository-Name';
    await mount([{ ...makeGlance(1, name), latestReleaseTag: tag, stars: 1000000000 }]);
    const button = repoOpenButton(name)!;
    expect(button.title).toBe(name);
    expect(button.querySelector('.repository-sidebar-name')?.textContent).toBe(name);
    expect(button.querySelector('.repository-sidebar-release')?.getAttribute('title')).toBe(tag);
    expect(button.querySelector('.repository-sidebar-activity')).not.toBeNull();
    expect(repoActionsButton(name)).not.toBeNull();
    const css = readRendererStyles();
    const truncation = css.match(/\.repository-sidebar-name,\s*\.repository-sidebar-release\s*\{[^}]+\}/)?.[0];
    expect(truncation).toContain('min-width: 0');
    expect(truncation).toContain('text-overflow: ellipsis');
    expect(truncation).toContain('white-space: nowrap');
    expect(css).toMatch(/\.repository-sidebar-activity\s*\{[^}]*flex: none/);
    expect(css).toContain('.repository-sidebar-activator:focus-visible');
  });

  it('keeps the existing no-release wording and handles missing activity', async () => {
    await mount([{ ...makeGlance(1, A), latestReleaseTag: null, pushedAt: null }]);
    expect(repoOpenButton(A)?.textContent).toContain('无发版');
    expect(repoOpenButton(A)?.querySelector('.repository-sidebar-activity')?.textContent?.trim()).toBe('—');
  });

  it('initial rows stay idle; add enters without replacing existing row DOM', async () => {
    await mount();
    const a = repoSlot(A);
    expect(repoMotion(A)).toBe('idle');
    expect(a?.dataset.highlight).toBeUndefined();
    await add('owner/new');
    expect(repoMotion('owner/new')).toBe('entering');
    expect(repoSlot('owner/new')?.dataset.highlight).toBe('true');
    expect(repoSlot(A)).toBe(a);
    expect(repoSlot('owner/new')?.querySelector('.repository-sidebar-row')).not.toBeNull();
    await settleMotion(1000);
    expect(repoMotion('owner/new')).toBe('idle');
    expect(repoSlot('owner/new')?.dataset.highlight).toBeUndefined();
    expect(stub.calls.fetchDetail).toBe(0);
  });

  it('keeps exit DOM inert until completion and survivor identity unchanged', async () => {
    await mount();
    const b = repoSlot(B);
    await remove(A, [makeGlance(2, B)]);
    expect(repoMotion(A)).toBe('exiting');
    expect(repoOpenButton(A)?.disabled).toBe(true);
    expect(repoSlot(B)).toBe(b);
    expect(dialog()).toBeNull();
    await settleMotion(400);
    expect(repoSlot(A)).toBeNull();
    expect(repoSlot(B)).toBe(b);
  });

  it('removing the selected repository returns Workspace to empty without choosing another', async () => {
    await mount();
    await click(repoOpenButton(A));
    await settle();
    const count = stub.calls.fetchDetail;
    await remove(A, [makeGlance(2, B)]);
    expect(workspace().querySelector('.workspace-empty')).not.toBeNull();
    expect(workspace().querySelector('.repo-context-scope')).toBeNull();
    expect(selected(B)).toBe('false');
    expect(stub.calls.fetchDetail).toBe(count);
  });

  it('failed removal keeps selection and Detail visible', async () => {
    await mount();
    stub.api.removeRepository = async () => { throw new Error('offline'); };
    await click(repoOpenButton(A));
    await settle();
    await remove(A, [makeGlance(1, A), makeGlance(2, B)]);
    expect(dialog()?.textContent).toContain('删除失败');
    expect(selected(A)).toBe('true');
    expect(workspace().textContent).toContain(A);
    expect(repoSlot(A)?.hasAttribute('inert')).toBe(false);
  });

  it('removing a different repo keeps the current Detail; removing the last repo preserves both empty states', async () => {
    await mount();
    await click(repoOpenButton(B));
    await settle();
    const detail = workspace().querySelector('.repo-context-scope');
    await remove(A, [makeGlance(2, B)]);
    await settleMotion(400);
    expect(workspace().querySelector('.repo-context-scope')).toBe(detail);
    expect(selected(B)).toBe('true');
    await remove(B, []);
    await settleMotion(400);
    expect(sidebar().textContent).toContain('还没有监控仓库');
    expect(document.querySelector<HTMLUListElement>('.repo-list')?.hidden).toBe(true);
    expect(workspace().querySelector('.workspace-empty')).not.toBeNull();
  });

  it('settings clears selected state; returning to a repo selects that workspace', async () => {
    await mount();
    await click(repoOpenButton(A));
    await click(navButton('设置'));
    await settle();
    expect(selected(A)).toBe('false');
    await click(repoOpenButton(B));
    await settle();
    expect(selected(A)).toBe('false');
    expect(selected(B)).toBe('true');
  });

  it('View location targets the compact row, then highlights after Sidebar scroll settles', async () => {
    await mount(Array.from({ length: 25 }, (_, i) => makeGlance(i + 1, `owner/repo-${i}`)));
    const root = listViewport();
    root.scrollTop = 600;
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 700 });
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 2400 });
    const scroll = vi.spyOn(window, 'scrollTo');
    await add('owner/new');
    const target = repoSlot('owner/new')!;
    const reveal = vi.spyOn(target, 'scrollIntoView');
    await click(buttonByText('查看位置'));
    expect(reveal).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    await act(async () => {
      root.dispatchEvent(new Event('scroll'));
      root.dispatchEvent(new Event('scrollend'));
    });
    expect(target.dataset.highlightOnly).toBe('true');
    expect(target.dataset.highlight).toBeUndefined();
    expect(scroll).not.toHaveBeenCalled();
    await settleMotion(900);
    expect(target.dataset.highlightOnly).toBeUndefined();
  });

  it('top-layer menu follows anchor position changes without resize or scroll events', async () => {
    await mount();
    const trigger = repoActionsButton(A)!;
    let y = 100;
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => new DOMRect(260, y, 32, 32));
    await click(trigger);
    await settle();
    const surface = document.querySelector<HTMLElement>('.repository-action-positioner')!;
    expect(surface.dataset.shellOverlay).toBe('true');
    const before = surface.style.getPropertyValue('--overlay-top');
    y += 74;
    await settleMotion(64);
    expect(surface.style.getPropertyValue('--overlay-top')).not.toBe(before);
    expect(surface.style.getPropertyValue('--overlay-top')).toBe(`${y + 32 + 8}px`);
    expect(menu()).not.toBeNull();
    expect(repoActionsButton(A)).toBe(trigger);
  });

  it('instant parent layout changes update the menu before the next animation frame', async () => {
    setReducedMotion(true);
    await mount();
    const trigger = repoActionsButton(A)!;
    let top = 120;
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => new DOMRect(260, top, 32, 32));
    await click(trigger);
    await settle();
    const surface = document.querySelector<HTMLElement>('.repository-action-positioner')!;
    const before = surface.style.getPropertyValue('--overlay-top');
    top += 100;
    await act(async () => { listViewport().append(document.createElement('div')); });
    await settle();
    expect(surface.style.getPropertyValue('--overlay-top')).not.toBe(before);
    expect(surface.style.getPropertyValue('--overlay-top')).toBe(`${top + 40}px`);
    expect(menu()).not.toBeNull();
  });

  it('25 repos allow continuous selection without remount or resetting Sidebar scroll', async () => {
    const repos = Array.from({ length: 25 }, (_, i) => makeGlance(i + 1, `owner/repo-${i}`));
    await mount(repos);
    const nodes = repos.map((repo) => repoSlot(repo.fullName));
    listViewport().scrollTop = 680;
    for (const repo of repos) {
      await click(repoOpenButton(repo.fullName));
      await settle();
      expect(selected(repo.fullName)).toBe('true');
    }
    expect(listViewport().scrollTop).toBe(680);
    expect(repos.map((repo) => repoSlot(repo.fullName))).toEqual(nodes);
    expect(sidebar().querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  });

  it('Reduced Motion keeps new rows immediately readable and preserves removal', async () => {
    setReducedMotion(true);
    await mount();
    await add('owner/new');
    expect(repoMotion('owner/new')).toBe('idle');
    expect(repoSlot('owner/new')?.style.transform).not.toMatch(/translate|scale/);
    await remove('owner/new', [makeGlance(1, A), makeGlance(2, B)]);
    await settleMotion(100);
    expect(repoSlot('owner/new')).toBeNull();
  });
});
