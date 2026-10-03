// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderResult } from './helpers';
import { click, createStub, makeGlance, renderApp, repoOpenButton, setViewportWidth, settle, tab } from './helpers';

let view: RenderResult | null = null;
const owner = 'very-long-organization-name-for-layout-testing';
const name = 'extremely-long-bluebird-courier-repository-name-for-desktop-layout';
const repo = makeGlance(1, `${owner}/${name}`);

interface Observation {
  callback: IntersectionObserverCallback;
  target?: Element;
}
const observations: Observation[] = [];
function observeContext(): void {
  observations.length = 0;
  class Observer {
    record: Observation;
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback };
      observations.push(this.record);
    }
    observe(target: Element): void { this.record.target = target; }
    disconnect(): void {}
  }
  vi.stubGlobal('IntersectionObserver', Observer);
}
async function showContext(): Promise<void> {
  const observation = observations.filter(record => record.target?.matches('.repo-context-sentinel')).at(-1)!;
  await act(async () => observation.callback([
    { intersectionRatio: 0 } as IntersectionObserverEntry,
  ], {} as IntersectionObserver));
}
async function open(width: number) {
  setViewportWidth(width);
  const stub = createStub({ repositories: [repo] });
  observeContext();
  view = await renderApp(stub);
  await settle();
  await click(repoOpenButton(repo.fullName));
  await settle();
  return stub;
}
afterEach(async () => {
  await view?.unmount();
  view = null;
  setViewportWidth(768);
  vi.unstubAllGlobals();
});

describe('Desktop Compact Repository Context presentation', () => {
  it.each([900, 899])('%ipx uses only its presentation, preserving full identity without a heading or action', async width => {
    await open(width);
    await showContext();
    const context = document.querySelector('.compact-repo-context')!;
    expect(context.getAttribute('data-visible')).toBe('true');
    expect(context.hasAttribute('aria-hidden')).toBe(false);
    expect(context.querySelectorAll('h1,h2,h3,button,a,input,[tabindex]')).toHaveLength(0);
    expect(context.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(repo.fullName);
    expect(context.querySelector('[title]')?.getAttribute('title')).toBe(repo.fullName);
    expect(context.classList.contains('desktop-compact-repo-context')).toBe(width === 900);
    if (width === 900) {
      expect(context.querySelector('.desktop-compact-name')?.textContent).toBe(name);
      expect(context.querySelector('.desktop-compact-owner')?.textContent).toBe(`· ${owner}`);
    } else {
      expect(context.querySelector('.desktop-compact-identity')).toBeNull();
      expect(context.lastElementChild?.className).toBe('min-w-0 truncate font-mono text-sm font-medium text-secondary');
      expect(context.lastElementChild?.textContent).toBe(`${name} · ${owner}`);
    }
  });

  it('keeps one effective Context, Detail, Trend, sentinels, focus and query across five sticky layout cycles', async () => {
    const stub = await open(900);
    await showContext();
    await click(tab('趋势'));
    const page = document.querySelector('.detail-page');
    const panel = document.querySelector('[role="tabpanel"]');
    const sentinel = document.querySelector('.repo-context-sentinel');
    const tabsSentinel = document.querySelector('.detail-tabs-sentinel');
    const trend = tab('趋势')!;
    trend.focus();
    const calls = { ...stub.calls };
    for (const width of [1180, 900, 899, 900, 1180, ...Array.from({ length: 5 }, () => [899, 900, 899]).flat()]) {
      await act(async () => setViewportWidth(width));
      await settle();
      await showContext();
      const contexts = document.querySelectorAll('.compact-repo-context');
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.getAttribute('data-visible')).toBe('true');
      expect(contexts[0]?.classList.contains('desktop-compact-repo-context')).toBe(width >= 900);
      expect(document.querySelector('.detail-page')).toBe(page);
      expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
      expect(document.querySelector('.repo-context-sentinel')).toBe(sentinel);
      expect(document.querySelector('.detail-tabs-sentinel')).toBe(tabsSentinel);
      expect(tab('趋势')).toBe(trend);
      expect(trend.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).not.toBe(contexts[0]);
    }
    expect(stub.calls).toEqual(calls);
    expect(stub.calls.fetchDetail).toBe(1);
  });
});
