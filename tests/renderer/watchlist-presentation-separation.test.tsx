// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByText, click, createStub, makeGlance, openAddInput, pressEscape,
  refreshAllButton, renderApp, repoOpenButton, setViewportWidth, settle, submitForm, typeInto,
} from './helpers';

let view: RenderResult | null = null;
let stub: StubHandle;
const repository = makeGlance(1, 'owner/existing');
const stress = Array.from({ length: 5 }, () => [899, 900, 899]).flat();

afterEach(async () => {
  await view?.unmount();
  view = null;
  document.documentElement.scrollTop = 0;
  setViewportWidth(768);
  vi.restoreAllMocks();
});

async function mount(width: number): Promise<void> {
  setViewportWidth(width);
  stub = createStub({ repositories: [repository] });
  view = await renderApp(stub);
  await settle();
}

function expectPresentation(width: number): void {
  expect(document.querySelectorAll('.desktop-watchlist-view, .narrow-watchlist-view')).toHaveLength(1);
  expect(document.querySelector('.desktop-watchlist-view') !== null).toBe(width >= 900);
  expect(document.querySelector('.narrow-watchlist-view') !== null).toBe(width < 900);
  expect(document.querySelectorAll('ul.repo-list')).toHaveLength(1);
  expect(document.querySelectorAll('#add-repository-input')).toHaveLength(1);
  expect(document.querySelectorAll('.repository-sidebar-row')).toHaveLength(width >= 900 ? 1 : 0);
  expect(document.querySelectorAll('.repo-row')).toHaveLength(width < 900 ? 1 : 0);
}

async function resize(width: number): Promise<void> {
  await act(async () => setViewportWidth(width));
  await settle();
}

describe('Watchlist Desktop / Narrow presentation separation', () => {
  it.each([900, 899])('%ipx renders only its active presentation and existing list semantics', async (width) => {
    await mount(width);
    expectPresentation(width);
    expect(document.querySelector('.watchlist-page-heading')?.querySelector(width >= 900 ? 'h2' : 'h1')?.textContent).toBe('监控清单');
    expect(document.querySelector('ul.repo-list > li')?.getAttribute('data-repository-id')).toBe('1');
    expect(repoOpenButton(repository.fullName)?.tagName).toBe('BUTTON');
  });

  it('preserves the page, chrome host, input draft, count and Query through five boundary cycles without entrances', async () => {
    await mount(899);
    const input = await openAddInput();
    await typeInto(input, 'owner/unsubmitted');
    const page = document.querySelector('.watchlist-page');
    const host = input.closest('.responsive-page-host');
    const calls = { ...stub.calls };
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    for (const width of stress) {
      await resize(width);
      expectPresentation(width);
      expect(document.querySelector('.watchlist-page')).toBe(page);
      expect(document.querySelector('#add-repository-input')).toBe(input);
      expect(input.closest('.responsive-page-host')).toBe(host);
      expect(input.value).toBe('owner/unsubmitted');
      expect(input.disabled).toBe(false);
      expect(document.querySelector('.watchlist-count')?.getAttribute('aria-label')).toBe('1 个仓库');
      expect(document.querySelector('[data-highlight="true"], [data-highlight-only="true"], li[inert]')).toBeNull();
      expect(document.querySelector('li')?.style.opacity || '1').toBe('1');
    }
    expect(focus).not.toHaveBeenCalled();
    expect(stub.calls).toEqual(calls);
  });

  it('preserves selected repository and Detail Query while the sidebar presentation changes', async () => {
    await mount(900);
    await click(repoOpenButton(repository.fullName));
    await settle();
    const detail = document.querySelector('.detail-page');
    const calls = { ...stub.calls };
    for (const width of stress) {
      await resize(width);
      expect(document.querySelector('.detail-page')).toBe(detail);
      expect(document.querySelector('.repository-header-name')?.getAttribute('aria-label')).toBe(repository.fullName);
      if (width >= 900) {
        expect(repoOpenButton(repository.fullName)?.getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('.repository-sidebar-row')?.getAttribute('data-selected')).toBe('true');
      }
    }
    expect(stub.calls).toEqual(calls);
  });

  it('preserves duplicate feedback and its immediate clear action across layouts', async () => {
    await mount(899);
    const input = await openAddInput();
    await typeInto(input, repository.fullName);
    expect(document.querySelector('.watchlist-add-action')?.getAttribute('data-action-kind')).toBe('clear');
    const calls = { ...stub.calls };
    for (const width of stress) {
      await resize(width);
      expect(input.value).toBe(repository.fullName);
      expect(document.querySelectorAll('#add-repository-duplicate')).toHaveLength(1);
      expect(document.querySelector('#add-repository-duplicate')?.textContent).toContain('已在监控清单中');
      expect(document.querySelector('.watchlist-add-action')?.getAttribute('data-action-kind')).toBe('clear');
      await submitForm(input.form!);
    }
    expect(stub.calls).toEqual(calls);
    await click(document.querySelector('.watchlist-add-action'));
    expect(input.value).toBe('');
  });

  it('retains one in-flight add and one success feedback across presentation replacement', async () => {
    await mount(899);
    const input = await openAddInput();
    await typeInto(input, 'owner/new-repository');
    const release = stub.holdNextAdd();
    await submitForm(input.form!);
    await settle();
    const calls = { ...stub.calls };
    for (const width of [900, 899, 900]) {
      await resize(width);
      expect(input.disabled).toBe(true);
      expect(document.querySelectorAll('.watchlist-add-spinner')).toHaveLength(1);
      await submitForm(input.form!);
    }
    expect(stub.calls).toEqual(calls);
    release();
    await settle();
    expect(stub.calls.addRepository).toBe(1);
    expect(document.querySelectorAll('#add-repository-success')).toHaveLength(1);
    // The existing action opts into manual clear and cancels its automatic collapse.
    await click(document.querySelector('.watchlist-add-action'));
    const settledCalls = { ...stub.calls };
    for (const width of stress) {
      await resize(width);
      expect(input.value).toBe('owner/new-repository');
      expect(document.querySelectorAll('#add-repository-success')).toHaveLength(1);
      expect(document.querySelector('.watchlist-add-action')?.getAttribute('data-action-kind')).toBe('clear');
    }
    expect(stub.calls).toEqual(settledCalls);
  });

  it('preserves refresh pending/disabled state and closes a replaced menu without an orphan', async () => {
    await mount(899);
    await click(document.querySelector('.repo-actions-trigger'));
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    await resize(900);
    expect(document.querySelector('.repository-action-positioner')).toBeNull();
    expect(document.querySelector('[role="menu"], [role="dialog"], [popover]')).toBeNull();
    const release = stub.holdNextRefresh();
    await click(refreshAllButton());
    await settle();
    const calls = { ...stub.calls };
    for (const width of stress) {
      await resize(width);
      expect(refreshAllButton()?.disabled).toBe(true);
      expect(refreshAllButton()?.getAttribute('aria-busy')).toBe('true');
      await click(refreshAllButton());
    }
    expect(stub.calls).toEqual(calls);
    release();
    await settle();
    expect(refreshAllButton()?.disabled).toBe(false);
    await pressEscape();
    expect(document.body.style.pointerEvents).toBe('');
  });

  it('installs only the existing single layout listener and removes it on unmount', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')!;
    let mediaFunction = window.matchMedia;
    let subscriptions = 0;
    let removals = 0;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      get: () => (query: string) => {
        const media = mediaFunction(query);
        if (query !== '(min-width: 900px)') return media;
        const add = media.addEventListener.bind(media);
        const remove = media.removeEventListener.bind(media);
        media.addEventListener = (...args: Parameters<MediaQueryList['addEventListener']>) => { subscriptions++; add(...args); };
        media.removeEventListener = (...args: Parameters<MediaQueryList['removeEventListener']>) => { removals++; remove(...args); };
        return media;
      },
      set: (next: typeof window.matchMedia) => { mediaFunction = next; },
    });
    try {
      await mount(899);
      for (const width of stress) await resize(width);
      expect(subscriptions).toBe(1);
      expect(removals).toBe(0);
      await view!.unmount();
      view = null;
      expect(removals).toBe(1);
    } finally {
      Object.defineProperty(window, 'matchMedia', descriptor);
    }
  });
});
