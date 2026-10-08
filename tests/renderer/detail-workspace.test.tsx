// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetailResult, Glance } from '../../src/shared/types';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByText, click, createStub, makeDetail, makeGlance, menuItem, navButton,
  renderApp, openRepositoryActions, repoOpenButton, repoSlot, resetReducedMotion,
  resetSystemTheme, setReducedMotion, setSystemTheme, setViewportWidth, settle, tab,
} from './helpers';
import { readRendererStyles } from './support/styles';

let view: RenderResult | null = null;
let stub: StubHandle;
const repos = [makeGlance(1, 'owner/A'), makeGlance(2, 'owner/B')];
const workspace = (): HTMLElement => document.querySelector('.app-shell-workspace')!;
const sidebar = (): HTMLElement => document.querySelector('.repository-list-viewport')!;
const header = (): HTMLElement | null => document.querySelector('.repository-header');
const heading = (): HTMLElement | null => header()?.querySelector('h1, h2') ?? null;
const context = (): HTMLElement | null => document.querySelector('.compact-repo-context');

beforeEach(() => setViewportWidth(1152));
afterEach(async () => {
  await view?.unmount();
  view = null;
  resetReducedMotion();
  resetSystemTheme();
  setViewportWidth(768);
  document.documentElement.scrollTop = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(repositories: Glance[] = repos): Promise<void> {
  stub = createStub({ repositories });
  view = await renderApp(stub);
  await settle();
}
async function open(name = 'owner/A'): Promise<void> {
  await click(repoOpenButton(name));
  await settle();
}
function expectNoRepositoryUI(): void {
  expect(header()).toBeNull();
  expect(document.querySelector('[role="tablist"]')).toBeNull();
  expect(context()).toBeNull();
  expect(document.querySelector('.repo-context-sentinel')).toBeNull();
}

describe('Detail Workspace / Legacy navigation', () => {
  it.each([1366, 1152, 900])('%ipx omits Back from the DOM and focus order', async (width) => {
    setViewportWidth(width);
    await mount();
    const row = repoOpenButton('owner/A')!;
    row.focus();
    await open();
    expect(buttonByText('← 返回监控清单')).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(heading()?.tagName).toBe('H2');
    expect(heading()?.textContent).toBe('A');
    const focusable = [...workspace().querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => !button.disabled && button.tabIndex >= 0);
    expect(focusable[0]?.getAttribute('aria-label')).toBe('在 GitHub 打开 owner/A');
    expect(focusable[1]?.textContent).toContain('重新抓取');
    expect(focusable[2]).toBe(tab('概览'));
    expect(document.querySelector('.view-transition')).toBeNull();
  });

  it.each([899, 768, 480])('%ipx retains Back, forward/back transition and scroll restore', async (width) => {
    setViewportWidth(width);
    await mount();
    document.documentElement.scrollTop = 420;
    await open();
    const back = buttonByText('← 返回监控清单')!;
    expect(back.tabIndex).toBe(0);
    back.focus();
    expect(document.activeElement).toBe(back);
    expect(heading()?.tagName).toBe('H1');
    expect(document.querySelector<HTMLElement>('.view-transition')?.dataset.viewMotion).toBe('forward');
    expect(window.scrollY).toBe(0);
    await click(back);
    await settle();
    expect(document.querySelector<HTMLElement>('.view-transition')?.dataset.viewMotion).toBe('back');
    expect(window.scrollY).toBe(420);
    expect(repoOpenButton('owner/A')).not.toBeNull();
    expectNoRepositoryUI();
  });

  it('crossing 900px changes Back affordance using existing App state', async () => {
    await mount();
    await open();
    await act(async () => setViewportWidth(899));
    await settle();
    expect(buttonByText('← 返回监控清单')).not.toBeNull();
    expect(heading()?.textContent).toBe('A');
    await act(async () => setViewportWidth(900));
    await settle();
    expect(buttonByText('← 返回监控清单')).toBeNull();
    expect(heading()?.textContent).toBe('A');
  });

  it('Desktop Escape keeps the repository workspace selected', async () => {
    await mount();
    await open();
    const before = header();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(header()).toBe(before);
    expect(repoOpenButton('owner/A')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Repository Workspace Header', () => {
  it('keeps repo identity, fetched time, four metrics and existing tabs', async () => {
    await mount();
    await open();
    expect(header()?.textContent).toContain('摘要检查于');
    expect(header()?.querySelector('.repository-header-detail-time')?.textContent).toContain('详情同步于');
    const metrics = header()?.querySelector('.repository-header-metrics')!;
    expect([...metrics.children].map((node) => node.querySelector('span')?.textContent))
      .toEqual(['Stars', 'Forks', '最近活动', '最新版本']);
    expect(metrics.classList.contains('flex')).toBe(true);
    expect(metrics.classList.contains('flex-wrap')).toBe(true);
    expect([...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent))
      .toEqual(['概览', '发版', '提交', 'Issue & PR', '构建', '趋势']);
    expect(tab('概览')?.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps full long identifiers available while allowing title and release truncation', async () => {
    const name = 'MeteorNOX/DeepSeek-Balance-Whale-Widget';
    const tagName = 'release-candidate-very-long-tag-name';
    setViewportWidth(900);
    await mount([{ ...makeGlance(1, name), latestReleaseTag: tagName }]);
    await open(name);
    expect(heading()?.textContent).toBe(name.split('/').pop());
    expect(heading()?.title).toBe(name);
    expect(header()?.querySelector('.repository-header-release')?.getAttribute('title')).toBe(tagName);
    expect(header()?.querySelector('.repository-header-release')?.textContent).toContain(tagName);
    expect(header()?.querySelector('.repository-header-actions button')?.getAttribute('aria-label'))
      .toBe(`在 GitHub 打开 ${name}`);
    // happy-dom has no layout engine: geometry/overflow are checked in the browser separately.
    const css = readRendererStyles();
    expect(css).toMatch(/\.repository-header-identity\s*\{[^}]*min-width: 0/);
    expect(css).toMatch(/\.repository-header-name\s*\{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/);
    expect(css).toMatch(/\.repository-header-actions\s*\{[^}]*flex: none/);
    expect(css).toMatch(/\.repository-header-release \.detail-fact-to\s*\{[^}]*text-overflow: ellipsis/);
  });

  it('GitHub action uses the existing bridge target', async () => {
    await mount();
    await open();
    await click(header()?.querySelector('button[aria-label="在 GitHub 打开 owner/A"]'));
    await settle();
    expect(stub.externalTargets).toEqual([{ kind: 'repository', owner: 'owner', name: 'A' }]);
    expect(stub.calls.openGitHubExternal).toBe(1);
  });

  it('Refresh retains Header / Tabs / title and scroll through loading, success and error', async () => {
    await mount();
    await open();
    const before = { header: header(), heading: heading(), tabs: tab('概览') };
    workspace().scrollTop = 360;
    sidebar().scrollTop = 240;
    const release = stub.holdNextForce();
    await click(buttonByText('重新抓取'));
    await settle();
    const busy = buttonByText('抓取中…')!;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(header()?.textContent).toContain('正在更新');
    await click(busy);
    // 强制命令独立计数；打开意图仍是进入详情的那一次
    expect(stub.calls.refreshRepository).toBe(1);
    expect(stub.calls.fetchDetail).toBe(1);
    await act(async () => release());
    await settle();
    expect(buttonByText('重新抓取')?.disabled).toBe(false);
    stub.nextForceResult({ detail: null, error: { kind: 'unknown', message: 'fixture refresh error' } });
    await click(buttonByText('重新抓取'));
    await settle();
    expect(document.body.textContent).toContain('fixture refresh error');
    expect(header()).toBe(before.header);
    expect(heading()).toBe(before.heading);
    expect(tab('概览')).toBe(before.tabs);
    expect(header()?.textContent).toContain('v1.0.1');
    expect(workspace().scrollTop).toBe(360);
    expect(sidebar().scrollTop).toBe(240);
    expect(buttonByText('重新抓取')?.disabled).toBe(false);
  });

  it.each(['light', 'dark', 'system'] as const)('%s theme changes retain workspace structure and selection', async (theme) => {
    stub = createStub({ repositories: repos, preferences: { theme } });
    view = await renderApp(stub);
    await settle();
    await open();
    const before = header();
    await act(async () => setSystemTheme('dark'));
    await settle();
    expect(document.documentElement.dataset.theme).toBe(theme === 'light' ? 'light' : 'dark');
    expect(header()).toBe(before);
    expect(stub.calls.fetchDetail).toBe(1);
  });
});

describe('Workspace selection and lifecycle', () => {
  it('switches A → loading B without mixed identity/content and preserves Sidebar', async () => {
    await mount();
    await open();
    const slot = sidebar(), list = slot.querySelector('.repo-list');
    sidebar().scrollTop = 400;
    workspace().scrollTop = 700;
    const release = stub.holdNextOpen();
    await open('owner/B');
    expect(heading()?.textContent).toBe('B');
    expect(header()?.textContent).not.toContain('v1.0.1');
    expect(workspace().querySelector('[role="tabpanel"]')).toBeNull();
    expect(workspace().scrollTop).toBe(0);
    expect(sidebar()).toBe(slot);
    expect(sidebar().scrollTop).toBe(400);
    expect(slot.querySelector('.repo-list')).toBe(list);
    await act(async () => release());
    await settle();
    expect(header()?.textContent).toContain('v1.0.2');
    expect(document.querySelector('.view-transition')).toBeNull();
  });

  it('late A response cannot overwrite selected B', async () => {
    await mount();
    let resolveA!: (result: DetailResult) => void;
    stub.api.fetchDetail = async (id) => id === 1
      ? new Promise<DetailResult>((resolve) => { resolveA = resolve; })
      : { detail: makeDetail(repos[1]!), error: null };
    await open();
    await open('owner/B');
    await act(async () => resolveA({ detail: makeDetail(repos[0]!), error: null }));
    await settle();
    expect(heading()?.textContent).toBe('B');
    expect(header()?.textContent).toContain('v1.0.2');
    expect(header()?.textContent).not.toContain('v1.0.1');
  });

  it('rapid A B C D A uses cache without replacing Sidebar nodes or stacking transitions', async () => {
    const repositories = ['A', 'B', 'C', 'D'].map((name, i) => makeGlance(i + 1, `owner/${name}`));
    await mount(repositories);
    const nodes = repositories.map((repo) => repoSlot(repo.fullName));
    const slot = sidebar();
    slot.scrollTop = 480;
    for (const name of ['A', 'B', 'C', 'D', 'A']) {
      await open(`owner/${name}`);
      expect(heading()?.textContent).toBe(name.split('/').pop());
      expect(document.querySelector('.view-transition')).toBeNull();
    }
    // 每次实际导航都表达一次打开意图（含回到已缓存的 A），但没有强制命令
    expect(stub.calls.fetchDetail).toBe(5);
    expect(stub.calls.refreshRepository).toBe(0);
    expect(sidebar()).toBe(slot);
    expect(sidebar().scrollTop).toBe(480);
    expect(repositories.map((repo) => repoSlot(repo.fullName))).toEqual(nodes);
  });

  it('Empty, Settings and removing selected repo contain no repository UI', async () => {
    await mount();
    expectNoRepositoryUI();
    await open();
    await click(navButton('设置'));
    await settle();
    expect(workspace().querySelector('.settings-page')).not.toBeNull();
    expectNoRepositoryUI();
    await open();
    await openRepositoryActions('owner/A');
    await click(menuItem('从监控清单移除'));
    await settle();
    stub.setRepositories([repos[1]!]);
    await click(buttonByText('移除'));
    await settle();
    expect(workspace().querySelector('.workspace-empty')).not.toBeNull();
    expectNoRepositoryUI();
  });

  it('Reduced Motion retains direct desktop switching and legacy Back transition contract', async () => {
    setReducedMotion(true);
    await mount();
    await open();
    await open('owner/B');
    expect(document.querySelector('.view-transition')).toBeNull();
    expect(document.querySelector<HTMLElement>('.detail-reveal')?.dataset.reveal).toBe('ready');
    await act(async () => setViewportWidth(899));
    await click(buttonByText('← 返回监控清单'));
    await settle();
    expect(document.querySelector<HTMLElement>('.view-transition')?.dataset.viewMotion).toBe('back');
  });
});

describe('Desktop sticky and Compact Context', () => {
  it('uses Workspace observers, preserves hysteresis and makes repeated selection a true no-op', async () => {
    const records: Array<{ callback: IntersectionObserverCallback; target?: Element; options?: IntersectionObserverInit; disconnected: boolean }> = [];
    class Observer {
      record: (typeof records)[number];
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = { callback, options, disconnected: false };
        records.push(this.record);
      }
      observe(target: Element): void { this.record.target = target; }
      disconnect(): void { this.record.disconnected = true; }
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    await mount();
    await open();
    const repoObserver = records.find((record) => record.target?.matches('.repo-context-sentinel'))!;
    const tabsObserver = records.find((record) => record.target?.matches('.detail-tabs-sentinel'))!;
    expect(repoObserver.options?.root).toBe(workspace());
    expect(repoObserver.options?.threshold).toEqual([0, 1]);
    expect(tabsObserver.options?.root).toBe(workspace());
    const send = async (record: typeof repoObserver, ratio: number): Promise<void> => {
      await act(async () => record.callback(
        [{ intersectionRatio: ratio, isIntersecting: ratio > 0 } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ));
    };
    await send(repoObserver, 0);
    await send(tabsObserver, 0);
    expect(context()?.dataset.visible).toBe('true');
    expect(document.querySelector('[role="tablist"]')?.getAttribute('data-stuck')).toBe('true');
    await send(repoObserver, 0.5);
    expect(context()?.dataset.visible).toBe('true');
    const before = { header: header(), context: context(), tabs: tab('概览'), calls: stub.calls.fetchDetail, observers: records.length };
    workspace().scrollTop = 640;
    sidebar().scrollTop = 340;
    await open();
    expect(header()).toBe(before.header);
    expect(context()).toBe(before.context);
    expect(tab('概览')).toBe(before.tabs);
    expect(context()?.dataset.visible).toBe('true');
    expect(workspace().scrollTop).toBe(640);
    expect(sidebar().scrollTop).toBe(340);
    expect(stub.calls.fetchDetail).toBe(before.calls);
    expect(records).toHaveLength(before.observers);
    await send(repoObserver, 1);
    expect(context()?.dataset.visible).toBe('false');
    await send(repoObserver, 0);
    await open('owner/B');
    expect(repoObserver.disconnected).toBe(true);
    expect(tabsObserver.disconnected).toBe(true);
    expect(context()?.dataset.visible).toBe('false');
    expect(context()?.querySelector('[title]')?.getAttribute('title')).toBe('owner/B');
    expect(document.querySelector('[role="tablist"]')?.getAttribute('data-stuck')).toBeNull();
  });
});
