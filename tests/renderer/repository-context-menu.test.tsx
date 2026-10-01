// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseContextPlacement, VIEWPORT_SAFE_GAP } from '../../src/renderer/lib/overlay-placement';
import type { RenderResult, StubHandle } from './helpers';
import { buttonByText, click, createStub, dialog, makeGlance, menu, menuItem, navButton,
  openRepositoryActions, pressEscape, renderApp, repoActionsButton, repoOpenButton, repoSlot,
  resetReducedMotion, setReducedMotion, setViewportWidth, settle, settleMotion,
  settleOverlayClose, submitForm, typeInto } from './helpers';
import { readRendererStyles } from './support/styles';

const A = 'owner/A', B = 'owner/B';
let view: RenderResult | null = null;
let stub: StubHandle;
const root = (): HTMLElement => document.querySelector('.repository-list-viewport')!;
const surface = (): HTMLElement | null => document.querySelector('.repository-action-positioner');
beforeEach(() => {
  setViewportWidth(1152);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});
afterEach(async () => {
  await view?.unmount(); view = null;
  setViewportWidth(768); resetReducedMotion();
  await settleMotion(64); vi.useRealTimers(); vi.restoreAllMocks();
});
async function mount(): Promise<void> {
  stub = createStub({ repositories: [makeGlance(1, A), makeGlance(2, B)] });
  view = await renderApp(stub); await settle();
}
async function rightClick(name: string, x = 280, y = 160): Promise<MouseEvent> {
  const event = new MouseEvent('contextmenu', { button: 2, clientX: x, clientY: y, bubbles: true, cancelable: true });
  await act(async () => { repoOpenButton(name)!.dispatchEvent(event); });
  await settle(); return event;
}
async function keyboard(name: string, key = 'F10'): Promise<KeyboardEvent> {
  const row = repoOpenButton(name)!;
  const event = new KeyboardEvent('keydown', { key, shiftKey: key === 'F10', bubbles: true, cancelable: true });
  await act(async () => { row.focus(); row.dispatchEvent(event); });
  await settle(); return event;
}

describe('Desktop repository object actions', () => {
  it.each([A, B])('right-click %s targets its actions without selecting or fetching', async (target) => {
    await mount(); await click(repoOpenButton(A)); await settle();
    const panel = document.querySelector('[role="tabpanel"]');
    const calls = stub.calls.fetchDetail;
    expect((await rightClick(target)).defaultPrevented).toBe(true);
    expect(menu()?.querySelector('button')?.getAttribute('aria-label')).toBe(`在 GitHub 打开 ${target}`);
    expect(repoOpenButton(A)?.getAttribute('aria-pressed')).toBe('true');
    expect(repoOpenButton(B)?.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    expect(stub.calls.fetchDetail).toBe(calls);
    expect(repoActionsButton(target)).toBeNull();
  });

  it.each(['F10', 'ContextMenu'])('%s opens the same menu and Esc restores the row', async (key) => {
    await mount(); const row = repoOpenButton(B)!;
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 100, 295, 72));
    expect((await keyboard(B, key)).defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    expect(surface()?.style.getPropertyValue('--overlay-top')).toBe('136px');
    expect(document.activeElement).toBe(menuItem('在 GitHub 打开'));
    await pressEscape(); await settleOverlayClose();
    expect(menu()).toBeNull(); expect(document.activeElement).toBe(row);
    expect(stub.calls.fetchDetail).toBe(0);
  });

  it('plain F10 is not a context gesture', async () => {
    await mount();
    await act(async () => repoOpenButton(B)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', bubbles: true })));
    expect(menu()).toBeNull();
  });

  it('Chromium keyboard contextmenu with coordinates retains keyboard focus restoration', async () => {
    await mount(); await keyboard(B, 'ContextMenu');
    await act(async () => repoOpenButton(B)!.dispatchEvent(new MouseEvent('contextmenu', {
      button: 0, clientX: 170, clientY: 250, bubbles: true, cancelable: true,
    })));
    await settle(); await pressEscape(); await settleOverlayClose();
    expect(document.activeElement).toBe(repoOpenButton(B));
  });

  it('mouse Esc/cancel never forcibly focuses a row', async () => {
    await mount(); const row = repoOpenButton(B)!;
    const focus = vi.spyOn(row, 'focus');
    await rightClick(B); await pressEscape(); await settleOverlayClose();
    expect(focus).not.toHaveBeenCalled();
    await rightClick(B); await click(menuItem('从监控清单移除')); await settle();
    await click(buttonByText('取消')); await settleOverlayClose();
    expect(focus).not.toHaveBeenCalled(); expect(menu()).toBeNull();
  });

  it('menu Esc is consumed before Omnibox and preserves the draft input', async () => {
    await mount();
    const input = document.querySelector<HTMLInputElement>('#add-repository-input')!;
    await typeInto(input, 'owner/draft'); await rightClick(B);
    await pressEscape(); await settleOverlayClose();
    expect(menu()).toBeNull(); expect(input.value).toBe('owner/draft');
  });

  it.each(['scroll', 'resize', 'blur'])('%s closes immediately with no orphan surface', async (type) => {
    await mount(); await rightClick(B);
    await act(async () => (type === 'scroll' ? root() : window).dispatchEvent(new Event(type)));
    expect(surface()).toBeNull(); expect(menu()).toBeNull();
  });

  it.each(['scroll', 'resize'])('keyboard %s dismissal restores the still-connected row', async (type) => {
    await mount(); await keyboard(B);
    await act(async () => (type === 'scroll' ? root() : window).dispatchEvent(new Event(type)));
    expect(surface()).toBeNull(); expect(document.activeElement).toBe(repoOpenButton(B));
  });

  it('Settings navigation closes even when the Workspace was unselected', async () => {
    await mount(); await rightClick(B); await click(navButton('设置')); await settle();
    expect(surface()).toBeNull(); expect(document.querySelector('.settings-page')).not.toBeNull();
  });

  it('switching context targets keeps exactly one menu, including reopening the same target', async () => {
    await mount(); await rightClick(A); await rightClick(B); await rightClick(B, 290, 180);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(surface()?.style.getPropertyValue('--overlay-top')).toBe('180px');
    expect(menu()?.textContent).toContain('在 GitHub 打开');
    expect(stub.calls.fetchDetail).toBe(0);
  });

  it('coordinates stay clamped while changing the same surface from menu to confirm', async () => {
    await mount(); await rightClick(B, window.innerWidth - 1, window.innerHeight - 1);
    const positioner = surface()!;
    const content = document.querySelector<HTMLElement>('.repository-action-content')!;
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 288, 180));
    await click(menuItem('从监控清单移除')); await settle();
    expect(surface()).toBe(positioner); expect(dialog()).not.toBeNull();
    expect(parseFloat(positioner.style.getPropertyValue('--overlay-y'))).toBeGreaterThanOrEqual(VIEWPORT_SAFE_GAP);
    expect(parseFloat(positioner.style.getPropertyValue('--overlay-right'))).toBeGreaterThanOrEqual(VIEWPORT_SAFE_GAP);
  });

  it.each([104, 200])('confirmation grows right from the stable menu left edge at x=%i', async (x) => {
    await mount(); await rightClick(B, x, 160);
    const positioner = surface()!;
    const right = parseFloat(positioner.style.getPropertyValue('--overlay-right'));
    const menuLeft = window.innerWidth - right - 176;
    const menuTop = positioner.style.getPropertyValue('--overlay-y');
    await click(menuItem('从监控清单移除')); await settle();
    expect(surface()).toBe(positioner);
    const width = parseFloat(positioner.style.getPropertyValue('--overlay-width'));
    const left = window.innerWidth - parseFloat(positioner.style.getPropertyValue('--overlay-right')) - width;
    expect(left).toBe(menuLeft);
    expect(parseFloat(positioner.style.getPropertyValue('--overlay-left'))).toBe(menuLeft);
    expect(positioner.style.getPropertyValue('--overlay-y')).toBe(menuTop);
  });

  it('confirmation clamps to the viewport right edge when its larger width does not fit', async () => {
    await mount(); await rightClick(B, window.innerWidth - 200, 160);
    const positioner = surface()!;
    await click(menuItem('从监控清单移除')); await settle();
    expect(parseFloat(positioner.style.getPropertyValue('--overlay-right'))).toBe(VIEWPORT_SAFE_GAP);
  });

  it('menu / confirmation / row focus transfers never scroll the context source list', async () => {
    await mount();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await keyboard(B);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    await click(menuItem('从监控清单移除')); await settle();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    await pressEscape(); await settleOverlayClose();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it('list add closes an open menu and keeps target/survivor identity', async () => {
    await mount(); const row = repoSlot(B);
    await rightClick(B);
    const input = document.querySelector<HTMLInputElement>('#add-repository-input')!;
    await typeInto(input, 'owner/new'); await submitForm(input.form!); await settle();
    expect(surface()).toBeNull(); expect(repoSlot(B)).toBe(row);
  });

  it('inert/exiting targets reject mouse and keyboard gestures', async () => {
    await mount(); await openRepositoryActions(B); await click(menuItem('从监控清单移除'));
    stub.setRepositories([makeGlance(1, A)]);
    await click(buttonByText('移除')); await settle();
    expect(repoSlot(B)?.hasAttribute('inert')).toBe(true); expect(surface()).toBeNull();
    await rightClick(B); await keyboard(B);
    expect(surface()).toBeNull(); await settleMotion(300);
    expect(repoSlot(B)).toBeNull();
  });

  it('external open uses the safe bridge for the context target and leaves selection intact', async () => {
    await mount(); await rightClick(B); await click(menuItem('在 GitHub 打开')); await settleOverlayClose();
    expect(stub.externalTargets).toEqual([{ kind: 'repository', owner: 'owner', name: 'B' }]);
    expect(stub.calls.fetchDetail).toBe(0); expect(menu()).toBeNull();
  });

  it('a late external error after resize cannot reopen or poison a new menu', async () => {
    await mount(); let finish!: (value: { ok: false; reason: 'open_failed' }) => void;
    stub.api.openGitHubExternal = () => new Promise(resolve => { finish = resolve; });
    await rightClick(A); await click(menuItem('在 GitHub 打开'));
    await act(async () => window.dispatchEvent(new Event('resize')));
    await rightClick(A);
    await act(async () => finish({ ok: false, reason: 'open_failed' })); await settle();
    expect(menu()?.getAttribute('aria-busy')).toBe('false'); expect(menu()?.querySelector('[role="alert"]')).toBeNull();
  });

  it('Reduced Motion shares the confirmation and focus lifecycle', async () => {
    setReducedMotion(true); await mount(); await keyboard(B, 'ContextMenu');
    await click(menuItem('从监控清单移除')); await settle();
    expect(document.querySelector('.repository-action-content-out')).toBeNull();
    await pressEscape(); await settleOverlayClose();
    expect(document.activeElement).toBe(repoOpenButton(B)); expect(surface()).toBeNull();
  });

  it.each([899, 768, 480])('Narrow %ipx retains visible button actions and native right-click behavior', async (width) => {
    setViewportWidth(width); await mount();
    expect(repoActionsButton(B)?.textContent?.trim()).toBe('···');
    expect((await rightClick(B)).defaultPrevented).toBe(false); expect(menu()).toBeNull();
    await keyboard(B); expect(menu()).toBeNull();
    await click(repoActionsButton(B)); expect(menu()).not.toBeNull();
    expect(surface()?.dataset.contextPoint).toBeUndefined();
  });
});

describe('Cursor menu viewport geometry', () => {
  it.each([{ x: 1, y: 1 }, { x: 899, y: 799 }, { x: 880, y: 30 }, { x: 10, y: 790 }, { x: 2000, y: -20 }])('clamps all edges at $x / $y', (point) => {
    const p = chooseContextPlacement(point, 288, 180, 900, 800);
    const left = 900 - p.right - 288;
    const top = p.placement === 'top' ? 800 - p.edge - 180 : p.edge;
    expect(left).toBeGreaterThanOrEqual(12); expect(left + 288).toBeLessThanOrEqual(888);
    expect(top).toBeGreaterThanOrEqual(12); expect(top + 180).toBeLessThanOrEqual(788);
  });
  it('oversized content gets viewport limits for internal scrolling', () => {
    const p = chooseContextPlacement({ x: 290, y: 190 }, 288, 500, 300, 200);
    expect(p.maxWidth).toBe(276); expect(p.maxHeight).toBe(176);
    expect(p.edge).toBe(12); expect(p.right).toBe(12);
  });
});

describe('Desktop visual contracts', () => {
  it('flat inset dividers keep row geometry and selection ownership', () => {
    const css = readRendererStyles();
    expect(css).toMatch(/\.repository-sidebar-row\s*\{[^}]*height: 72px/);
    expect(css).toMatch(/\.repository-sidebar-list[^}]*\.repository-sidebar-row::after\s*\{[^}]*position: absolute;[^}]*inset: auto 12px -1px 20px;[^}]*height: 1px/);
    expect(css).toMatch(/\.repository-sidebar-row\[data-selected='true'\]::after[^}]*background: transparent/);
    expect(css).not.toContain('padding-right: 36px');
    expect(css).toMatch(/\.repository-sidebar-release\s*\{[^}]*color: rgb\(var\(--color-text-secondary\)\)/);
    expect(css).toContain('.repository-sidebar-activator:focus-visible');
    expect(css).toContain(".repository-sidebar-row[data-selected='true']:has(.repository-action-positioner)");
  });
  it('scrollbar / omnibox / compact context / cards use existing tokens and scoped styles', () => {
    const css = readRendererStyles();
    expect(css).toContain('.repository-list-viewport::-webkit-scrollbar-thumb');
    expect(css).toContain("[data-theme='dark'] .repository-list-viewport::-webkit-scrollbar-thumb");
    expect(css).toContain(".watchlist-add-form[data-omnibox='true'] input:focus-visible");
    expect(css).toContain('.workspace-repo-context .compact-repo-context > span:last-child');
    expect(css).toContain(".detail-page[data-workspace='true'] .detail-content-responsive section:not([data-metric])");
  });
});
