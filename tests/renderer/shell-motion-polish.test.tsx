// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DETAIL_REVEAL_TOTAL_MS } from '../../src/renderer/lib/motion';
import { cardLayoutTransition, cardVariants } from '../../src/renderer/components/watchlist/card-motion';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  buttonByLabel, buttonByText, click, createStub, factSwaps, loadingSlot, makeGlance, navButton, revealPhase, openAddInput, renderApp,
  repoOpenButton, repoSlot, resetReducedMotion, resetSystemTheme, setReducedMotion,
  setSystemTheme, setViewportWidth, settle, settleMotion, submitForm, tab, typeInto,
} from './helpers';
import { readRendererStyles } from './support/styles';

const repos = ['A', 'B', 'C', 'D'].map((name, i) => makeGlance(i + 1, `owner/${name}`));
let view: RenderResult | null = null;
let stub: StubHandle;
const detail = (): HTMLElement | null => document.querySelector('.detail-page');
const input = (): HTMLInputElement => document.querySelector('#add-repository-input')!;
const message = (): HTMLElement => document.querySelector('.watchlist-inline-message')!;
const source = (file: string): string => readFileSync(resolve(process.cwd(), file), 'utf8');
beforeEach(() => setViewportWidth(1152));
afterEach(async () => {
  await view?.unmount(); view = null;
  await settle();
  vi.useRealTimers();
  resetReducedMotion(); resetSystemTheme(); setViewportWidth(768);
  vi.restoreAllMocks();
});
async function mount(options: StubOptions = {}): Promise<void> {
  stub = createStub({ repositories: repos, ...options });
  view = await renderApp(stub); await settle();
}
async function open(name: string): Promise<void> {
  await click(repoOpenButton(`owner/${name}`)); await settle();
}

describe('Desktop repo switch entrance ownership', () => {
  it('first repo has no switch entrance; selection updates in the navigation commit', async () => {
    await mount();
    const slot = repoSlot('owner/A');
    await click(repoOpenButton('owner/A'));
    expect(repoOpenButton('owner/A')?.getAttribute('aria-pressed')).toBe('true');
    expect(repoSlot('owner/A')).toBe(slot);
    expect(detail()?.dataset.workspaceSwitch).toBeUndefined();
    expect(detail()?.dataset.workspaceEnter).toBeUndefined();
    await settle();
    expect(detail()?.dataset.workspaceEnter).toBeUndefined();
  });

  it('A → pending B shows Header/Loading immediately and preserves the full data reveal without a workspace entrance', async () => {
    vi.useFakeTimers(); await mount(); await open('A');
    await settleMotion(DETAIL_REVEAL_TOTAL_MS + 200);
    const release = stub.holdNextDetail(); await open('B');
    const page = detail(), header = page?.querySelector('.repository-header');
    const title = page?.querySelector('.repository-header-name');
    const refetch = buttonByText('抓取中…');
    expect(page?.dataset.workspaceSwitch).toBeUndefined();
    expect(page?.dataset.workspaceEnter).toBeUndefined();
    expect(title?.textContent).toBe('B');
    expect(revealPhase()).toBe('loading');
    expect(loadingSlot()?.dataset.state).toBe('visible');
    expect(page?.querySelector('[role="tabpanel"]')).toBeNull();
    expect(document.querySelectorAll('.detail-page')).toHaveLength(1);
    await act(async () => release()); await settle();
    expect(detail()).toBe(page);
    expect(page?.querySelector('.repository-header')).toBe(header);
    expect(page?.querySelector('.repository-header-name')).toBe(title);
    expect(buttonByText('重新抓取')).toBe(refetch);
    expect(page?.dataset.workspaceSwitch).toBeUndefined();
    expect(page?.dataset.workspaceEnter).toBeUndefined();
    expect(revealPhase()).toBe('revealing');
    expect(loadingSlot()?.dataset.state).toBe('exiting');
    expect(factSwaps()).toHaveLength(4);
    expect(page?.querySelectorAll('.detail-reveal-item').length).toBeGreaterThan(1);
    expect(page?.querySelector('.detail-refetch-label')).not.toBeNull();
    expect(page?.textContent).toContain('v1.0.2');
    expect(page?.textContent).not.toContain('v1.0.1');
    expect(stub.calls.fetchDetail).toBe(2);
    await settleMotion(DETAIL_REVEAL_TOTAL_MS + 200);
    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
    expect(factSwaps()).toHaveLength(0);
    expect(page?.dataset.workspaceEnter).toBeUndefined();
  });

  it('cached replacement immediately enters without reveal; same repo retains DOM and animation identity', async () => {
    vi.useFakeTimers(); await mount(); await open('A'); await open('B'); await open('A');
    const before = detail(), rows = repos.map(repo => repoSlot(repo.fullName));
    expect(before?.dataset.workspaceSwitch).toBe('true');
    expect(before?.dataset.workspaceEnter).toBe('true');
    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
    expect(factSwaps()).toHaveLength(0);
    await open('A');
    expect(detail()).toBe(before);
    expect(repos.map(repo => repoSlot(repo.fullName))).toEqual(rows);
    expect(stub.calls.fetchDetail).toBe(2);
  });

  it('rapid cached A/B/C/D/A at 50ms keeps one latest workspace and never queues exits', async () => {
    vi.useFakeTimers(); await mount();
    for (const name of ['A', 'B', 'C', 'D']) await open(name);
    const nodes = repos.map(repo => repoSlot(repo.fullName));
    for (const name of ['A', 'B', 'C', 'D', 'A']) {
      await open(name);
      expect(detail()?.querySelector('.repository-header-name')?.textContent).toBe(name);
      expect(document.querySelectorAll('.detail-page')).toHaveLength(1);
      await settleMotion(50);
    }
    expect(repos.map(repo => repoSlot(repo.fullName))).toEqual(nodes);
    expect(stub.calls.fetchDetail).toBe(4);
    expect(document.querySelector('.view-transition')).toBeNull();
  });

  it('an old pending response cannot enter or overlap the latest selected repo', async () => {
    await mount(); await open('A');
    const release = stub.holdNextDetail(); await open('B'); await open('C');
    const latest = detail();
    await act(async () => release()); await settle();
    expect(detail()).toBe(latest);
    expect(latest?.querySelector('.repository-header-name')?.getAttribute('aria-label')).toBe('owner/C');
    expect(latest?.textContent).not.toContain('owner/B');
    expect(document.querySelectorAll('[data-workspace-enter="true"]')).toHaveLength(0);
    expect(latest?.dataset.workspaceSwitch).toBeUndefined();
  });

  it('breakpoint migration cancels switch entrance without replacing DetailPage', async () => {
    await mount(); await open('A'); await open('B'); await open('A'); const before = detail();
    expect(before?.dataset.workspaceEnter).toBe('true');
    for (const width of [899, 900, 899, 1152]) {
      await act(async () => setViewportWidth(width)); await settle();
      expect(detail()).toBe(before);
      expect(detail()?.dataset.workspaceEnter).toBeUndefined();
      expect(detail()?.dataset.workspaceSwitch).toBeUndefined();
    }
    expect(stub.calls.fetchDetail).toBe(2);
  });

  it('system theme changes retain DOM and entrance marker, so cannot restart keyframes', async () => {
    await mount({ preferences: { theme: 'system' } }); await open('A'); await open('B'); await open('A');
    const before = detail();
    for (const theme of ['dark', 'light', 'dark'] as const) {
      await act(async () => setSystemTheme(theme)); await settle();
      expect(detail()).toBe(before);
      expect(before?.dataset.workspaceEnter).toBe('true');
      expect(document.documentElement.dataset.theme).toBe(theme);
    }
    expect(stub.calls.fetchDetail).toBe(2);
  });

  it('Settings and return to a repo have no new entrance', async () => {
    await mount(); await open('A'); await open('B');
    await click(navButton('设置')); await settle();
    expect(detail()).toBeNull();
    expect(document.querySelector('[data-workspace-enter]')).toBeNull();
    await open('A');
    expect(detail()?.dataset.workspaceEnter).toBeUndefined();
  });

  it.each([899, 768, 480])('%ipx never owns the Desktop entrance and retains PageTransition', async (width) => {
    setViewportWidth(width); await mount(); await open('A');
    expect(detail()?.dataset.workspaceSwitch).toBeUndefined();
    expect(detail()?.dataset.workspaceEnter).toBeUndefined();
    expect(document.querySelector<HTMLElement>('.view-transition')?.dataset.viewMotion).toBe('forward');
  });

  it('cold switch stays outside workspace entrance across tabs, theme updates and manual refresh', async () => {
    vi.useFakeTimers(); await mount({ preferences: { theme: 'system' } }); await open('A'); await open('B');
    const before = detail();
    await settleMotion(DETAIL_REVEAL_TOTAL_MS + 200);
    await click(tab('发版')); await settle();
    const panel = before?.querySelector('[role="tabpanel"]');
    expect(panel?.className).toContain('tab-panel-enter');
    await act(async () => setSystemTheme('dark')); await settle();
    const release = stub.holdNextDetail(); await click(buttonByText('重新抓取')); await settle();
    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
    await act(async () => release()); await settle();
    expect(detail()).toBe(before);
    expect(before?.querySelector('[role="tabpanel"]')).toBe(panel);
    expect(before?.dataset.workspaceEnter).toBeUndefined();
    expect(before?.dataset.workspaceSwitch).toBeUndefined();
    expect(factSwaps()).toHaveLength(0);
    expect(stub.calls.fetchDetail).toBe(3);
  });

  it('Reduced Motion cold switch shows loading then direct ready, without workspace entrance', async () => {
    vi.useFakeTimers(); setReducedMotion(true); await mount(); await open('A');
    const release = stub.holdNextDetail(); await open('B');
    expect(revealPhase()).toBe('loading');
    expect(loadingSlot()?.dataset.state).toBe('visible');
    const before = detail();
    await act(async () => release()); await settle();
    expect(detail()).toBe(before);
    expect(revealPhase()).toBe('ready');
    expect(loadingSlot()).toBeNull();
    expect(factSwaps()).toHaveLength(0);
    expect(before?.dataset.workspaceEnter).toBeUndefined();
    expect(before?.dataset.workspaceSwitch).toBeUndefined();
    expect(before?.textContent).toContain('v1.0.2');
  });

  it('theme and layout migration during a cold fetch never turn arriving data into a cached switch', async () => {
    vi.useFakeTimers(); await mount({ preferences: { theme: 'system' } }); await open('A');
    const release = stub.holdNextDetail(); await open('B');
    const before = detail();
    await act(async () => setSystemTheme('dark')); await settle();
    for (const width of [899, 1152]) {
      await act(async () => setViewportWidth(width)); await settle();
      expect(detail()).toBe(before);
      expect(revealPhase()).toBe('loading');
      expect(loadingSlot()?.dataset.state).toBe('visible');
      expect(before?.dataset.workspaceEnter).toBeUndefined();
      expect(before?.dataset.workspaceSwitch).toBeUndefined();
    }
    await act(async () => release()); await settle();
    expect(detail()).toBe(before);
    expect(revealPhase()).toBe('revealing');
    expect(factSwaps()).toHaveLength(4);
    expect(before?.dataset.workspaceEnter).toBeUndefined();
    expect(before?.dataset.workspaceSwitch).toBeUndefined();
    expect(stub.calls.fetchDetail).toBe(2);
  });

  it('cold first-fetch failure then retry reveals data without retroactively assigning a workspace entrance', async () => {
    vi.useFakeTimers(); await mount(); await open('A');
    const fetchDetail = stub.api.fetchDetail;
    stub.api.fetchDetail = async () => ({ detail: null, error: { kind: 'unknown', message: 'fixture error' } });
    await open('B');
    const before = detail();
    expect(before?.querySelector('[role="alert"]')?.textContent).toContain('fixture error');
    stub.api.fetchDetail = fetchDetail;
    const release = stub.holdNextDetail(); await click(buttonByLabel('重新抓取仓库详情')); await settle();
    expect(revealPhase()).toBe('loading');
    // 失败 envelope 已是 query data：重试期间沿用原错误面板和禁用按钮。
    expect(loadingSlot()).toBeNull();
    expect(buttonByLabel('重新抓取仓库详情')?.disabled).toBe(true);
    await act(async () => release()); await settle();
    expect(detail()).toBe(before);
    expect(revealPhase()).toBe('revealing');
    expect(factSwaps()).toHaveLength(4);
    expect(before?.querySelector('[role="alert"]')).toBeNull();
    expect(before?.dataset.workspaceEnter).toBeUndefined();
    expect(before?.dataset.workspaceSwitch).toBeUndefined();
  });

  it('switched first-fetch errors have no decorative workspace entrance', async () => {
    await mount(); await open('A');
    stub.api.fetchDetail = async () => ({ detail: null, error: { kind: 'unknown', message: 'fixture error' } });
    await open('B');
    expect(detail()?.dataset.workspaceEnter).toBeUndefined();
    expect(detail()?.querySelector('[role="alert"]')?.textContent).toContain('fixture error');
  });
});

describe('Feedback lifecycle remains business-owned', () => {
  it.each([1152, 480])('%ipx existing 1400ms success ends live semantics before the 200ms layout exit', async (width) => {
    vi.useFakeTimers(); setViewportWidth(width); await mount();
    const field = await openAddInput(); await typeInto(field, 'owner/new');
    await submitForm(field.form!); await settle();
    expect(message().querySelectorAll('[role="status"]')).toHaveLength(1);
    const status = message().querySelector('#add-repository-success');
    await settleMotion(1399);
    expect(message().dataset.open).toBe('true');
    await settleMotion(1);
    expect(field.value).toBe('');
    expect(message().dataset.open).toBe('false');
    expect(message().getAttribute('aria-hidden')).toBe('true');
    expect(message().querySelector('[role="status"]')).toBeNull();
    expect(message().querySelector('#add-repository-success')).toBe(status);
    await settleMotion(199);
    expect(message().querySelector('#add-repository-success')).toBe(status);
    await settleMotion(1);
    expect(message().querySelector('#add-repository-success')).toBeNull();
  });

  it('repeated invalid/duplicate feedback never produces a second live region or an exit queue', async () => {
    vi.useFakeTimers(); await mount();
    for (const text of ['invalid', 'owner/A', 'bad input', 'owner/B', 'owner/free']) {
      await typeInto(input(), text);
      expect(message().querySelectorAll('[role="status"], [role="alert"]').length).toBeLessThanOrEqual(1);
      expect(document.querySelectorAll('.watchlist-inline-message')).toHaveLength(1);
      await settleMotion(50);
    }
    expect(message().dataset.open).toBe('false');
    await settleMotion(200);
    expect(message().querySelector('.state-inline-feedback')).toBeNull();
    expect(stub.calls.addRepository).toBe(0);
  });

  it('remote error retains exactly one alert and clears semantics immediately on editing', async () => {
    await mount({ addResult: { ok: false, repository: null, error: { kind: 'unknown', message: 'fixture add error' } } });
    await typeInto(input(), 'owner/new'); await submitForm(input().form!); await settle();
    expect(message().querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(message().querySelector('[role="status"]')).toBeNull();
    await typeInto(input(), 'owner/other');
    expect(message().getAttribute('aria-hidden')).toBe('true');
    expect(message().querySelector('[role="alert"]')).toBeNull();
  });

  it('Reduced Motion keeps business feedback and direct repo replacement', async () => {
    setReducedMotion(true); await mount(); await open('A'); await open('B');
    expect(document.querySelector<HTMLElement>('.detail-reveal')?.dataset.reveal).toBe('ready');
    await typeInto(input(), 'owner/A');
    expect(message().querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(stub.calls.fetchDetail).toBe(2);
  });
});

describe('Visual motion contracts', () => {
  const css = readRendererStyles().replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string): string => css.slice(css.indexOf(selector)).split('}')[0] ?? '';
  it('Selected and indicator animate only surface/opacity, with stable 72px geometry', () => {
    const row = rule('.repository-sidebar-row {');
    expect(row).toContain('height: 72px');
    const surface = css.match(/\.repository-sidebar-press-surface\s*\{\s*position:[^}]+/)?.[0] ?? '';
    expect(surface).toContain('var(--ui-selected-ms)');
    expect(row).not.toMatch(/translate|scale|layout/);
    const indicator = rule('.repository-sidebar-row::before {');
    expect(indicator).toContain('width: 3px');
    expect(indicator).toContain('opacity: 0');
    expect(indicator).toContain('transition: opacity var(--ui-selected-ms)');
    expect(rule(".repository-sidebar-row[data-selected='true']::before {")).toContain('opacity: 1');
  });

  it('Compact Context transitions only its existing inner visual layer; host remains absolute 1.5rem', () => {
    const host = rule('.workspace-repo-context {');
    expect(host).toContain('position: absolute');
    expect(host).toContain('height: var(--workspace-context-height)');
    expect(host).toContain('transition: none');
    expect(host).not.toMatch(/animation|transform/);
    const inner = rule('.workspace-repo-context .compact-repo-context {');
    expect(inner).toContain('translateY(var(--ui-context-shift))');
    expect(inner).not.toMatch(/transition:\s*(height|top|max-height)/);
  });

  it('Workspace has no wait/exit/presence owner and switched data has one entrance', () => {
    const app = source('src/renderer/pages/App.tsx');
    expect(app).not.toContain('AnimatePresence');
    expect(app).not.toContain('mode="wait"');
    expect(rule(".detail-page[data-workspace-enter='true'] {")).toContain('workspace-repo-enter var(--ui-workspace-enter-ms)');
    expect(css).toContain(".detail-page[data-workspace-switch='true'] .detail-reveal-item");
  });

  it('Feedback interpolates flow height with a stable track and independent visual fade', () => {
    expect(rule('.watchlist-inline-message {')).toContain('grid-template-rows var(--ui-feedback-layout-ms)');
    expect(rule(".watchlist-inline-message[data-open='true'] {")).toContain('grid-template-rows: minmax(0, 1fr)');
    expect(rule('.watchlist-feedback-track {')).toContain('min-height: 0');
    expect(rule('.watchlist-feedback-track {')).toContain('overflow: hidden');
    const closed = rule('.watchlist-feedback-visual {');
    expect(closed).toContain('opacity var(--ui-feedback-exit-ms)');
    expect(closed).not.toMatch(/transition:\s*(grid|height)/);
    expect(rule(".watchlist-inline-message[data-open='true'] .watchlist-feedback-visual {")).toContain('transform var(--ui-feedback-enter-ms)');
  });

  it('Reduced Motion disables the new transforms/entrance and keeps existing short context opacity', () => {
    const reduced = source('src/renderer/styles/accessibility.css');
    expect(reduced).toMatch(/\.watchlist-feedback-visual,[\s\S]*?transform: none !important/);
    expect(reduced).toMatch(/\.detail-page\[data-workspace-enter='true'\]\s*\{\s*animation: none !important/);
    expect(reduced).toMatch(/\.compact-repo-context,[\s\S]*?transform: none !important;\s*transition: opacity 40ms linear !important/);
  });

  it('freezes exact Motion-1A/B spring/tween/Reduced Exit parameters and Presence ownership', () => {
    expect(cardLayoutTransition(false)).toEqual({ type: 'spring', stiffness: 440, damping: 38, mass: 0.8 });
    expect(cardVariants(false).enter.transition.duration).toBe(0.26);
    expect(cardVariants(false).exit.transition.duration).toBe(0.15);
    expect(cardVariants(true).exit.transition.duration).toBe(0.04);
    expect(source('src/renderer/pages/WatchlistPage.tsx')).toMatch(/<AnimatePresence[^>]*initial=\{false\}[^>]*mode="popLayout"/);
    expect(source('src/renderer/components/watchlist/RepositoryMotionItem.tsx')).toContain("layout={reduceMotion ? false : 'position'}");
  });
});
