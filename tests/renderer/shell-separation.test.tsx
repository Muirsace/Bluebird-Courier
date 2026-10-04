// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_SHELL_QUERY, useLayoutMode } from '../../src/renderer/lib/app-layout';
import type { RenderResult, StubHandle } from './helpers';
import {
  click, createStub, makeGlance, navButton, openAddInput, renderApp, repoOpenButton,
  setViewportWidth, settle, tab, typeInto,
} from './helpers';

let view: RenderResult | null = null;
let stub: StubHandle;
const repo = makeGlance(1, 'owner/A');
const boundaryStress = [
  ...Array.from({ length: 5 }, () => [899, 900, 899]).flat(),
  ...Array.from({ length: 3 }, () => [900, 901, 900]).flat(),
];
const journey = [1180, 901, 900, 899, 768, 480, 899, 900, 1180];

afterEach(async () => {
  await view?.unmount();
  view = null;
  document.documentElement.scrollTop = 0;
  setViewportWidth(768);
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'windowControlsOverlay');
});

async function mount(width: number): Promise<void> {
  setViewportWidth(width);
  stub = createStub({ repositories: [repo] });
  view = await renderApp(stub);
  await settle();
}

function expectShell(width: number): void {
  const desktop = width >= 900;
  expect(document.querySelectorAll('.app-frame')).toHaveLength(1);
  expect(document.querySelector('.desktop-app-shell') !== null).toBe(desktop);
  expect(document.querySelector('.narrow-app-shell') !== null).toBe(!desktop);
  expect(document.querySelector('.app-frame')?.getAttribute('data-desktop')).toBe(String(desktop));
  expect(document.querySelectorAll('.desktop-sidebar-brand, .app-global-header')).toHaveLength(1);
  const header = document.querySelector(desktop ? '.desktop-sidebar-brand' : '.app-global-header');
  expect(header?.classList.contains('window-drag-region')).toBe(true);
  expect(document.querySelectorAll('nav[aria-label="页面导航"]')).toHaveLength(desktop ? 0 : 1);
  expect(document.querySelectorAll('.desktop-sidebar-brand button, .app-global-header nav button')).toHaveLength(1);
  expect(document.querySelector('.app-shell-workspace > .window-drag-region') !== null).toBe(desktop);
}

async function resize(width: number): Promise<void> {
  await act(async () => setViewportWidth(width));
  await settle();
  expectShell(width);
}

describe('DesktopAppShell / NarrowAppShell separation', () => {
  it.each([899, 900])('%ipx initially renders exactly one shell and switches both ways', async width => {
    const overlay = Object.assign(new EventTarget(), {
      visible: true,
      getTitlebarAreaRect: () => new DOMRect(0, 0, 760, 52),
    });
    Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });
    await mount(width);
    expectShell(width);
    for (const next of [899, 900, 899]) {
      await resize(next);
      expect(document.documentElement.hasAttribute('data-window-controls-overlay')).toBe(true);
    }
  });

  it('keeps the real Watchlist input, page and portal host through boundary stress and scroll restoration', async () => {
    await mount(899);
    const field = await openAddInput();
    await typeInto(field, 'owner/unsubmitted');
    const page = document.querySelector('.watchlist-page');
    const host = page?.closest('.responsive-page-host');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const calls = { ...stub.calls };
    document.documentElement.scrollTop = 400;
    let sidebarScroll = 0;
    for (const width of [...boundaryStress, ...journey]) {
      await resize(width);
      expect(document.querySelector('.watchlist-page')).toBe(page);
      expect(page?.closest('.responsive-page-host')).toBe(host);
      expect(document.querySelector('#add-repository-input')).toBe(field);
      expect(field.value).toBe('owner/unsubmitted');
      if (width >= 900) {
        const root = document.querySelector<HTMLElement>('[data-app-scroll-root="sidebar"]')!;
        expect(root.scrollTop).toBe(sidebarScroll);
        root.scrollTop = sidebarScroll = 240;
      } else {
        expect(window.scrollY).toBe(400);
        expect(document.querySelector('.view-transition')?.hasAttribute('data-view-motion')).toBe(false);
      }
    }
    expect(focus).not.toHaveBeenCalled();
    expect(stub.calls).toEqual(calls);
  });

  it('keeps the selected repository, Detail instance, Trend panel and fetch counts through repeated boundaries', async () => {
    await mount(899);
    await click(repoOpenButton(repo.fullName));
    await settle();
    await click(tab('趋势'));
    const page = document.querySelector('.detail-page');
    const host = page?.closest('.responsive-page-host');
    const trend = tab('趋势');
    const panel = document.querySelector('[role="tabpanel"]');
    const calls = { ...stub.calls };
    for (const width of [...journey, ...boundaryStress]) {
      await resize(width);
      expect(document.querySelector('.detail-page')).toBe(page);
      expect(page?.closest('.responsive-page-host')).toBe(host);
      expect(tab('趋势')).toBe(trend);
      expect(trend?.getAttribute('aria-selected')).toBe('true');
      expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
      expect(document.querySelector('.repository-header-name')?.getAttribute('aria-label')).toBe(repo.fullName);
      if (width >= 900) expect(repoOpenButton(repo.fullName)?.getAttribute('aria-pressed')).toBe('true');
    }
    expect(stub.calls.fetchDetail).toBe(1);
    expect(stub.calls).toEqual(calls);
  });

  it('keeps Settings and its token draft mounted through repeated boundaries', async () => {
    await mount(899);
    await click(navButton('设置'));
    await settle();
    const page = document.querySelector('.settings-page');
    const field = document.querySelector<HTMLInputElement>('#accessToken-input')!;
    await typeInto(field, 'fixture-unsubmitted-token');
    const calls = { ...stub.calls };
    for (const width of boundaryStress) {
      await resize(width);
      expect(document.querySelector('.settings-page')).toBe(page);
      expect(document.querySelector('#accessToken-input')).toBe(field);
      expect(field.value).toBe('fixture-unsubmitted-token');
      expect(document.querySelector('.detail-page')).toBeNull();
    }
    expect(stub.calls).toEqual(calls);
  });

  it('uses one media listener and calls beforeChange only when LayoutMode changes', async () => {
    let matches = false;
    const media = new EventTarget();
    Object.defineProperty(media, 'matches', { get: () => matches });
    const add = vi.spyOn(media, 'addEventListener');
    const remove = vi.spyOn(media, 'removeEventListener');
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue(media as MediaQueryList);
    const beforeChange = vi.fn();
    function Probe() {
      const mode = useLayoutMode(beforeChange);
      return <output>{mode}</output>;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Probe />));
      expect(container.textContent).toBe('narrow');
      for (const next of [true, true, false, false]) {
        await act(async () => {
          matches = next;
          media.dispatchEvent(new Event('change'));
        });
        expect(container.textContent).toBe(next ? 'desktop' : 'narrow');
      }
      expect(beforeChange.mock.calls).toEqual([['desktop'], ['narrow']]);
      expect(matchMedia.mock.calls.every(([query]) => query === DESKTOP_SHELL_QUERY)).toBe(true);
      expect(add).toHaveBeenCalledExactlyOnceWith('change', expect.any(Function));
    } finally {
      await act(async () => root.unmount());
    }
    expect(remove).toHaveBeenCalledExactlyOnceWith('change', add.mock.calls[0]![1]);
  });
});
