// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByText, click, createStub, makeGlance, renderApp, repoOpenButton,
  setViewportWidth, settle, tab,
} from './helpers';

let view: RenderResult | null = null;
let stub: StubHandle;
const repo = makeGlance(1, 'owner/A');
const journey = [1180, 901, 900, 899, 768, 480, 899, 900, 1180];
const boundaries = Array.from({ length: 5 }, () => [899, 900, 899]).flat();

afterEach(async () => {
  await view?.unmount();
  view = null;
  setViewportWidth(768);
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'windowControlsOverlay');
});

async function open(width: number) {
  setViewportWidth(width);
  stub = createStub({ repositories: [repo] });
  view = await renderApp(stub);
  await settle();
  await click(repoOpenButton(repo.fullName));
  await settle();
}

function expectPresentation(width: number) {
  const desktop = width >= 900;
  expect(document.querySelectorAll('.repository-header')).toHaveLength(1);
  expect(document.querySelectorAll('.desktop-repository-header')).toHaveLength(desktop ? 1 : 0);
  expect(document.querySelectorAll('.narrow-repository-header')).toHaveLength(desktop ? 0 : 1);
  const headings = document.querySelectorAll('.repository-header-name');
  expect(headings).toHaveLength(1);
  expect(headings[0]?.tagName).toBe(desktop ? 'H2' : 'H1');
  expect(headings[0]?.getAttribute('aria-label')).toBe(repo.fullName);
  expect(document.querySelectorAll('.repository-header-actions')).toHaveLength(1);
  expect(document.querySelectorAll('.repository-header-actions button')).toHaveLength(2);
  expect(buttonByText('← 返回监控清单') !== null).toBe(!desktop);
}

async function resize(width: number) {
  await act(async () => setViewportWidth(width));
  await settle();
  expectPresentation(width);
}

describe('Repository Header presentation separation', () => {
  it.each([900, 899])('%ipx renders one presentation with the existing heading, actions and metrics', async width => {
    await open(width);
    expectPresentation(width);
    const metrics = document.querySelector('.repository-header-metrics')!;
    expect([...metrics.children].map(node => node.querySelector('span')?.textContent))
      .toEqual(['Stars', 'Forks', '最近活动', '最新版本']);
    expect(metrics.textContent).toContain('1,001');
    expect(metrics.textContent).toContain('v1.0.1');
  });

  it.each([900, 899])('%ipx preserves the full identity and external target for a long repository name', async width => {
    const owner = 'very-long-organization-name-for-layout-testing';
    const name = 'extremely-long-bluebird-courier-repository-name-for-desktop-layout';
    const longRepo = makeGlance(2, `${owner}/${name}`);
    setViewportWidth(width);
    stub = createStub({ repositories: [longRepo] });
    view = await renderApp(stub);
    await settle();
    await click(repoOpenButton(longRepo.fullName));
    await settle();
    const heading = document.querySelector('.repository-header-name')!;
    expect(heading.textContent).toBe(name);
    expect(heading.getAttribute('title')).toBe(longRepo.fullName);
    expect(heading.getAttribute('aria-label')).toBe(longRepo.fullName);
    expect(heading.tagName).toBe(width === 900 ? 'H2' : 'H1');
    expect(document.querySelector('.repository-header-owner')?.textContent).toBe(owner);
    await click(document.querySelector(`button[aria-label="在 GitHub 打开 ${longRepo.fullName}"]`));
    await settle();
    expect(stub.calls.openGitHubExternal).toBe(1);
    expect(stub.externalTargets).toEqual([{ kind: 'repository', owner, name }]);
    expect(stub.calls.fetchDetail).toBe(1);
  });

  it('replaces only the Header across five boundaries and the full journey, keeping Detail, Trend, sentinels and queries', async () => {
    const overlay = Object.assign(new EventTarget(), {
      visible: true,
      getTitlebarAreaRect: () => new DOMRect(0, 0, 760, 52),
    });
    Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });
    await open(899);
    await click(tab('趋势'));
    const page = document.querySelector('.detail-page');
    const panel = document.querySelector('[role="tabpanel"]');
    const trend = tab('趋势');
    const repositorySentinel = document.querySelector('.repo-context-sentinel');
    const tabsSentinel = document.querySelector('.detail-tabs-sentinel');
    const calls = { ...stub.calls };
    for (const width of [...boundaries, ...journey]) {
      await resize(width);
      expect(document.querySelector('.detail-page')).toBe(page);
      expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
      expect(tab('趋势')).toBe(trend);
      expect(trend?.getAttribute('aria-selected')).toBe('true');
      expect(panel?.getAttribute('aria-labelledby')).toBe(trend?.id);
      expect(document.querySelector('.repo-context-sentinel')).toBe(repositorySentinel);
      expect(document.querySelector('.detail-tabs-sentinel')).toBe(tabsSentinel);
      expect(document.documentElement.hasAttribute('data-window-controls-overlay')).toBe(true);
      expect(document.querySelector('.repository-header')?.closest('.window-drag-region')).toBeNull();
      if (width >= 900) {
        expect(repoOpenButton(repo.fullName)?.getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('.app-shell-window-drag-strip')?.nextElementSibling?.contains(page)).toBe(true);
      }
    }
    expect(stub.calls).toEqual(calls);
    expect(stub.calls.fetchDetail).toBe(1);
  });

  it.each([900, 899])('%ipx GitHub and refresh actions call the shared bridge once and retain pending/error state across presentation changes', async width => {
    await open(width);
    await click(document.querySelector('button[aria-label="在 GitHub 打开 owner/A"]'));
    await settle();
    expect(stub.calls.openGitHubExternal).toBe(1);
    expect(stub.externalTargets).toEqual([{ kind: 'repository', owner: 'owner', name: 'A' }]);
    await click(tab('趋势'));
    const panel = document.querySelector('[role="tabpanel"]');
    const release = stub.holdNextDetail();
    await click(buttonByText('重新抓取'));
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);
    await resize(width === 900 ? 899 : 900);
    const busy = buttonByText('抓取中…')!;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('.repository-header-fetched')?.textContent).toContain('正在更新');
    await click(busy);
    expect(stub.calls.fetchDetail).toBe(2);
    await act(async () => release());
    await settle();
    expect(buttonByText('重新抓取')?.disabled).toBe(false);
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    expect(tab('趋势')?.getAttribute('aria-selected')).toBe('true');

    const failure = vi.spyOn(stub.api, 'fetchDetail').mockResolvedValueOnce({
      detail: null, error: { kind: 'unknown', message: 'fixture refresh error' },
    });
    await click(buttonByText('重新抓取'));
    await settle();
    expect(failure).toHaveBeenCalledExactlyOnceWith(repo.id);
    await resize(width);
    expect(document.body.textContent).toContain('fixture refresh error');
    expect(document.querySelector('.repository-header-metrics')?.textContent).toContain('v1.0.1');
    expect(buttonByText('重新抓取')?.disabled).toBe(false);
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    expect(tab('趋势')?.getAttribute('aria-selected')).toBe('true');
  });
});
