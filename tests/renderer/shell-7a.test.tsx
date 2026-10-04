// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRendererStyles } from './support/styles';
import {
  click, createStub, makeGlance, menu, menuItem, openRepositoryActions, renderApp,
  repoOpenButton, resetReducedMotion, setViewportWidth, settle, submitForm, typeInto,
} from './helpers';
import type { RenderResult, StubHandle } from './helpers';

let view: RenderResult | null = null;
let stub: StubHandle;
const fullName = 'very-long-owner-name/very-long-repository-name-with-many-characters';
const row = (): HTMLElement => repoOpenButton(fullName)!.closest('.repository-sidebar-row')!;
const input = (): HTMLInputElement => document.querySelector('#add-repository-input')!;
const action = (): HTMLButtonElement => document.querySelector('.watchlist-add-action')!;
beforeEach(() => setViewportWidth(1152));
afterEach(async () => { await view?.unmount(); view = null; resetReducedMotion(); setViewportWidth(768); });
async function mount(): Promise<void> {
  stub = createStub({ repositories: [makeGlance(1, fullName), makeGlance(2, 'other/short')] });
  view = await renderApp(stub); await settle();
}
async function pointer(type: string, button = 0): Promise<void> {
  await act(async () => repoOpenButton(fullName)!.dispatchEvent(new PointerEvent(type === 'pointerleave' ? 'pointerout' : type, { bubbles: true, button, pointerId: 1, relatedTarget: type === 'pointerleave' ? document.body : null })));
}

describe('Shell-7A identity and action semantics', () => {
  it('Sidebar is repo first, owner/release second, with full canonical accessible identity', async () => {
    await mount();
    const button = repoOpenButton(fullName)!;
    expect(button.querySelector('.repository-sidebar-name')?.textContent).toBe(fullName.split('/')[1]);
    expect(button.querySelector('.repository-sidebar-owner')?.textContent).toBe(fullName.split('/')[0]);
    expect(button.querySelector('.repository-sidebar-secondary')?.textContent).toContain('·');
    expect(button.title).toBe(fullName);
    expect(button.getAttribute('aria-label')).toBe(`查看 ${fullName} 详情`);
    expect(button.querySelector('.repository-sidebar-activity')).not.toBeNull();
  });
  it('Detail h2 keeps canonical accessible name and separate owner outside metrics', async () => {
    await mount(); await click(repoOpenButton(fullName)); await settle();
    const header = document.querySelector('.repository-header')!;
    expect(header.querySelector('h2')?.textContent).toBe(fullName.split('/')[1]);
    expect(header.querySelector('h2')?.getAttribute('aria-label')).toBe(fullName);
    expect(header.querySelector('.repository-header-owner')?.textContent).toBe(fullName.split('/')[0]);
    expect(header.querySelector('.repository-header-metrics .repository-header-owner')).toBeNull();
    await click(header.querySelector('button[aria-label^="在 GitHub"]'));
    expect(stub.externalTargets).toEqual([{ kind: 'repository', owner: fullName.split('/')[0], name: fullName.split('/')[1] }]);
    await openRepositoryActions(fullName);
    await click(menuItem('从监控清单移除'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(fullName);
    expect(stub.calls.fetchDetail).toBe(1);
  });
  it('Add uses plus, Clear uses X with tooltip/ARIA and unchanged submission/clear paths', async () => {
    await mount(); await typeInto(input(), 'owner/new');
    expect(action().querySelector('.repository-omnibox-add-icon')).not.toBeNull();
    expect(action().getAttribute('aria-label')).toBe('添加仓库');
    expect(action().title).toBe('添加仓库');
    expect(action().textContent?.trim()).toBe('');
    await submitForm(input().form!); await settle();
    expect(stub.calls.addRepository).toBe(1);
    expect(action().dataset.actionKind).toBe('added');
    await click(action()); // existing confirming → manual-clear transition
    expect(action().dataset.actionKind).toBe('clear');
    expect(action().querySelector('.repository-omnibox-clear-icon')).not.toBeNull();
    expect(action().getAttribute('aria-label')).toBe('清除输入');
    expect(action().title).toBe('清除输入');
    await click(action()); expect(input().value).toBe('');
    expect(stub.calls.removeRepository).toBe(0);
  });
  it('duplicate Clear never removes or submits a repo', async () => {
    await mount(); await typeInto(input(), fullName);
    expect(action().querySelector('.repository-omnibox-clear-icon')).not.toBeNull();
    expect(action().title).toBe('清除输入');
    await click(action());
    expect(input().value).toBe(''); expect(stub.calls.addRepository).toBe(0); expect(stub.calls.removeRepository).toBe(0);
  });
});

describe('Shell-7A primary press lifecycle', () => {
  it.each([false, true])('left press and release keep selection %s and never fetch on press alone', async (selected) => {
    await mount(); if (selected) await click(repoOpenButton(fullName));
    const count = stub.calls.fetchDetail;
    await pointer('pointerdown'); expect(row().dataset.pressed).toBe('true');
    expect(row().dataset.selected === 'true').toBe(selected);
    await pointer('pointerup'); expect(row().dataset.pressed).toBeUndefined();
    expect(row().dataset.pressReleased).toBe('true'); expect(stub.calls.fetchDetail).toBe(count);
  });
  it.each(['pointercancel', 'pointerleave', 'blur'])('%s clears a held left press', async (type) => {
    await mount(); await pointer('pointerdown');
    if (type === 'blur') await act(async () => window.dispatchEvent(new Event('blur')));
    else await pointer(type);
    expect(row().dataset.pressed).toBeUndefined();
  });
  it('release outside clears the press without changing selection', async () => {
    await mount(); await pointer('pointerdown');
    await act(async () => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
    expect(row().dataset.pressed).toBeUndefined(); expect(row().dataset.selected).toBeUndefined();
  });
  it('right press never creates left feedback, context still targets the full repo', async () => {
    await mount(); await pointer('pointerdown', 2); expect(row().dataset.pressed).toBeUndefined();
    await openRepositoryActions(fullName); expect(menu()).not.toBeNull();
    expect(row().querySelector('.repository-action-positioner[data-context-point="true"]')).not.toBeNull();
    expect(stub.calls.fetchDetail).toBe(0);
  });
  it.each(['Enter', ' '])('native %s activation key only adds visual feedback', async (key) => {
    await mount(); const button = repoOpenButton(fullName)!;
    await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    expect(row().dataset.pressed).toBe('true');
    await act(async () => button.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })));
    expect(row().dataset.pressed).toBeUndefined(); expect(stub.calls.fetchDetail).toBe(0);
  });
  it('rapid press/release never sticks', async () => {
    await mount(); for (let i = 0; i < 10; i++) { await pointer('pointerdown'); await pointer('pointerup'); }
    expect(document.querySelector('[data-pressed="true"]')).toBeNull();
  });
  it('release override expires even when rapid clicks produce no transitionend', async () => {
    vi.useFakeTimers();
    try {
      await mount(); await pointer('pointerdown'); await pointer('pointerup');
      expect(row().dataset.pressReleased).toBe('true');
      await act(async () => vi.advanceTimersByTimeAsync(130));
      expect(row().dataset.pressReleased).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

describe('Shell-7A visual contracts', () => {
  const css = readRendererStyles().replace(/\/\*[\s\S]*?\*\//g, '');
  it('square is 34px, 16px official icon, no text CTA', () => {
    expect(css).toMatch(/\.watchlist-add-content \.watchlist-add-action\s*\{[^}]*width: 34px;[^}]*height: 34px;[^}]*padding: 0/);
    expect(css).toContain("url('./assets/icons/plus.svg')");
  });
  it('current wide viewport hides both responsive compact hosts and cannot animate', () => {
    expect(css).toMatch(/@media \(min-width: 900px\)\s*\{\s*\.compact-repo-context\s*\{[^}]*display: none !important;[^}]*transition: none !important/);
    expect(css).toMatch(/\.workspace-repo-context\s*\{[^}]*height: var\(--workspace-context-height\)/);
    expect(css).toContain('--workspace-context-height: 1.5rem');
  });
  it('primary/owner/release truncate while time never shrinks; press changes only background', () => {
    expect(css).toMatch(/\.repository-sidebar-name,\s*\.repository-sidebar-owner,\s*\.repository-sidebar-release\s*\{[^}]*text-overflow: ellipsis/);
    expect(css).toMatch(/\.repository-sidebar-secondary\s*\{[^}]*min-width: 0/);
    expect(css).toMatch(/\.repository-sidebar-activity\s*\{[^}]*flex: none/);
    const press = css.match(/\.repository-sidebar-row\[data-pressed='true'\]\s*\{[^}]*\}/)?.[0] ?? '';
    expect(press).toContain('--repository-row-background'); expect(press).not.toMatch(/scale|translate|height|border|shadow/);
    expect(css).toContain('--motion-press-in: 80ms'); expect(css).toContain('--motion-press-out: 110ms');
  });
});
