// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Detail, DetailResult } from '../../src/shared/types';
import { makeDetail, makeGlance, makeSnapshot, createStub, renderApp, settle, click, repoOpenButton,
  buttonByText, buttonByLabel, tab, typeInto, submitForm, openAddInput, refreshAllButton,
  setViewportWidth, setReducedMotion, resetReducedMotion, setSystemTheme, resetSystemTheme,
  sectionByTitle, repoActionsButton, menuItem, repoSlot, settleMotion } from './helpers';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import { readRendererStyles } from './support/styles';

vi.mock('react-chartjs-2', () => import('./chart-stub'));
const repo = makeGlance(1, 'owner/repo');
const content: Partial<Detail> = { releases: [{ tagName: 'v2.0.0', title: 'Old release', publishedAt: new Date().toISOString() }] };
let view: RenderResult | null = null;
let stub: StubHandle;
afterEach(async () => {
  await view?.unmount(); view = null;
  resetReducedMotion(); resetSystemTheme(); setViewportWidth(768);
  vi.restoreAllMocks();
});
async function mount(width = 900, options: StubOptions = {}): Promise<void> {
  setViewportWidth(width); stub = createStub({ repositories: [repo], ...options });
  view = await renderApp(stub); await settle();
}
async function open(): Promise<void> { await click(repoOpenButton(repo.fullName)); await settle(); }
const detailPage = () => document.querySelector('.detail-page')!;
const addField = () => document.querySelector<HTMLInputElement>('#add-repository-input')!;
const status = () => document.querySelector<HTMLElement>('.watchlist-add-form [role="status"]');

describe('Workspace state ownership', () => {
  it('unselected Workspace has brand and selection guidance, separate from empty Watchlist', async () => {
    await mount(900, { repositories: [] });
    const workspace = document.querySelector('.app-shell-workspace')!;
    const empty = workspace.querySelector('.workspace-empty')!;
    expect(empty.querySelector('h2')?.textContent).toBe('青鸟信使');
    expect(empty.textContent).toContain('从左侧选择一个仓库');
    expect(empty.textContent).toContain('构建和趋势');
    expect(empty.querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(document.querySelector('.repository-list-viewport')?.textContent).toContain('还没有监控仓库');
    expect(workspace.querySelector('.repository-header, [role="tablist"]')).toBeNull();
  });

  it.each([900, 899, 480])('%ipx initial loading retains identity with one live message', async (width) => {
    setViewportWidth(width); stub = createStub({ repositories: [repo] });
    const release = stub.holdNextDetail();
    view = await renderApp(stub); await settle();
    const row = repoOpenButton(repo.fullName)!; row.focus();
    await open();
    const page = detailPage();
    expect(page.querySelector('.repository-header')?.textContent).toContain(repo.fullName);
    expect(page.querySelectorAll('[role="status"]')).toHaveLength(1);
    const loading = page.querySelector('.loading-panel')!;
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.textContent).toBe('正在加载仓库详情…');
    expect(loading.querySelector('.state-spinner')?.getAttribute('aria-hidden')).toBe('true');
    expect(page.querySelector('.state-spinner[role]')).toBeNull();
    expect(page.querySelector('[role="tabpanel"]')).toBeNull();
    await act(async () => release()); await settle();
    expect(page.querySelector('[role="tabpanel"]')).not.toBeNull();
    expect(page.querySelector('.detail-loading-slot')?.getAttribute('aria-hidden')).not.toBe('false');
    expect(page.querySelector('.detail-loading-slot [role="status"]')).toBeNull();
  });

  it.each([900, 899, 480])('%ipx initial error is one failure state with working retry', async (width) => {
    await mount(width, { detailFails: true });
    const row = repoOpenButton(repo.fullName)!; row.focus();
    await open();
    const page = detailPage();
    expect(page.querySelector('.repository-header')?.textContent).toContain(repo.fullName);
    expect(page.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(page.querySelector('.state-workspace')?.textContent).toContain('加载仓库详情失败');
    expect(page.textContent).not.toContain('暂无全量信息');
    expect(page.querySelector('[role="tabpanel"]')).toBeNull();
    if (width >= 900) expect(document.activeElement).toBe(row);
    stub.api.fetchDetail = async () => ({ detail: makeDetail(repo, content), error: null });
    await click(buttonByLabel('重新抓取仓库详情')); await settle();
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.querySelector('[role="tabpanel"]')?.textContent).toContain('Old release');
  });

  it('initial token-invalid failure retains the existing Settings action', async () => {
    await mount();
    stub.api.fetchDetail = async () => ({ detail: null, error: { kind: 'access_token_invalid', message: 'raw token error' } });
    await open(); await click(buttonByText('去设置')); await settle();
    expect(document.querySelector('.settings-page')).not.toBeNull();
    expect(document.querySelector('.detail-page')).toBeNull();
  });

  it('null detail without failure is No Data, not an alert', async () => {
    await mount(); stub.api.fetchDetail = async () => ({ detail: null, error: null }); await open();
    expect(detailPage().querySelector('.state-workspace')?.textContent).toContain('暂无全量信息');
    expect(detailPage().querySelector('[role="alert"]')).toBeNull();
    expect(buttonByLabel('重新抓取仓库详情')).not.toBeNull();
  });

  it('Refresh pending/error preserve data and successful retry has no persistent success feedback', async () => {
    setReducedMotion(true);
    await mount(900, { detail: content }); await open();
    const panel = detailPage().querySelector('[role="tabpanel"]');
    const release = stub.holdNextDetail();
    await click(buttonByText('重新抓取')); await settle();
    expect(buttonByText('抓取中…')?.getAttribute('aria-busy')).toBe('true');
    expect(detailPage().querySelector('.loading-panel')).toBeNull();
    expect(detailPage().querySelector('[role="tabpanel"]')).toBe(panel);
    expect(panel?.textContent).toContain('Old release');
    expect(detailPage().querySelector('[role="status"]')).toBeNull();
    await act(async () => release()); await settle();
    let result: DetailResult = { detail: null, error: { kind: 'network', message: 'private exception' } };
    stub.api.fetchDetail = async () => result;
    await click(buttonByText('重新抓取')); await settle();
    expect(detailPage().querySelector('.state-error-bar')?.textContent).toContain('重新抓取失败');
    expect(detailPage().querySelector('.state-error-bar')?.textContent).not.toContain('private exception');
    expect(detailPage().querySelector('[role="tabpanel"]')).toBe(panel);
    expect(detailPage().querySelector('.state-workspace')).toBeNull();
    result = { detail: makeDetail(repo, content), error: null };
    await click(buttonByText('重试')); await settle();
    expect(detailPage().querySelector('[role="alert"]')).toBeNull();
    expect(detailPage().textContent).not.toContain('刷新成功');
    expect(detailPage().querySelector('[role="tabpanel"]')).toBe(panel);
  });
});

describe('Quiet Section states', () => {
  it('Release, Commit, Build and both-empty Issue/PR retain their sections without alerts', async () => {
    await mount(); await open();
    for (const [title, copy] of [['最新发版', '暂无发版'], ['最近提交', '暂无提交'], ['构建状态', '暂无构建记录'], ['Issue & PR', '当前没有开放的 Issue 或 Pull Request']] as const) {
      const section = sectionByTitle(title)!;
      expect(section.querySelector('.state-section')?.textContent).toContain(copy);
      expect(section.querySelector('[role="alert"], [role="status"], button')).toBeNull();
    }
    await click(tab('Issue & PR'));
    expect(sectionByTitle('Issue & PR')?.querySelectorAll('.state-section')).toHaveLength(1);
  });

  it.each(['issues', 'pullRequests'] as const)('one-sided %s data retains the other empty group', async (field) => {
    const item = { number: 12, title: 'Existing item', body: 'Body', authorName: 'author', state: 'open' as const, updatedAt: new Date().toISOString() };
    await mount(900, { detail: { [field]: [item] } }); await open();
    const emptyCopy = field === 'issues' ? '暂无合并请求' : '暂无议题';
    const summary = sectionByTitle('Issue & PR')!;
    expect(summary.textContent).toContain(emptyCopy);
    expect(summary.querySelectorAll('h3')).toHaveLength(2);
    await click(tab('Issue & PR'));
    const full = sectionByTitle('Issue & PR')!;
    expect([...full.querySelectorAll('h3')].map(h => h.textContent)).toEqual(['议题', '合并请求']);
    expect(full.textContent).toContain(emptyCopy);
    expect(full.textContent).toContain('Existing item');
  });

  it.each([0, 1])('Trend %i snapshots retains insufficient-data meaning without a fake chart', async (count) => {
    await mount(900, { detail: { trend: count ? [makeSnapshot(new Date().toISOString(), 120, 14)] : [] } });
    await open(); await click(tab('趋势'));
    const trend = sectionByTitle('趋势')!;
    expect(trend.querySelector('.state-section')?.textContent).toContain(count ? '已有首次记录，需要更多历史记录才能生成趋势' : '暂无趋势数据，完成更多抓取后这里会显示变化');
    if (count) expect(trend.textContent).toContain('120');
    expect(trend.querySelector('[data-metric]')).toBeNull();
    expect(trend.querySelector('[role="alert"], [role="status"]')).toBeNull();
  });
});

describe('Inline feedback and gate', () => {
  it.each([900, 899, 480])('%ipx Omnibox pending retains input, then announces success once', async (width) => {
    await mount(width); const field = await openAddInput(); await typeInto(field, 'new/repo');
    const release = stub.holdNextAdd(); await submitForm(field.closest('form')!); await settle();
    expect(field.value).toBe('new/repo'); expect(field.disabled).toBe(true);
    const action = buttonByLabel('正在加入仓库')!;
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.querySelector('[role="status"]')).toBeNull();
    expect(refreshAllButton()?.disabled).toBe(false);
    await act(async () => release()); await settle();
    expect(status()?.textContent).toContain('已加入监控清单');
    expect(status()?.getAttribute('aria-atomic')).toBe('true');
    expect(field.form?.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('duplicate is polite feedback with explicit open detail, never auto-navigation', async () => {
    await mount(); await typeInto(addField(), repo.fullName);
    expect(status()?.textContent).toContain('已在监控清单中');
    expect(status()?.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector('.workspace-empty')).not.toBeNull();
    expect(stub.calls.fetchDetail).toBe(0);
    await click(buttonByLabel(`打开 ${repo.fullName} 详情`)); await settle();
    expect(detailPage()).not.toBeNull(); expect(stub.calls.fetchDetail).toBe(1);
  });

  it('invalid input is polite; remote failure is a single alert and keeps input/focus', async () => {
    await mount(900, { addResult: { ok: false, repository: null, error: { kind: 'unknown', message: '长错误内容'.repeat(60) } } });
    const field = addField(); field.focus(); await typeInto(field, 'invalid');
    expect(status()?.id).toBe('add-repository-invalid');
    expect(field.getAttribute('aria-describedby')).toBe(status()?.id);
    await typeInto(field, 'owner/failure'); await submitForm(field.closest('form')!); await settle();
    const errors = field.form?.querySelectorAll('[role="alert"]')!;
    expect(errors).toHaveLength(1); expect(errors[0]?.textContent).toContain('长错误内容');
    expect(field.value).toBe('owner/failure'); expect(document.activeElement).toBe(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('Watchlist refresh error stays in Chrome and old rows remain readable', async () => {
    await mount(); stub.api.refreshGlance = async () => ({ repositories: [repo], errors: [{ kind: 'network', message: 'network implementation' }] });
    const viewport = document.querySelector('.repository-list-viewport')!;
    const row = repoOpenButton(repo.fullName)!;
    await click(refreshAllButton()); await settle();
    expect(document.querySelector('.watchlist-sidebar-chrome [role="alert"]')).not.toBeNull();
    expect(viewport.querySelector('[role="alert"]')).toBeNull(); expect(repoOpenButton(repo.fullName)).toBe(row);
    expect(refreshAllButton()?.getAttribute('aria-busy')).toBe('false');
  });

  it('success View location retains inline status and clears it after existing lifecycle', async () => {
    await mount(900, { repositories: Array.from({ length: 25 }, (_, i) => makeGlance(i + 1, `owner/repo-${i}`)) });
    const root = document.querySelector<HTMLElement>('.repository-list-viewport')!;
    root.scrollTop = 650;
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 700 });
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 2500 });
    const scroll = vi.spyOn(window, 'scrollTo');
    await typeInto(addField(), 'owner/new'); await submitForm(addField().form!); await settle();
    expect(status()?.className).toContain('state-inline-feedback');
    const target = repoSlot('owner/new')!;
    const reveal = vi.spyOn(target, 'scrollIntoView');
    await click(buttonByText('查看位置'));
    expect(reveal).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    await act(async () => { root.dispatchEvent(new Event('scroll')); root.dispatchEvent(new Event('scrollend')); });
    expect(scroll).not.toHaveBeenCalled();
    await settleMotion(800);
    expect(addField().value).toBe(''); expect(status()).toBeNull();
  });

  it('remove error stays in the existing confirmation, with retry and no new focus jump', async () => {
    await mount(900, { removeFails: true }); await click(repoActionsButton(repo.fullName));
    await click(menuItem('从监控清单移除')); await settle();
    const confirm = buttonByText('移除')!; confirm.focus(); await click(confirm); await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(confirm.disabled).toBe(false); expect(document.activeElement).toBe(confirm);
    expect(repoOpenButton(repo.fullName)).not.toBeNull();
  });

  it('missing token keeps the original Settings gate and privacy copy', async () => {
    setViewportWidth(900); stub = createStub({ repositories: [repo] });
    stub.api.accessTokenState = async () => ({ configured: false });
    view = await renderApp(stub); await settle();
    expect(document.querySelector('.settings-page')?.textContent).toContain('未配置');
    expect(document.querySelector('.settings-page')?.textContent).toContain('令牌仅保存在本机');
    expect(document.querySelector('#accessToken-input')).not.toBeNull();
    expect(document.querySelector('.watchlist-page')).toBeNull(); expect(stub.calls.fetchDetail).toBe(0);
  });

  it('startup token state loading/failure has one signal and existing retry recovers', async () => {
    setViewportWidth(900); stub = createStub();
    let fail = true;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    stub.api.accessTokenState = async () => { await gate; if (fail) throw new Error('raw startup exception'); return { configured: true }; };
    view = await renderApp(stub); await settle();
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(document.querySelector('.loading-panel')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => release()); await settle();
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('raw startup exception');
    fail = false; await click(buttonByText('重试')); await settle();
    expect(document.querySelector('.workspace-empty')).not.toBeNull();
  });

  it.each(['light', 'dark', 'system'] as const)('%s / Reduced Motion keeps neutral state and static decorative loading indicator', async (theme) => {
    setReducedMotion(true); setSystemTheme('dark');
    await mount(900, { preferences: { theme } });
    const release = stub.holdNextDetail(); await open();
    expect(document.documentElement.dataset.theme).toBe(theme === 'light' ? 'light' : 'dark');
    expect(detailPage().querySelector('.state-spinner[aria-hidden="true"]')).not.toBeNull();
    expect(readRendererStyles()).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.state-spinner,[^}]*animation: none;/);
    await act(async () => release()); await settle();
    expect(detailPage().querySelector('.loading-panel')).toBeNull();
    expect(sectionByTitle('最新发版')?.querySelector('.state-section')).not.toBeNull();
  });

  it('all state levels have wrapping contracts without new animation rules', () => {
    const css = readRendererStyles();
    expect(css).toMatch(/\.state-loading\s*\{[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.state-actions\s*\{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.state-workspace\s*\{[^}]*min-width: 0;/);
  });
});
