// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRendererStyles } from './support/styles';
import { click, createStub, makeGlance, menu, openRepositoryActions, renderApp, repoOpenButton,
  setViewportWidth, settle, submitForm, typeInto } from './helpers';
import type { RenderResult, StubOptions } from './helpers';

let view: RenderResult | null = null;
const input = (): HTMLInputElement => document.querySelector('#add-repository-input')!;
const action = (): HTMLButtonElement => document.querySelector('.watchlist-add-action')!;
beforeEach(() => setViewportWidth(1152));
afterEach(async () => { await view?.unmount(); view = null; setViewportWidth(768); vi.unstubAllGlobals(); });
async function mount(options: StubOptions = {}) {
  const stub = createStub({ repositories: [makeGlance(1, 'owner/existing')], ...options });
  view = await renderApp(stub); await settle(); return stub;
}
async function clearWithoutFlash() {
  const outgoing = action();
  expect(outgoing.querySelector('.repository-omnibox-clear-icon')).not.toBeNull();
  await click(outgoing);
  expect(input().value).toBe('');
  expect(action()).toBe(outgoing);
  expect(outgoing.querySelector('.repository-omnibox-add-icon')).toBeNull();
  expect(outgoing.querySelector('.repository-omnibox-clear-icon')).not.toBeNull();
  expect(outgoing.getAttribute('aria-hidden')).toBe('true');
  expect(outgoing.getAttribute('aria-label')).toBeNull();
  expect(outgoing.disabled).toBe(true);
  expect(outgoing.tabIndex).toBe(-1);
  expect(input().getAttribute('aria-describedby')).toBeNull();
  expect(document.activeElement).toBe(input());
  await settle();
  expect(outgoing.querySelector('.repository-omnibox-add-icon')).toBeNull();
}

describe('Shell-7B outgoing Omnibox action', () => {
  it.each(['abc', '1', 'bad input'])('clear %s freezes X throughout exit and preserves focus/ARIA', async value => {
    const stub = await mount(); await typeInto(input(), value); await clearWithoutFlash();
    expect(stub.calls.addRepository).toBe(0);
  });
  it('duplicate confirming → manual clear → exit keeps X', async () => {
    const stub = await mount(); await typeInto(input(), 'owner/existing'); await click(action());
    expect(action().dataset.actionKind).toBe('clear'); await clearWithoutFlash();
    expect(stub.calls.removeRepository).toBe(0); expect(stub.calls.addRepository).toBe(0);
  });
  it('success confirming → manual clear → exit keeps X', async () => {
    const stub = await mount(); await typeInto(input(), 'owner/new'); await submitForm(input().form!); await settle();
    await click(action()); await clearWithoutFlash(); expect(stub.calls.addRepository).toBe(1);
  });
  it('remote error clear keeps X', async () => {
    await mount({ addResult: {ok:false,repository:null,error:{kind:'unknown',message:'failed'}} });
    await typeInto(input(), 'owner/new'); await submitForm(input().form!); await settle(); await clearWithoutFlash();
  });
  it('rapid clear/type uses the new action immediately without retaining stale X on Add', async () => {
    await mount();
    for (let i = 0; i < 20; i++) {
      await typeInto(input(), '1'); await clearWithoutFlash();
      await typeInto(input(), 'owner/new');
      expect(action().querySelector('.repository-omnibox-add-icon')).not.toBeNull();
      expect(action().getAttribute('aria-label')).toBe('添加仓库');
    }
  });
});

describe('Shell-7B press geometry and context guards', () => {
  it.each(['Shift+F10', 'ContextMenu'])('%s opens context without left press', async key => {
    await mount(); const button = repoOpenButton('owner/existing')!;
    button.focus();
    await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', {key:key==='Shift+F10'?'F10':key,shiftKey:key==='Shift+F10',bubbles:true,cancelable:true})));
    await settle(); expect(menu()).not.toBeNull();
    expect(button.closest('.repository-sidebar-row')?.hasAttribute('data-pressed')).toBe(false);
  });
  it('press plane leaves divider/selected indicator on the stationary 72px row', async () => {
    await mount(); await click(repoOpenButton('owner/existing')); await settle();
    const row = repoOpenButton('owner/existing')!.closest('.repository-sidebar-row')!;
    expect(row.querySelector(':scope > .repository-sidebar-press-surface > [data-row-activator]')).not.toBeNull();
    await openRepositoryActions('owner/existing'); expect(row.getAttribute('data-selected')).toBe('true');
  });
});

describe('Shell-7B shared CSS and header contracts', () => {
  const css = readRendererStyles();
  it('shares the actual Narrow transform and easing on a visual plane', () => {
    expect(css).toMatch(/\.repo-row:has\(\[data-row-activator\]:active\),\s*\.repository-sidebar-row[^}]+> \.repository-sidebar-press-surface\s*\{[^}]*translate: 0 1px;[^}]*scale: 0.985;[^}]*var\(--motion-ease-in\)/);
  });
  it('wide sticky offset is zero without changing the compact host or observer offset', () => {
    expect(css).toMatch(/@media \(min-width: 1152px\)[\s\S]*?--workspace-sticky-offset: 0px/);
    expect(css).toContain('--workspace-sticky-offset: var(--workspace-context-height)');
    expect(css).toContain('top: var(--workspace-sticky-offset)');
    expect(css).toContain('height: var(--workspace-context-height)');
  });
  it('1366 → 1000 → 1366 keeps observer roots, thresholds, hysteresis and cleanup', async () => {
    const records: Array<{callback: IntersectionObserverCallback; options?: IntersectionObserverInit; target?: Element; disconnect: () => void}> = [];
    class Observer {
      record: typeof records[number];
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = {callback,options,disconnect:vi.fn()}; records.push(this.record);
      }
      observe(target: Element) { this.record.target = target; }
      disconnect() { this.record.disconnect(); }
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    setViewportWidth(1366); await mount(); await click(repoOpenButton('owner/existing')); await settle();
    const context = records.find(record => record.target?.matches('.repo-context-sentinel'))!;
    const tabs = records.find(record => record.target?.matches('.detail-tabs-sentinel'))!;
    const root = document.querySelector('.app-shell-workspace');
    expect(context.options?.root).toBe(root); expect(tabs.options?.root).toBe(root);
    expect(context.options?.threshold).toEqual([0,1]); expect(tabs.options?.threshold).toBeUndefined();
    const host = document.querySelector<HTMLElement>('.workspace-repo-context')!;
    for (const width of [1000,1366]) {
      await act(async () => setViewportWidth(width)); await settle();
      expect(context.disconnect).not.toHaveBeenCalled(); expect(tabs.disconnect).not.toHaveBeenCalled();
      expect(document.querySelector('.workspace-repo-context')).toBe(host);
      for (const [ratio,visible] of [[0,'true'],[0.5,'true'],[1,'false'],[0.5,'false']] as const) {
        await act(async () => context.callback([{intersectionRatio:ratio} as IntersectionObserverEntry], {} as IntersectionObserver));
        expect(host.dataset.visible).toBe(visible);
      }
    }
    await act(async () => tabs.callback([{isIntersecting:false} as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(document.querySelector<HTMLElement>('[role="tablist"]')?.dataset.stuck).toBe('true');
    await view!.unmount(); view = null;
    expect(context.disconnect).toHaveBeenCalledOnce(); expect(tabs.disconnect).toHaveBeenCalledOnce();
  });
  it.each([1366,1152,1000,900,899,768,480])('%ipx preserves canonical identity, freshness, metric labels/values and actions', async width => {
    setViewportWidth(width); await mount(); await click(repoOpenButton('owner/existing')); await settle();
    const header = document.querySelector('.repository-header')!;
    expect(header.querySelector('h1,h2')?.getAttribute('aria-label')).toBe('owner/existing');
    expect(header.querySelector('.repository-header-owner')?.textContent).toBe('owner');
    expect(header.querySelector('.repository-header-identity .repository-header-fetched')?.textContent).toContain('抓取于');
    const metrics = header.querySelector('.repository-header-metrics')!;
    for (const label of ['Stars','Forks','最近活动','最新版本']) expect(metrics.textContent).toContain(label);
    expect(metrics.querySelectorAll('.font-semibold').length).toBe(4);
    expect(header.querySelector('.repository-header-actions')?.textContent).toContain('在 GitHub 打开');
    expect(header.querySelector('.repository-header-actions')?.textContent).toContain('重新抓取');
  });
});
