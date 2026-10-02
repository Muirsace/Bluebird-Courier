/** 渲染层交互测试的公共装置：桩 window.bluebirdCourier + react-query 容器 + DOM 查询与事件辅助。 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { vi } from 'vitest';
import type { AddRepositoryResult, AccessTokenResult, Detail, Glance, GitHubExternalTarget, BluebirdCourierBridge, OpenExternalResult, Snapshot } from '../../src/shared/types';
import { App } from '../../src/renderer/pages/App';
import { ThemeProvider } from '../../src/renderer/lib/theme';

// react 18.3 的 act 需要这个环境标志，否则会在控制台告警
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------- 假系统主题：happy-dom 的 matchMedia 恒为浅色，这里换成可控的 ----------

let systemTheme: 'light' | 'dark' = 'light';
let reducedMotion = false;
let viewportWidth = 768;
const desktopListeners = new Set<() => void>();
const mediaListeners = new Set<() => void>();
const reducedMotionListeners = new Set<() => void>();

function installMatchMedia(): void {
  // 按查询串分别回答：主题读 prefers-color-scheme，动画降级读 prefers-reduced-motion。
  const matchMedia = (query: string): MediaQueryList => {
    const listeners = query === '(min-width: 900px)' ? desktopListeners : query.includes('prefers-reduced-motion') ? reducedMotionListeners : mediaListeners;
    const matchesNow = (): boolean => {
      if (query === '(min-width: 900px)') return viewportWidth >= 900;
      if (query.includes('prefers-reduced-motion')) return reducedMotion;
      if (query.includes('prefers-color-scheme')) return systemTheme === 'dark';
      return false;
    };
    const list = {
      media: query,
      get matches() {
        return matchesNow();
      },
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
      addListener: (listener: () => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: () => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => true,
    };
    return list as unknown as MediaQueryList;
  };
  window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
}

export function setViewportWidth(width: number): void {
  viewportWidth = width;
  for (const listener of desktopListeners) listener();
}

/** 模拟 Windows 切深色 / 浅色：改系统值并通知监听者，等价于 prefers-color-scheme 变化。 */
export function setSystemTheme(theme: 'light' | 'dark'): void {
  systemTheme = theme;
  for (const listener of mediaListeners) listener();
}

export function resetSystemTheme(): void {
  systemTheme = 'light';
  mediaListeners.clear();
}

/** 模拟系统"减少动态效果"开关（下一次挂载生效）。 */
export function setReducedMotion(reduce: boolean): void {
  reducedMotion = reduce;
  for (const listener of reducedMotionListeners) listener();
}

export function resetReducedMotion(): void {
  setReducedMotion(false);
}

// ---------- 桩门面 ----------

export interface StubCalls {
  accessTokenState: number;
  saveAccessToken: number;
  validateAccessToken: number;
  getSettings: number;
  updateSettings: number;
  listRepositories: number;
  refreshGlance: number;
  fetchDetail: number;
  addRepository: number;
  inspectRepositoryInput: number;
  removeRepository: number;
  openGitHubExternal: number;
}

export interface StubHandle {
  api: BluebirdCourierBridge;
  calls: StubCalls;
  /** 桩里当前的偏好项（updateSettings 成功后同步）。 */
  readonly preferences: Record<string, string>;
  /** 收到过的 updateSettings 补丁，按顺序。 */
  settingsPatches: Array<Record<string, string>>;
  /** 收到过的外链目标，按顺序（断言"点了哪条外链"）。 */
  externalTargets: GitHubExternalTarget[];
  /** 收到过的新增仓库原始输入。 */
  addInputs: string[];
  /** 下次 listRepositories 返回的清单（删除成功后用它模拟清单缩小）。 */
  setRepositories(repositories: Glance[]): void;
  /** 让下一次 listRepositories 挂起，返回放行函数。 */
  holdNextList(): () => void;
  /** 让下一次 refreshGlance 挂起，返回放行函数。 */
  holdNextRefresh(): () => void;
  /** 让下一次 removeRepository 挂起，返回放行函数。 */
  holdNextRemove(): () => void;
  /** 让下一次 addRepository 挂起，返回放行函数。 */
  holdNextAdd(): () => void;
  /** 让下一次 openGitHubExternal 挂起，返回放行函数。 */
  holdNextOpen(): () => void;
  /** 让下一次 fetchDetail 挂起，返回放行函数。 */
  holdNextDetail(): () => void;
}

export interface StubOptions {
  repositories?: Glance[];
  /** 第 N 次调用起 reject（1 起算）；0 = 不失败。 */
  listFailFrom?: number;
  refreshGlanceFails?: boolean;
  removeFails?: boolean;
  addResult?: AddRepositoryResult;
  /** getSettings 初始返回的偏好项（如 { theme: 'light' }）。 */
  preferences?: Record<string, string>;
  /** updateSettings 抛错：用于验证主题保存失败的处理。 */
  settingsSaveFails?: boolean;
  /** saveAccessToken 的返回（默认成功）。 */
  saveTokenResult?: AccessTokenResult;
  /** validateAccessToken 的返回（默认成功）。 */
  validateTokenResult?: AccessTokenResult;
  /** 覆盖全量信息的各分区（trend / releases / commits / issues / pullRequests / build）。 */
  detail?: Partial<Detail>;
  /** openGitHubExternal 的返回（默认成功）。 */
  openExternalResult?: OpenExternalResult;
  /** fetchDetail 返回失败 envelope（detail 为 null + error）：首次抓取失败的语义。 */
  detailFails?: boolean;
}

export function makeGlance(id: number, fullName: string): Glance {
  const [owner = '', name = ''] = fullName.split('/');
  return {
    id,
    owner,
    name,
    fullName,
    addedAt: '2026-09-20T00:00:00.000Z',
    stars: 1000 + id,
    forks: 100 + id,
    openIssues: 12,
    pushedAt: '2026-09-26T00:00:00.000Z',
    latestReleaseTag: `v1.0.${id}`,
    fetchedAt: '2026-09-27T00:00:00.000Z',
  };
}

export function makeDetail(repository: Glance, overrides: Partial<Detail> = {}): Detail {
  return {
    repository,
    releases: [],
    commits: [],
    issues: [],
    pullRequests: [],
    build: { status: 'none', conclusion: null, workflowName: null, url: null, finishedAt: null },
    // 空趋势：概览只渲染「随使用积累」提示，不拉 chart.js 画布
    trend: [],
    ...overrides,
  };
}

/** 一条历史快照；不传的指标记空。 */
export function makeSnapshot(
  capturedAt: string,
  stars: number | null = null,
  forks: number | null = null,
): Snapshot {
  return { capturedAt, stars, forks, openIssues: null, latestReleaseTag: null, pushedAt: null };
}

/** 相对"今天本地 0 点"往前 daysAgo 天的 ISO 时间戳；测试里把系统时间定在正午，边界就不会压在数据点上。 */
export function daysAgoIso(daysAgo: number, hour = 0): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

export function createStub(options: StubOptions = {}): StubHandle {
  let repositories = options.repositories ?? [makeGlance(1, 'octocat/Hello-World')];
  let preferences: Record<string, string> = { ...options.preferences };
  const settingsPatches: Array<Record<string, string>> = [];
  let listGate: Promise<void> | null = null;
  let gate: Promise<void> | null = null;
  let removeGate: Promise<void> | null = null;
  let addGate: Promise<void> | null = null;
  let openGate: Promise<void> | null = null;
  let detailGate: Promise<void> | null = null;
  const calls: StubCalls = {
    accessTokenState: 0,
    saveAccessToken: 0,
    validateAccessToken: 0,
    getSettings: 0,
    updateSettings: 0,
    listRepositories: 0,
    refreshGlance: 0,
    fetchDetail: 0,
    addRepository: 0,
    inspectRepositoryInput: 0,
    removeRepository: 0,
    openGitHubExternal: 0,
  };
  const externalTargets: GitHubExternalTarget[] = [];
  const addInputs: string[] = [];

  const api: BluebirdCourierBridge = {
    async accessTokenState() {
      calls.accessTokenState += 1;
      return { configured: true };
    },
    async validateAccessToken() {
      calls.validateAccessToken += 1;
      return options.validateTokenResult ?? { ok: true, error: null };
    },
    async saveAccessToken() {
      calls.saveAccessToken += 1;
      return options.saveTokenResult ?? { ok: true, error: null };
    },
    async getSettings() {
      calls.getSettings += 1;
      return { preferences: { ...preferences }, accessTokenConfigured: true };
    },
    async updateSettings(patch) {
      calls.updateSettings += 1;
      settingsPatches.push({ ...patch });
      if (options.settingsSaveFails) throw new Error('stub: updateSettings 失败');
      preferences = { ...preferences, ...patch };
      return { preferences: { ...preferences }, accessTokenConfigured: true };
    },
    async setThemePreference() {},
    async listRepositories() {
      calls.listRepositories += 1;
      if (listGate) await listGate;
      if (options.listFailFrom && calls.listRepositories >= options.listFailFrom) {
        throw new Error('stub: listRepositories 失败');
      }
      return repositories;
    },
    async addRepository(fullName) {
      calls.addRepository += 1;
      addInputs.push(fullName);
      if (addGate) await addGate;
      if (options.addResult) return options.addResult;
      const nextId = Math.max(0, ...repositories.map((item) => item.id)) + 1;
      const repository = makeGlance(nextId, fullName);
      repositories = [repository, ...repositories];
      return { ok: true, repository, error: null };
    },
    async inspectRepositoryInput(input) {
      calls.inspectRepositoryInput += 1;
      const match = input.trim().match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)\/?$/i);
      return match
        ? { ok: true, owner: match[1]!, name: match[2]! }
        : { ok: false, message: '请输入 GitHub 仓库地址' };
    },
    async removeRepository() {
      calls.removeRepository += 1;
      if (removeGate) await removeGate;
      if (options.removeFails) throw new Error('stub: removeRepository 失败');
    },
    async refreshGlance() {
      calls.refreshGlance += 1;
      if (gate) await gate;
      if (options.refreshGlanceFails) throw new Error('stub: refreshGlance 失败');
      return { repositories, errors: [] };
    },
    async fetchDetail(repositoryId) {
      calls.fetchDetail += 1;
      if (detailGate) await detailGate;
      if (options.detailFails) {
        return { detail: null, error: { kind: 'unknown', message: '抓取全量信息失败，请稍后重试' } };
      }
      const repository = repositories.find((item) => item.id === repositoryId);
      if (!repository) return { detail: null, error: null };
      return { detail: makeDetail(repository, options.detail), error: null };
    },
    async openGitHubExternal(target) {
      calls.openGitHubExternal += 1;
      externalTargets.push(target);
      if (openGate) await openGate;
      return options.openExternalResult ?? { ok: true, reason: null };
    },
  };

  return {
    api,
    calls,
    get preferences() {
      return { ...preferences };
    },
    settingsPatches,
    externalTargets,
    addInputs,
    setRepositories(next) {
      repositories = next;
    },
    holdNextList() {
      let release = (): void => {};
      listGate = new Promise<void>((resolve) => {
        release = () => {
          listGate = null;
          resolve();
        };
      });
      return release;
    },
    holdNextRefresh() {
      let release = (): void => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
    holdNextRemove() {
      let release = (): void => {};
      removeGate = new Promise<void>((resolve) => {
        release = () => {
          removeGate = null;
          resolve();
        };
      });
      return release;
    },
    holdNextAdd() {
      let release = (): void => {};
      addGate = new Promise<void>((resolve) => {
        release = () => {
          addGate = null;
          resolve();
        };
      });
      return release;
    },
    holdNextOpen() {
      let release = (): void => {};
      openGate = new Promise<void>((resolve) => {
        release = () => {
          openGate = null;
          resolve();
        };
      });
      return release;
    },
    holdNextDetail() {
      let release = (): void => {};
      detailGate = new Promise<void>((resolve) => {
        release = () => {
          detailGate = null;
          resolve();
        };
      });
      return release;
    },
  };
}

export interface RenderResult {
  container: HTMLElement;
  unmount: () => Promise<void>;
}

export async function renderApp(stub: StubHandle): Promise<RenderResult> {
  return renderNode(stub, <App />);
}

/** 在同样的 Provider 组合里渲染任意节点（测试自定义探针时用）。 */
export async function renderNode(stub: StubHandle, node: ReactNode): Promise<RenderResult> {
  window.bluebirdCourier = stub.api;
  installMatchMedia();
  const container = document.createElement('div');
  document.body.append(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 60_000 } },
  });
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MotionConfig reducedMotion="user">{node}</MotionConfig>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 让挂起的 promise 链与渲染跑完；happy-dom 下一条 query 链要跨几轮宏任务才收敛。 */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      // 装了假计时器时只推进"当前已排队的 0ms 任务"，不放过真实时间，动画窗口才可控
      if (vi.isFakeTimers()) {
        vi.advanceTimersByTime(0);
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('要点击的元素不存在');
  await act(async () => {
    (element as HTMLElement).click();
  });
}

/** Desktop 常驻输入；Narrow 通过原新增入口展开。 */
export async function openAddInput(): Promise<HTMLInputElement> {
  const input = document.querySelector<HTMLInputElement>('#add-repository-input');
  if (!input) throw new Error('未找到添加仓库输入框');
  if (input.disabled) await click(buttonByLabel('新增仓库'));
  return input;
}

export function refreshAllButton(): HTMLButtonElement | null {
  return buttonByLabel('全部刷新') ?? buttonByText('全部刷新') ?? buttonByText('刷新中…');
}

export async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

export async function pointerDownOutside(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
}

export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('无法取得 input value setter');
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** 主区域（进详情）按钮。 */
export function repoOpenButton(fullName: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="查看 ${fullName} 详情"]`);
}

/** 仓库卡片的外层槽位（承载进出场状态与位置）。 */
export function repoSlot(fullName: string): HTMLElement | null {
  return repoOpenButton(fullName)?.closest<HTMLElement>('li') ?? null;
}

/** 卡片当前的动画阶段：idle / entering / exiting（卡片已不在 DOM 时返回 null）。 */
export function repoMotion(fullName: string): string | null {
  return repoMotionForSlot(repoSlot(fullName));
}

/** Observe interaction eligibility and rendered opacity, without the removed CSS phase attribute. */
export function repoMotionForSlot(slot: HTMLElement | null | undefined): string | null {
  if (!slot) return null;
  if (slot.hasAttribute('inert')) return 'exiting';
  return Number(slot.style.opacity || 1) < 1 ? 'entering' : 'idle';
}

/**
 * 推进 Motion 帧与 CSS animationend 的兜底计时器。
 * 虚拟时间逐帧推进并清空微任务，保留动画开始 / 完成的真实生命周期。
 */
export async function settleMotion(ms = 500): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  });
  await settle();
}

/**
 * 等仓库操作浮层的关闭动画播完。happy-dom 不跑 CSS 动画、也不派发 animationend，
 * 所以这里等的就是组件里那条兜底计时器（关闭 120ms + 余量），到点后外壳才卸载。
 */
export async function settleOverlayClose(): Promise<void> {
  await settleMotion(400);
}

/** 详情首次抓取的揭示容器；`data-reveal` 就是 loading / revealing / ready 三个阶段。 */
export function detailReveal(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.detail-reveal');
}

export function revealPhase(): string | null {
  return detailReveal()?.dataset.reveal ?? null;
}

/** Loading 卡：抓取中在文档流里（visible），数据到达后原地淡出（exiting）。 */
export function loadingSlot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.detail-loading-slot');
}

/** 表头四条指标里正在交叉淡化的"旧值"层（只在揭示窗口内存在）。 */
export function factSwaps(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.detail-fact-from')];
}

/** `···` 操作入口。 */
export function repoActionsButton(fullName: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${fullName} 的仓库操作"]`);
}

/** Exercise the real entry point in each shell, without fabricating a desktop button. */
export async function openRepositoryActions(fullName: string): Promise<void> {
  const button = repoActionsButton(fullName);
  if (button) { await click(button); return; }
  const row = repoOpenButton(fullName);
  if (!row) throw new Error('未找到仓库行');
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 260, clientY: 120 }));
  });
}

/**
 * 只取"当前生效"的那个节点：菜单 → 确认换内容时，旧菜单会带着 aria-hidden + inert
 * 留在 out 层继续淡出，它不是用户此刻看到 / 能操作的菜单。
 * 所有浮层查询都按这条过滤，断言才对应真实的界面状态。
 */
function liveQuery<T extends HTMLElement>(selector: string): T | null {
  return (
    [...document.querySelectorAll<T>(selector)].find(
      (element) => element.closest('[aria-hidden="true"]') === null,
    ) ?? null
  );
}

export function menu(): HTMLElement | null {
  return liveQuery<HTMLElement>('[role="menu"]');
}

export function menuItem(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) =>
        item.closest('[aria-hidden="true"]') === null && (item.textContent?.includes(text) ?? false),
    ) ?? null
  );
}

export function dialog(): HTMLElement | null {
  return liveQuery<HTMLElement>('[role="dialog"]');
}

export function buttonByText(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

/** 按 aria-label 取按钮：外链控件的无障碍名是这轮的主要断言对象。 */
export function buttonByLabel(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === label,
    ) ?? null
  );
}

export function alertTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="alert"]')].map(
    (element) => element.textContent ?? '',
  );
}

/** 清单里的仓库卡片（监控清单用 ul/li 承载）。 */
export function repoRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('main ul > li')];
}

export function bodyText(): string {
  return document.body.textContent ?? '';
}

/** 当前生效主题（由 ThemeProvider 写在 <html> 上）。 */
export function appliedTheme(): string | null {
  return document.documentElement.dataset.theme ?? null;
}

/** 顶部导航按钮（按文案取）。 */
export function navButton(text: string): HTMLButtonElement | null {
  if (text === '设置') {
    const desktop = document.querySelector<HTMLButtonElement>('.desktop-sidebar-brand button[aria-label="设置"]');
    if (desktop) return desktop;
  }
  return (
    [...document.querySelectorAll<HTMLButtonElement>('header nav button')].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

/** 分段控件里的按钮（按文案取）。 */
export function segmentedButton(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

/** 详情页二级 Tab（按文案取）。 */
export function tab(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

/** 进入某个仓库的详情页（点仓库卡片主区域）。 */
export async function openRepo(fullName: string): Promise<void> {
  await settle();
  await click(repoOpenButton(fullName));
  await settle();
}

export interface ChartStubConfig {
  labels: string[];
  datasets: Array<{ label: string; data: Array<number | null>; color: string }>;
  legendDisplay: boolean | null;
  xDisplay: boolean | null;
  yDisplay: boolean | null;
  ariaLabel: string | null;
}

/** 读 tests/renderer/chart-stub.tsx 摊在 DOM 上的 Chart.js 配置（happy-dom 拿不到 2d context）。 */
export function chartConfigs(): ChartStubConfig[] {
  return [...document.querySelectorAll<HTMLElement>('[data-chart]')].map(
    (element) => JSON.parse(element.dataset.chart ?? '{}') as ChartStubConfig,
  );
}

/** 某个指标的趋势卡（stars / forks）。 */
export function trendCard(metric: 'stars' | 'forks'): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-metric="${metric}"]`);
}

/** 某个容器里的列表行（默认整篇）。 */
export function listRows(container: ParentNode = document): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('ul > li')];
}

/** 按标题取一个 Section（用于把断言限定在某个区块里）。 */
export function sectionByTitle(title: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('section')].find(
      (section) => section.querySelector('h2')?.textContent?.trim() === title,
    ) ?? null
  );
}
