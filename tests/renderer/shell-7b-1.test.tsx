// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRendererStyles } from './support/styles';
import { click, createStub, makeGlance, renderApp, setViewportWidth, settle, submitForm, typeInto } from './helpers';
import type { RenderResult, StubOptions } from './helpers';

let view: RenderResult | null = null;
const input = (): HTMLInputElement => document.querySelector('#add-repository-input')!;
const action = (): HTMLButtonElement => document.querySelector('.watchlist-add-action')!;
const message = (): HTMLElement => document.querySelector('.watchlist-inline-message')!;
const visual = (): Element | null => message().querySelector('.watchlist-feedback-visual');
beforeEach(() => setViewportWidth(1152));
afterEach(async () => { await view?.unmount(); view = null; setViewportWidth(768); vi.useRealTimers(); });
async function mount(options: StubOptions = {}) {
  view = await renderApp(createStub({repositories:[makeGlance(1,'owner/existing')],...options})); await settle();
}

describe('Shell-7B.1 feedback presentation lifecycle', () => {
  it('no feedback keeps a stable empty track without a visual or padding wrapper', async () => {
    await mount(); const track = message().firstElementChild;
    expect(track?.classList.contains('watchlist-feedback-track')).toBe(true);
    expect(visual()).toBeNull(); expect(track?.children).toHaveLength(0);
    await typeInto(input(),'owner/new');
    expect(message().firstElementChild).toBe(track); expect(visual()).toBeNull();
  });
  it.each(['invalid','duplicate','success','error'])('%s clear keeps real content through the 200ms collapse without a live region', async mode => {
    vi.useFakeTimers();
    await mount(mode==='error'?{addResult:{ok:false,repository:null,error:{kind:'unknown',message:'failed'}}}:{});
    await typeInto(input(),mode==='invalid'?'1':mode==='duplicate'?'owner/existing':'owner/new');
    if(mode==='success'||mode==='error'){await submitForm(input().form!);await settle();}
    if(mode==='duplicate'||mode==='success')await click(action());
    const outgoing=visual(), track=message().firstElementChild;
    await click(action());
    expect(input().value).toBe('');expect(document.activeElement).toBe(input());
    expect(action().querySelector('.repository-omnibox-add-icon')).toBeNull();
    expect(visual()).toBe(outgoing); expect(message().firstElementChild).toBe(track);
    expect(message().getAttribute('aria-hidden')).toBe('true');
    expect(message().querySelectorAll('[role="status"],[role="alert"]')).toHaveLength(0);
    await act(async()=>vi.advanceTimersByTimeAsync(199));expect(message().textContent).not.toBe('');
    await act(async()=>vi.advanceTimersByTimeAsync(1));expect(visual()).toBeNull();
    expect(message().firstElementChild).toBe(track); expect(track?.children).toHaveLength(0);
  });
  it('re-entry replaces an outgoing visual, retaining one wrapper and live region', async () => {
    await mount();await typeInto(input(),'1');const host=message(),track=host.firstElementChild,outgoing=visual();
    await click(action());await typeInto(input(),'1');
    expect(message()).toBe(host);expect(host.firstElementChild).toBe(track);expect(visual()).not.toBe(outgoing);
    expect(host.querySelectorAll('[role="status"],[role="alert"]')).toHaveLength(1);
  });
  it('ordinary typing inside the same message keeps the visual; twenty clear/type cycles replace only the entrance', async () => {
    await mount();await typeInto(input(),'1');const first=visual();
    await typeInto(input(),'abc');expect(visual()).toBe(first);
    for(let i=0;i<20;i++){
      const outgoing=visual();await click(action());
      expect(action().querySelector('.repository-omnibox-add-icon')).toBeNull();
      await typeInto(input(),'1');expect(visual()).not.toBe(outgoing);
      expect(message().querySelectorAll('[role="status"]')).toHaveLength(1);
    }
  });
});

describe('Shell-7B.1 focus and current-viewport contracts', () => {
  const css=readRendererStyles().replace(/\/\*[\s\S]*?\*\//g,'');
  it('uses a focus ring that follows input geometry instead of a stale native outline', () => {
    expect(css).toMatch(/\.watchlist-add-form input:focus-visible\s*\{[^}]*outline: none;[^}]*box-shadow:/);
  });
  it('wide hide covers both compact hosts regardless of responsive commit history', () => {
    expect(css).toMatch(/@media \(min-width: 1152px\)\s*\{\s*\.compact-repo-context\s*\{[^}]*display: none !important;[^}]*transition: none !important/);
  });
  it('newly mounted feedback has a starting style while exit transitions only opacity', () => {
    expect(css).toContain('@starting-style');
    const exit=css.match(/\.watchlist-feedback-visual\s*\{[^}]+/)?.[0]??'';
    expect(exit).toContain('opacity var(--ui-feedback-exit-ms)');expect(exit).not.toMatch(/transform 0s|transition:\s*(height|max-height|margin|padding)/);
  });
});
