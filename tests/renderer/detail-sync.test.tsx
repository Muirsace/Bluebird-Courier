// @vitest-environment happy-dom
/**
 * 详情数据协调：打开意图 / 强制命令 / 只读状态轮询 / 版本与上下文 / 有界分页 / 展示确认 / 清单对齐。
 *
 * 这些用例用 fake timer + 可控延迟桩核对"页面到底调了哪一类桥接能力、参数是什么"，
 * 不证明真实 GitHub 请求（那是主进程/门面测试与集成验收的事）。桩按真实契约做有界切片：
 * 游标绑定版本与访问上下文，单次请求的 itemLimit 不超过上限，README / 目录树不在展示范围。
 */
import { act, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import type { DetailScope } from '../../src/shared/types';
import type { DetailViewSnapshot } from '../../src/renderer/lib/detail-view';
import { LOCAL_READ_MAX_LIMIT } from '../../src/shared/types';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByLabel,
  buttonByText,
  click,
  createStub,
  listRows,
  makeCommits,
  makeDetail,
  makeGlance,
  makeIssues,
  makePulls,
  makeReleases,
  makeTask,
  renderApp,
  renderNode,
  repoOpenButton,
  resetSystemTheme,
  sectionByTitle,
  setViewportWidth,
  settle,
  tab,
} from './helpers';
import { DetailPage } from '../../src/renderer/pages/DetailPage';

vi.mock('react-chartjs-2', () => import('./chart-stub'));

const REPO = 'owner/repo';
const repo = makeGlance(1, REPO);
const SAMPLE_RELEASE = { tagName: 'v9.9.9', title: 'Sample release', publishedAt: '2026-10-01T00:00:00.000Z' };
/** 轮询间隔与实现一致：500～1000ms 之间。 */
const POLL_MS = 700;
/** 单次 IPC 的每范围条目上限（与实现和契约一致）。 */
const PAGE_LIMIT = LOCAL_READ_MAX_LIMIT;

let view: RenderResult | null = null;
let stub: StubHandle;

beforeEach(() => { vi.useFakeTimers(); });

afterEach(async () => {
  if (view) { await view.unmount(); view = null; }
  onlineManager.setOnline(true);
  resetSystemTheme();
  setViewportWidth(768);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(options: Parameters<typeof createStub>[0] = {}): Promise<RenderResult> {
  stub = createStub({ repositories: [repo], detail: { releases: [SAMPLE_RELEASE] }, ...options });
  view = await renderApp(stub);
  await settle();
  return view;
}

async function open(): Promise<void> {
  await click(repoOpenButton(REPO));
  await settle();
}

/**
 * 推进虚拟时间并冲刷 promise 链（轮询一拍）。
 * 多推进 1ms：React Query 的通知经 0ms 定时器落地，只推进 0ms 时不会跑它。
 */
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms + 1); });
  await settle();
}

function detailCommand(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.detail-page');
}

/** 桩收到的最后一次 view 读取请求。 */
function lastViewRead(): { scopes?: readonly DetailScope[]; itemLimit?: number; cursors?: Record<string, string | null> } | undefined {
  return stub.readRequests.filter((request) => request.mode === 'view').at(-1);
}

/** 提交列表里的条目数（限定在「提交」区块内）。 */
function commitRows(): number {
  const section = sectionByTitle('提交');
  return section ? listRows(section).length : 0;
}

describe('打开意图与强制命令', () => {
  it('每次导航表达一次打开意图，强制命令独立计数且带 force', async () => {
    await mount();
    await open();
    expect(stub.calls.fetchDetail).toBe(1);
    expect(stub.calls.refreshRepository).toBe(0);

    // 回到清单再进同一个仓库：缓存命中也要表达打开意图
    await click(buttonByText('← 返回监控清单'));
    await settle();
    await open();
    expect(stub.calls.fetchDetail).toBe(2);
    expect(stub.calls.refreshRepository).toBe(0);

    await click(buttonByText('重新抓取'));
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);
    expect(stub.calls.refreshRepository).toBe(1);
    expect(stub.refreshRequests).toEqual([{ repositoryId: repo.id, force: true }]);
  });

  it('缓存命中时首帧就展示内容，不等打开意图返回', async () => {
    await mount();
    await open();
    const panel = document.querySelector('[role="tabpanel"]');
    expect(panel?.textContent).toContain('Sample release');

    // 重进时把打开意图挂起：内容来自 L1/L2，立即显示，不回到 Loading
    const held = stub.holdNextOpen();
    await click(buttonByText('← 返回监控清单'));
    await settle();
    await click(repoOpenButton(REPO));
    await settle();
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('Sample release');
    expect(document.querySelector('.loading-panel')).toBeNull();
    await act(async () => held());
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);
    expect(stub.calls.refreshRepository).toBe(0);
  });

  it('强制失败保留同仓库同上下文的内容，只给出局部错误', async () => {
    await mount();
    await open();
    const panel = document.querySelector('[role="tabpanel"]');
    stub.nextForceResult({ detail: null, error: { kind: 'network', message: '网络请求失败' } });
    await click(buttonByText('重新抓取'));
    await settle();
    expect(document.querySelector('.state-error-bar')?.textContent).toContain('重新抓取失败');
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('Sample release');
    expect(detailCommand()?.querySelector('.state-workspace')).toBeNull();
  });

  it('强制在途时的只读翻页不会让忙碌永久卡住，收尾后仍可再下命令', async () => {
    await mount({ detail: { commits: makeCommits(80) } });
    await open();
    await click(tab('提交'));
    await settle();

    const release = stub.holdNextForce();
    await click(buttonByText('重新抓取'));
    await settle();
    expect(buttonByText('抓取中…')).not.toBeNull();

    // 强制在途时用户继续翻页：只读读取与命令叠加，不能把命令的收尾作废
    await click(buttonByLabel('提交 下一页'));
    await settle();
    expect(stub.calls.readLocalView).toBeGreaterThan(0);
    expect(buttonByText('抓取中…')).not.toBeNull();

    await act(async () => release());
    await settle();
    expect(buttonByText('重新抓取')?.disabled).toBe(false);

    // 收尾之后新命令可以执行
    await click(buttonByText('重新抓取'));
    await settle();
    expect(stub.calls.refreshRepository).toBe(2);
  });

  it('强制以失败 / 抛错收尾时也释放自己的忙碌状态', async () => {
    await mount({ detail: { commits: makeCommits(80) } });
    await open();
    await click(tab('提交'));
    await settle();
    const release = stub.holdNextForce();
    stub.nextForceResult({ detail: null, error: { kind: 'network', message: '网络请求失败' } });
    await click(buttonByText('重新抓取'));
    await settle();
    await click(buttonByLabel('提交 下一页'));
    await settle();
    await act(async () => release());
    await settle();
    expect(buttonByText('重新抓取')?.disabled).toBe(false);
    expect(buttonByLabel('提交 上一页')).not.toBeNull();

    // 抛错路径
    const spy = vi.spyOn(stub.api, 'refreshRepository').mockRejectedValueOnce(new Error('stub: 强制抛错'));
    await click(buttonByText('重新抓取'));
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(buttonByText('重新抓取')?.disabled).toBe(false);
  });

  it('强制被缓存清理作废时仍释放自己的忙碌状态', async () => {
    const rendered = await mount({ detail: { commits: makeCommits(80) } });
    await open();
    const release = stub.holdNextForce();
    await click(buttonByText('重新抓取'));
    await settle();
    expect(buttonByText('抓取中…')).not.toBeNull();

    // 清理换代：在途的强制回包已作废，但命令本身已经结束
    await act(async () => { await rendered.queryClient.resetQueries({ queryKey: ['detail'] }); });
    await act(async () => release());
    await settle();
    expect(buttonByText('重新抓取')?.disabled).toBe(false);
  });

  it('强制在途时的 status 重读也不会让忙碌卡住', async () => {
    await mount({ detail: { commits: makeCommits(12) }, local: { task: makeTask({ status: 'running' }) } });
    await open();
    await advance(POLL_MS);
    const statusCalls = stub.calls.readLocalStatus;

    const release = stub.holdNextForce();
    await click(buttonByText('抓取中…'));
    await settle();
    // 强制在途时后台状态轮询照常进行
    stub.setTask(null);
    await advance(POLL_MS);
    expect(stub.calls.readLocalStatus).toBe(statusCalls + 1);
    await act(async () => release());
    await settle();

    // 任务与强制都已收尾：入口恢复可操作
    expect(buttonByText('重新抓取')?.disabled).toBe(false);
  });
});

describe('后台任务期间的只读状态轮询', () => {
  it('趋势保留窗口变化但数据库版本未变，状态和切Tab仍重读正确窗口', async () => {
    const point = (stars: number) => ({ capturedAt: '2026-09-01T00:00:00.000Z', stars, forks: 1, openIssues: null, latestReleaseTag: null, pushedAt: null });
    const rendered = await mount({ detail: { trend: [point(1), point(2), point(3)] }, local: { task: makeTask({ status: 'running' }) } });
    let trendWindow = '2026-08-28';
    const originalOpen = stub.api.fetchDetail;
    stub.api.fetchDetail = async (id) => ({ ...await originalOpen(id), trendWindow });
    const originalRead = stub.api.readLocalDetail;
    stub.api.readLocalDetail = async (id, request) => ({ ...await originalRead(id, request), trendWindow });
    await open();
    await click(tab('提交'));
    trendWindow = '2026-08-29';
    stub.setLocal({ detailPatch: { trend: [point(2), point(3)] } });
    await advance(POLL_MS);
    const reads = stub.calls.readLocalView;
    await click(tab('趋势'));
    await settle();
    expect(stub.calls.readLocalView).toBe(reads + 1);
    const snapshot = rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id]);
    expect(snapshot?.viewVersion).toBe(1);
    expect(snapshot?.detail?.trend.map(item => item.stars)).toEqual([2, 3]);
    expect(snapshot?.windows.trends?.trendWindow).toBe('2026-08-29');
  });

  it('其他范围报错时仍接收成功范围的有效本地内容', async () => {
    await mount({ detail: { commits: makeCommits(2, 'old') }, local: { task: makeTask({ status: 'running' }) } });
    await open();
    await click(tab('提交'));
    const read = stub.api.readLocalDetail;
    stub.api.readLocalDetail = async (id, request) => {
      const result = await read(id, request);
      return request?.mode === 'view'
        ? { ...result, error: { kind: 'network', message: '其他范围抓取失败' } }
        : result;
    };
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, detailPatch: { commits: makeCommits(3, 'new') } });
    await advance(POLL_MS);
    expect(sectionByTitle('提交')?.textContent).toContain('new 提交 3');
    expect(sectionByTitle('提交')?.textContent).not.toContain('old 提交');
  });

  it('仅趋势版本变化，切回趋势也要读取最新样本', async () => {
    const rendered = await mount({ local: { task: makeTask({ status: 'running' }) } });
    await open();
    await click(tab('提交'));
    stub.setLocal({ viewVersion: 2, detailViewVersion: 1, detailPatch: {
      trend: [{ capturedAt: '2026-10-08T00:00:00.000Z', stars: 9876, forks: 543, openIssues: null, latestReleaseTag: null, pushedAt: null }],
    } });
    await advance(POLL_MS);
    const before = stub.calls.readLocalView;
    await click(tab('趋势'));
    await settle();
    expect(stub.calls.readLocalView).toBe(before + 1);
    expect(lastViewRead()?.scopes).toEqual(['trends']);
    expect(rendered.queryClient.getQueryData<{ detail: { trend: Array<{ stars: number }> } }>(['detail', repo.id])?.detail.trend[0]?.stars)
      .toBe(9876);
  });

  it('只读 status：相同内容版本不重读内容，也不产生 GitHub 请求', async () => {
    await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();
    const panel = document.querySelector('[role="tabpanel"]');
    const opensBefore = stub.calls.fetchDetail;

    // 打开返回的任务快照驱动短轮询：第一拍在 500～1000ms 之后
    expect(stub.calls.readLocalStatus).toBe(0);
    await advance(POLL_MS);
    expect(stub.calls.readLocalStatus).toBe(1);
    expect(stub.calls.readLocalView).toBe(0);
    expect(stub.calls.fetchDetail).toBe(opensBefore);
    expect(stub.calls.refreshGlance).toBe(0);
    expect(stub.readRequests.every((request) => request.mode === 'status')).toBe(true);
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
  });

  it('轮询非重叠：上一拍未返回时不再发下一拍', async () => {
    await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();

    const held = stub.holdNextStatus();
    await advance(POLL_MS);
    expect(stub.calls.readLocalStatus).toBe(1);
    // 挂起期间推进多拍：不会叠加新的 status 读取
    await advance(POLL_MS * 3);
    expect(stub.calls.readLocalStatus).toBe(1);
    await act(async () => held());
    await advance(POLL_MS);
    expect(stub.calls.readLocalStatus).toBe(2);
  });

  it('新内容版本重读当前 Tab 的范围，并保留同一个内容节点', async () => {
    await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();
    const panel = document.querySelector('[role="tabpanel"]');

    stub.setLocal({
      viewVersion: 2,
      detailViewVersion: 2,
      detailPatch: { releases: [{ tagName: 'v2.0.0', title: 'New release', publishedAt: new Date().toISOString() }] },
    });
    await advance(POLL_MS);

    expect(stub.calls.readLocalStatus).toBe(1);
    expect(stub.calls.readLocalView).toBe(1);
    // 读到的是当前 Tab（概览）展示的范围（不含 README / 目录树）
    const scopes = lastViewRead()?.scopes ?? [];
    expect([...scopes].sort()).toEqual(['builds', 'commits', 'issuesAndPr', 'overview', 'releases', 'trends']);
    expect(panel?.textContent).toContain('New release');
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    // 全程没有新的打开意图或 GitHub 类命令
    expect(stub.calls.fetchDetail).toBe(1);
    expect(stub.calls.refreshGlance).toBe(0);
  });

  it('版本变化只重读当前 Tab 的范围，其他范围留到切换该 Tab 时再读', async () => {
    await mount({ detail: { releases: [SAMPLE_RELEASE], commits: makeCommits(6) } });
    stub.setTask(makeTask({ status: 'running' }));
    await open();
    await click(tab('提交'));
    await settle();
    // 换 Tab 不改版本，窗口仍然有效：不发多余的本地读取
    expect(stub.calls.readLocalView).toBe(0);

    stub.setLocal({ viewVersion: 2, detailViewVersion: 2 });
    await advance(POLL_MS);
    expect([...(lastViewRead()?.scopes ?? [])].sort()).toEqual(['commits', 'overview']);

    // 发版范围没有被这次读取带走：切过去时才读它（概览元数据已是当前版本，不重复读）
    const before = stub.calls.readLocalView;
    await click(tab('发版'));
    await settle();
    expect(stub.calls.readLocalView).toBe(before + 1);
    expect([...(lastViewRead()?.scopes ?? [])].sort()).toEqual(['releases']);
    expect(sectionByTitle('发版')?.textContent).toContain('Sample release');
  });

  it('只重读某个范围不会擦掉其他范围已展示的内容', async () => {
    await mount({ detail: { releases: [SAMPLE_RELEASE], commits: makeCommits(80) } });
    await open();
    expect(sectionByTitle('最新发版')?.textContent).toContain('Sample release');

    await click(tab('提交'));
    await settle();
    await click(buttonByLabel('提交 下一页'));
    await settle();
    // 翻页只请求该范围
    expect([...(lastViewRead()?.scopes ?? [])]).toEqual(['commits']);

    await click(tab('概览'));
    await settle();
    expect(sectionByTitle('最新发版')?.textContent).toContain('Sample release');
  });

  it('后继任务无间隙：task 结束那一拍仍读到最终版本，随后停止轮询', async () => {
    await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();

    // 第一拍：后继任务仍在跑，出现中间版本
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, detailPatch: { releases: [{ tagName: 'v-mid', title: 'Mid', publishedAt: new Date().toISOString() }] } });
    await advance(POLL_MS);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('v-mid');

    // 第二拍：任务已结束，但最终版本必须补读到
    stub.setTask(null);
    stub.setLocal({ viewVersion: 3, detailViewVersion: 3, detailPatch: { releases: [{ tagName: 'v-final', title: 'Final', publishedAt: new Date().toISOString() }] } });
    await advance(POLL_MS);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('v-final');

    // 任务结束即为终点：之后不再有短轮询
    const statusCalls = stub.calls.readLocalStatus;
    for (let index = 0; index < 4; index += 1) await advance(POLL_MS);
    expect(stub.calls.readLocalStatus).toBe(statusCalls);
    expect(stub.calls.fetchDetail).toBe(1);
    expect(stub.calls.refreshGlance).toBe(0);
  });

  it('页面隐藏暂停短轮询，恢复可见后继续', async () => {
    await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();

    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await advance(POLL_MS * 2);
    expect(stub.calls.readLocalStatus).toBe(0);

    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await advance(POLL_MS);
    expect(stub.calls.readLocalStatus).toBe(1);
  });

  it('后台任务进行中禁用强制入口（忙碌覆盖强制与后台 task）', async () => {
    await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();
    const busy = buttonByText('抓取中…');
    expect(busy).not.toBeNull();
    expect(busy?.disabled).toBe(true);
    expect(busy?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('.repository-header-fetched')?.textContent).toContain('正在更新');

    // 任务结束（轮询读到 null）后恢复可操作
    stub.setTask(null);
    await advance(POLL_MS);
    expect(buttonByText('重新抓取')?.disabled).toBe(false);
  });

  it('真正离线也读本地：详情桥接不被在线门控暂停', async () => {
    onlineManager.setOnline(false);
    await mount({ local: { task: makeTask({ status: 'running' }) } });
    await open();
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('Sample release');
    expect(stub.calls.fetchDetail).toBe(1);

    // 新版本到来时用只读 view 重读本地：离线状态不参与门控
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, detailPatch: { releases: [{ tagName: 'v-offline', title: 'Offline', publishedAt: new Date().toISOString() }] } });
    await advance(POLL_MS);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('v-offline');
    expect(stub.calls.readLocalView).toBe(1);
  });

  it('离开详情或切换仓库后不再轮询', async () => {
    const other = makeGlance(2, 'owner/other');
    await mount({ repositories: [repo, other], local: { task: makeTask({ status: 'running' }) } });
    await open();
    await advance(POLL_MS);
    expect(stub.calls.readLocalStatus).toBe(1);

    // 离开详情：短轮询随组件卸载停止
    stub.setTask(null);
    await click(buttonByText('← 返回监控清单'));
    await settle();
    const afterLeave = stub.calls.readLocalStatus;
    for (let index = 0; index < 3; index += 1) await advance(POLL_MS);
    expect(stub.calls.readLocalStatus).toBe(afterLeave);

    // 切到另一个仓库：没有任务就不开启短轮询
    await click(repoOpenButton(other.fullName));
    await settle();
    const afterSwitch = stub.calls.readLocalStatus;
    for (let index = 0; index < 3; index += 1) await advance(POLL_MS);
    expect(stub.calls.readLocalStatus).toBe(afterSwitch);
    expect(stub.calls.fetchDetail).toBe(2);
  });
});

describe('版本与访问上下文', () => {
  it('访问上下文变化后旧内容作废，按新上下文重读', async () => {
    await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('Sample release');

    // Token 更换：新访问上下文、本地资料已清理
    stub.setLocal({ accessContextRevision: 2, localEmpty: true, detailPatch: {} });
    await advance(POLL_MS);

    expect(stub.calls.readLocalView).toBe(1);
    expect(document.querySelector('[role="tabpanel"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Sample release');
  });

  it('打开意图在途时被清理：迟到的旧上下文回包不回填缓存', async () => {
    const rendered = await mount();
    const held = stub.holdNextOpen();
    stub.nextOpenResult({
      detail: makeDetail(repo, { releases: [{ tagName: 'v-old', title: 'Old release', publishedAt: new Date().toISOString() }] }),
      error: null,
      viewVersion: 1,
      detailViewVersion: 1,
      accessContextRevision: 1,
      summaryFetchedAt: null,
      detailFetchedAt: null,
      columns: {},
      syncState: {},
      task: null,
    });
    await open();

    // Token 更换的清理：先取消在途请求，再重置缓存
    stub.setLocal({ accessContextRevision: 2, localEmpty: true, detailPatch: {} });
    await act(async () => {
      await rendered.queryClient.cancelQueries({ queryKey: ['detail'] });
      await act(async () => { await rendered.queryClient.resetQueries({ queryKey: ['detail'] }); });
    });
    await settle();

    await act(async () => held());
    await settle();

    const cached = rendered.queryClient.getQueryData<{ detail: unknown; accessContextRevision: number }>(['detail', repo.id]);
    expect(cached?.detail ?? null).toBeNull();
    expect(cached?.accessContextRevision ?? 2).toBe(2);
    expect(document.body.textContent).not.toContain('Old release');
  });

  it('缓存被清理后，在途的只读翻页结果不回填旧页', async () => {
    const rendered = await mount({ detail: { commits: makeCommits(235, 'old') } });
    await open();
    await click(tab('提交'));
    await settle();
    expect(commitRows()).toBe(30);

    const held = stub.holdNextView();
    await click(buttonByLabel('提交 下一页'));
    await settle();

    // Token 更换：取消 + 重置缓存，世代推进；本地换成新上下文的短列表
    stub.setLocal({ accessContextRevision: 2, detailPatch: { commits: makeCommits(4, 'fresh') } });
    await act(async () => { await rendered.queryClient.resetQueries({ queryKey: ['detail'] }); });
    await settle();
    await act(async () => held());
    await settle();

    // 迟到的第 2 页（旧上下文、旧版本）不得写回
    expect(document.body.textContent).not.toContain('old 提交 31');
    expect(document.body.textContent).toContain('fresh 提交 1');
  });

  it('缓存被移除后不会出现未经校验的自动回填', async () => {
    const rendered = await mount({ detail: { commits: makeCommits(235) } });
    await open();
    await click(tab('提交'));
    await settle();
    const viewsBefore = stub.calls.readLocalView;

    const held = stub.holdNextView();
    await click(buttonByLabel('提交 下一页'));
    await settle();
    await act(async () => { rendered.queryClient.removeQueries({ queryKey: ['detail'] }); });
    await act(async () => held());
    await settle();

    expect(rendered.queryClient.getQueryData(['detail', repo.id])).toBeUndefined();
    expect(stub.calls.readLocalView).toBe(viewsBefore + 1);
  });

  it('离开仓库后，在途的只读读取不再写回缓存', async () => {
    const rendered = await mount({ detail: { commits: makeCommits(235) } });
    await open();
    await click(tab('提交'));
    await settle();

    const held = stub.holdNextView();
    await click(buttonByLabel('提交 下一页'));
    await settle();
    const before = rendered.queryClient.getQueryData<{ detail: { commits: unknown[] } }>(['detail', repo.id]);
    expect(before?.detail.commits.length).toBe(30);

    await click(buttonByText('← 返回监控清单'));
    await settle();
    await act(async () => held());
    await settle();

    expect(rendered.queryClient.getQueryData<{ detail: { commits: unknown[] } }>(['detail', repo.id])?.detail.commits.length).toBe(30);
  });

  it('同 context 下更旧的版本结果不得倒退覆盖', async () => {
    const rendered = await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, detailPatch: { releases: [{ tagName: 'v-new', title: 'Newer', publishedAt: new Date().toISOString() }] } });
    await advance(POLL_MS);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('Newer');

    stub.setTask(null);
    await advance(POLL_MS);

    // 更旧的强制结果迟到：整份丢弃，忙碌照常收尾
    stub.nextForceResult({
      detail: makeDetail(repo, { releases: [{ tagName: 'v-old', title: 'Older', publishedAt: new Date().toISOString() }] }),
      error: null,
      viewVersion: 1,
      detailViewVersion: 1,
      accessContextRevision: 1,
    });
    await click(buttonByText('重新抓取'));
    await settle();

    expect(rendered.queryClient.getQueryData<{ detailViewVersion: number }>(['detail', repo.id])?.detailViewVersion).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('Newer');
    expect(document.querySelector('[role="tabpanel"]')?.textContent).not.toContain('Older');
    expect(buttonByText('重新抓取')?.disabled).toBe(false);
  });

  it('非活动展示数据 60 秒后回收；再次进入先读 L2 再展示', async () => {
    const rendered = await mount();
    await open();
    expect(document.querySelector('[role="tabpanel"]')).not.toBeNull();

    await click(buttonByText('← 返回监控清单'));
    await settle();
    await advance(61_000);
    expect(rendered.queryClient.getQueryData(['detail', repo.id])).toBeUndefined();

    await open();
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('Sample release');
    expect(stub.calls.fetchDetail).toBe(2);
    expect(stub.calls.refreshRepository).toBe(0);
  });

  it('导航打开与清单触发的打开重叠：更旧的那份不回退', async () => {
    const rendered = await mount();
    // 导航打开被挂起，并给出更新的版本与内容
    const release = stub.holdNextOpen();
    stub.nextOpenResult({
      detail: makeDetail(repo, { releases: [{ tagName: 'v-nav', title: 'Nav open', publishedAt: new Date().toISOString() }] }),
      error: null, viewVersion: 2, detailViewVersion: 2, accessContextRevision: 1,
    });
    await open();

    // 清单带回新摘要：再补一次打开意图（本地视图仍是旧的 v1 内容）
    stub.setRepositories([{ ...repo, stars: 4242, fetchedAt: new Date(Date.now() + 1000).toISOString() }]);
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...repo, stars: 4242, fetchedAt: new Date(Date.now() + 1000).toISOString() }]); });
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);

    await act(async () => release());
    await settle();

    // 先到的更新版本留在缓存里，后到的旧版本被丢弃
    expect(rendered.queryClient.getQueryData<{ detailViewVersion: number }>(['detail', repo.id])?.detailViewVersion).toBe(2);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('Nav open');
  });
});

describe('有界本地读取与分页', () => {
  it('翻页前后台已换版，失效游标的非空错误结果须从新首页恢复', async () => {
    await mount({ detail: { commits: makeCommits(235, 'old') } });
    await open();
    await click(tab('提交'));
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, detailPatch: { commits: makeCommits(4, 'new') } });
    await click(buttonByLabel('提交 下一页'));
    await settle();
    expect(commitRows()).toBe(4);
    expect(sectionByTitle('提交')?.textContent).toContain('new 提交 4');
    expect(sectionByTitle('提交')?.textContent).not.toContain('old 提交');
    expect(buttonByLabel('提交 上一页')?.disabled ?? true).toBe(true);
    expect(lastViewRead()?.cursors ?? {}).toEqual({});
  });

  it('返回首页保留原页边界，再次前进仍显示同一段内容', async () => {
    await mount({ detail: { commits: makeCommits(235) } });
    await open();
    await click(tab('提交'));
    await click(buttonByLabel('提交 下一页'));
    await settle();
    const second = sectionByTitle('提交')?.textContent;
    await click(buttonByLabel('提交 上一页'));
    await settle();
    expect(commitRows()).toBe(30);
    await click(buttonByLabel('提交 下一页'));
    await settle();
    expect(sectionByTitle('提交')?.textContent).toBe(second);
  });

  it('235 条提交可以一路读到最后一页，页长与请求预算都有界', async () => {
    await mount({ detail: { commits: makeCommits(235) } });
    await open();
    await click(tab('提交'));
    await settle();

    // 首屏是本地读取的一页，不是"完整列表"
    expect(commitRows()).toBe(30);
    expect(document.querySelector('.detail-local-read-more')?.textContent).toContain('第 1 页');
    expect(buttonByLabel('提交 上一页')?.disabled).toBe(true);
    const panel = document.querySelector('[role="tabpanel"]');

    await click(buttonByLabel('提交 下一页'));
    await settle();
    expect(commitRows()).toBe(PAGE_LIMIT);
    expect(lastViewRead()?.itemLimit).toBe(PAGE_LIMIT);
    expect(lastViewRead()?.itemLimit ?? 0).toBeLessThanOrEqual(LOCAL_READ_MAX_LIMIT);
    // 翻页只替换内容，不重挂内容节点
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);

    await click(buttonByLabel('提交 下一页'));
    await settle();
    const section = sectionByTitle('提交')!;
    expect(commitRows()).toBe(5);
    expect(section.textContent).toContain('c 提交 235');
    expect(section.textContent).toContain('已抓取 5 条');
    expect(buttonByLabel('提交 下一页')?.disabled).toBe(true);

    // 请求数有界：打开 1 次（不是只读读取）+ 翻页 2 次
    expect(stub.calls.readLocalView).toBe(2);
  });

  it('Issue 与 PR 共享 scope 预算：200 个 Issue 之后的 PR 仍能读到', async () => {
    await mount({ detail: { issues: makeIssues(210), pullRequests: makePulls(5) } });
    await open();
    await click(tab('Issue & PR'));
    await settle();

    // 首页只覆盖 Issue，PR 侧不显示成"确认没有"
    const first = sectionByTitle('Issue & PR')!;
    expect(first.textContent).toContain('议题30 条');
    expect(first.textContent).not.toContain('p 合并请求 1');

    await click(buttonByLabel('Issue & PR 下一页'));
    await settle();

    const second = sectionByTitle('Issue & PR')!;
    expect(second.textContent).toContain('议题180 条');
    expect(second.textContent).toContain('合并请求5 条');
    expect(second.textContent).toContain('p 合并请求 1');
    expect(second.textContent).toContain('p 合并请求 5');
    expect(lastViewRead()?.itemLimit).toBe(PAGE_LIMIT);
    expect(listRows(second).length).toBeLessThanOrEqual(PAGE_LIMIT);
  });

  it('翻到某一范围的最后一页不等于整个范围已经展示：不确认', async () => {
    await mount({ detail: { commits: makeCommits(235) } });
    await open();
    await click(tab('提交'));
    await settle();
    const acksBefore = stub.calls.acknowledgeRepositoryViewed;

    await click(buttonByLabel('提交 下一页'));
    await settle();
    await click(buttonByLabel('提交 下一页'));
    await settle();

    // 已到最后一页，但前面几页并不在展示里：commits 不确认
    expect(buttonByLabel('提交 下一页')?.disabled).toBe(true);
    expect(stub.calls.acknowledgeRepositoryViewed).toBe(acksBefore);
    expect(stub.acknowledgments.some((ack) => ack.scopes.includes('commits'))).toBe(false);
  });

  it('双栏目共享预算：尚未读到的 PR 不显示成"确认没有"', async () => {
    await mount({ detail: { issues: makeIssues(60) } });
    await open();
    await click(tab('Issue & PR'));
    await settle();

    const section = sectionByTitle('Issue & PR')!;
    expect(section.textContent).toContain('可能还有更多未读取');
    expect(section.textContent).not.toContain('当前没有开放的 Issue 或 Pull Request');
  });

  it('换版后旧游标失效：从新窗口重读，不混用旧页', async () => {
    await mount({
      detail: { releases: [SAMPLE_RELEASE], commits: makeCommits(235, 'old') },
      local: { task: makeTask({ status: 'running' }) },
    });
    await open();
    await click(tab('提交'));
    await settle();
    await click(buttonByLabel('提交 下一页'));
    await settle();
    expect(sectionByTitle('提交')?.textContent).toContain('old 提交 31');

    // 后台换版：游标绑定的版本已过时，必须从首页重读新窗口
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, detailPatch: { commits: makeCommits(4, 'new') } });
    await advance(POLL_MS);

    const section = sectionByTitle('提交')!;
    expect(section.textContent).toContain('new 提交 1');
    expect(section.textContent).not.toContain('old 提交 31');
    expect(commitRows()).toBe(4);
    // 重读用当前版本从首页开始：不再带旧游标
    expect(lastViewRead()?.cursors?.commits).toBeUndefined();
  });

  it('发版同样可以继续翻到 200 条之后', async () => {
    const releases = makeReleases(235);
    await mount({ detail: { releases } });
    await open();
    await click(tab('发版'));
    await settle();

    expect(listRows(sectionByTitle('发版')!).length).toBe(30);
    await click(buttonByLabel('发版 下一页'));
    await settle();
    expect(listRows(sectionByTitle('发版')!).length).toBe(PAGE_LIMIT);
    await click(buttonByLabel('发版 下一页'));
    await settle();

    const section = sectionByTitle('发版')!;
    expect(listRows(section).length).toBe(5);
    expect(section.textContent).toContain('v235');
    expect(lastViewRead()?.itemLimit).toBe(PAGE_LIMIT);
  });
});

describe('展示确认', () => {
  it('隐藏页面收到打开结果不确认，恢复可见后才确认', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await mount();
    await open();
    expect(stub.calls.acknowledgeRepositoryViewed).toBe(0);
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(stub.calls.acknowledgeRepositoryViewed).toBeGreaterThan(0);
  });

  it('确认桥接失败被接住，重新展示范围可以重试', async () => {
    await mount();
    const acknowledgment = vi.spyOn(stub.api, 'acknowledgeRepositoryViewed').mockRejectedValueOnce(new Error('本地确认失败'));
    await open();
    expect(acknowledgment).toHaveBeenCalledTimes(1);
    await click(tab('趋势'));
    await click(tab('概览'));
    await settle();
    expect(acknowledgment).toHaveBeenCalledTimes(2);
    expect(stub.calls.acknowledgeRepositoryViewed).toBe(1);
  });

  it('完整强制结果可以省略游标，旧截断事实随之清除', async () => {
    await mount({ detail: { commits: makeCommits(235) } });
    await open();
    await click(tab('提交'));
    expect(document.querySelector('.detail-local-read-more')).not.toBeNull();
    stub.nextForceResult({
      detail: makeDetail(repo), error: null, truncated: false,
      accessContextRevision: 1, viewVersion: 2, detailViewVersion: 2,
    });
    await click(buttonByText('重新抓取'));
    await settle();
    expect(document.querySelector('.detail-local-read-more')).toBeNull();
    expect(stub.acknowledgments.at(-1)?.scopes).toEqual(['commits']);
  });

  it('按实际展示的远端范围与版本确认；截断范围不确认', async () => {
    await mount({ detail: { commits: makeCommits(235) } });
    await open();
    await settle();
    const first = stub.acknowledgments.at(-1)!;
    expect(first.repositoryId).toBe(repo.id);
    expect(first.detailViewVersion).toBe(1);
    expect(first.accessContextRevision).toBe(1);
    // 概览展示 4 个远端范围；commits 被截断、trends 是本地视图，都不确认
    expect([...first.scopes].sort()).toEqual(['builds', 'issuesAndPr', 'releases']);
  });

  it('切到没有远端范围的 Tab 不新增确认；新版本完整读取后用新版本确认', async () => {
    await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();
    await settle();
    const afterOpen = stub.calls.acknowledgeRepositoryViewed;

    await click(tab('趋势'));
    await settle();
    expect(stub.calls.acknowledgeRepositoryViewed).toBe(afterOpen);

    // 后台任务提交了新版本：重读后再切回发版，用实际显示的新版本确认
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2 });
    await advance(POLL_MS);
    expect(stub.calls.acknowledgeRepositoryViewed).toBe(afterOpen);

    await click(tab('发版'));
    await settle();
    const last = stub.acknowledgments.at(-1)!;
    expect(last.detailViewVersion).toBe(2);
    expect([...last.scopes]).toEqual(['releases']);
  });
});

describe('Header 与摘要', () => {
  it('task=null 时同 fetchedAt 仅 latestTag 更新也补一次打开', async () => {
    const rendered = await mount();
    await open();
    const updated = { ...repo, latestTag: 'tag-only' };
    stub.setRepositories([updated]);
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [updated]); });
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);
    await advance(POLL_MS * 3);
    expect(stub.calls.fetchDetail).toBe(2);
    expect(stub.calls.refreshRepository).toBe(0);
  });

  it('清单 structural sharing 保持原条目时仍读取 HEAD/defaultBranch 权威变化并闭环', async () => {
    const rendered = await mount();
    await open();
    const previousEntry = rendered.queryClient.getQueryData<unknown[]>(['repositories'])?.[0];
    const release = stub.holdNextStatus();
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, detailPatch: { commits: makeCommits(2, 'HEAD B') } });
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...repo }]); });
    await settle();
    expect(rendered.queryClient.getQueryData<unknown[]>(['repositories'])?.[0]).toBe(previousEntry);
    expect(stub.calls.readLocalStatus).toBe(1);
    await act(async () => release());
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);
    await click(tab('提交'));
    expect(sectionByTitle('提交')?.textContent).toContain('HEAD B 提交 2');
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...repo }]); });
    await settle();
    await advance(POLL_MS * 3);
    expect(stub.calls.fetchDetail).toBe(2);
  });

  it('首次无缓存 task=null 的 Summary 和 activity 排序消费权威只读清单', async () => {
    setViewportWidth(1152);
    const second = makeGlance(2, 'owner/second');
    const rendered = await mount({ repositories: [second, repo], local: { localEmpty: true } });
    const updated = { ...repo, latestReleaseTag: 'fresh-first', activityAt: '2026-10-08T00:00:00.000Z' };
    stub.setRepositories([updated, second]);
    await open();
    expect(rendered.queryClient.getQueryData<Array<{ id: number }>>(['repositories'])?.map(item => item.id)).toEqual([1, 2]);
    expect(document.querySelector('.repository-sidebar-release')?.textContent).toBe('fresh-first');
    expect(document.querySelector('.repository-header-metrics')?.textContent).toContain('fresh-first');
    expect(stub.calls.fetchDetail).toBe(1);
    expect(stub.calls.refreshGlance).toBe(0);
  });

  it('同版本坏 cursor 的非空 detail 不清空、不推进也不确认', async () => {
    const rendered = await mount({ detail: { commits: makeCommits(80) } });
    await open();
    await click(tab('提交'));
    const cached = rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])!;
    await act(async () => { rendered.queryClient.setQueryData(['detail', repo.id], {
      ...cached, windows: { ...cached.windows, commits: { ...cached.windows.commits!, chain: [null, 'bad-cursor'] } },
    }); });
    const before = stub.calls.readLocalView;
    await click(buttonByLabel('提交 下一页'));
    await settle();
    expect(sectionByTitle('提交')?.textContent).toContain('提交 1');
    expect(rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])?.windows.commits?.index).toBe(0);
    expect(stub.calls.readLocalView).toBe(before + 1);
    expect(document.querySelector('.state-error-bar')).not.toBeNull();
  });

  it('显式未知详情时间覆盖旧已知时间，缺省字段仍保留旧事实', async () => {
    const rendered = await mount({ local: { detailFetchedAt: '2026-10-01T00:00:00.000Z' } });
    await open();
    stub.nextForceResult({ detail: null, error: { kind: 'network', message: '网络失败' } });
    await click(buttonByText('重新抓取'));
    await settle();
    expect(rendered.queryClient.getQueryData<{ detailFetchedAt: string | null }>(['detail', repo.id])?.detailFetchedAt)
      .toBe('2026-10-01T00:00:00.000Z');
    stub.nextForceResult({ detail: makeDetail(repo), error: null, detailFetchedAt: null });
    await click(buttonByText('重新抓取'));
    await settle();
    expect(document.querySelector('.repository-header-detail-time')?.textContent).toContain('尚未完整同步');
  });

  it('用最新主进程 Summary 更新 Stars/Forks，不依赖强制命令', async () => {
    await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();
    expect(document.querySelector('.repository-header-metrics')?.textContent).toContain('1,001');

    // 主进程后台检查后清单带来更新的摘要：只读重读即可更新表头，不发生强制抓取
    stub.setRepositories([{ ...repo, stars: 4242, fetchedAt: new Date(Date.now() + 1000).toISOString() }]);
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2 });
    await advance(POLL_MS);
    expect(document.querySelector('.repository-header-metrics')?.textContent).toContain('4,242');
    expect(stub.calls.refreshRepository).toBe(0);
  });

  it('同一毫秒内的不同摘要也能被识别，只补一次打开意图且不成环', async () => {
    const rendered = await mount();
    stub.setTask(makeTask({ status: 'running' }));
    await open();
    const opensBefore = stub.calls.fetchDetail;

    // 主进程后台推进了摘要：fetchedAt 不变、只有指标不同（仅看时间戳会漏掉）
    stub.setRepositories([{ ...repo, stars: 4242 }]);
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...repo, stars: 4242 }]); });
    await settle();
    expect(stub.calls.fetchDetail).toBe(opensBefore + 1);
    expect(document.querySelector('.repository-header-metrics')?.textContent).toContain('4,242');

    // 视图已反映这份事实：继续轮询不会反复补打开意图
    for (let index = 0; index < 3; index += 1) await advance(POLL_MS);
    expect(stub.calls.fetchDetail).toBe(opensBefore + 1);
  });

  it('详情结果带回的摘要通过权威只读清单协调，不发额外网络意图', async () => {
    setViewportWidth(1152);
    await mount();
    await open();
    const listReads = stub.calls.listRepositories;
    expect(document.querySelector('.repository-sidebar-release')?.textContent).toBe('v1.0.1');

    // 主进程后台已推进了摘要：侧栏读取主进程清单的事实与顺序。
    stub.setRepositories([{ ...repo, latestReleaseTag: 'v9.9.9', fetchedAt: new Date(Date.now() + 1000).toISOString() }]);
    await click(buttonByText('重新抓取'));
    await settle();

    expect(document.querySelector('.repository-sidebar-release')?.textContent).toBe('v9.9.9');
    expect(document.querySelector('.repository-header-metrics')?.textContent).toContain('v9.9.9');
    expect(stub.calls.listRepositories).toBe(listReads + 1);
    expect(stub.calls.refreshGlance).toBe(0);
  });

  it('摘要检查时间与完整详情同步时间分开表达，未知不冒充刚刚', async () => {
    await mount();
    await open();
    const summary = document.querySelector('.repository-header-summary-time')!;
    const detail = document.querySelector('.repository-header-detail-time')!;
    expect(summary.textContent).toContain('摘要检查于');
    expect(summary.textContent).not.toContain('尚未检查');
    expect(detail.textContent).toBe('详情同步于 尚未完整同步');

    // 强制成功后完整详情时间独立推进
    await click(buttonByText('重新抓取'));
    await settle();
    expect(document.querySelector('.repository-header-detail-time')?.textContent).not.toContain('尚未完整同步');
  });

  it('详情时间未知时不冒充刚刚：旧库 / 首次部分成功为尚未完整同步', async () => {
    await mount({ local: { detailFetchedAt: null } });
    await open();
    expect(document.querySelector('.repository-header-detail-time')?.textContent).toContain('尚未完整同步');
  });
});

/** 只读本地读取请求的范围集合（用于核对是否读到未展示范围）。 */
function viewScopes(): DetailScope[] {
  return stub.readRequests.filter((request) => request.mode === 'view').flatMap((request) => [...(request.scopes ?? [])]);
}

describe('清单事实与范围交付永久故障回归', () => {
  it('版本不变但 HEAD/defaultBranch 重要序号变化也只表达一次打开', async () => {
    const rendered = await mount();
    await open();
    stub.setLocal({ scopeState: { commits: { detectedRevision: 3, importantRevision: 3, dirtyReasons: ['head_changed', 'default_branch_changed'] } } });
    await act(async () => { await rendered.queryClient.refetchQueries({ queryKey: ['repositories'], type: 'active' }); });
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...repo }]); });
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);
    expect(stub.calls.refreshRepository).toBe(0);
    expect(stub.calls.refreshGlance).toBe(0);
  });

  it('相同 Glance 的清单更新表达打开并接上后继任务，结束拍交付最终版本', async () => {
    const rendered = await mount({ detail: { commits: makeCommits(2, 'HEAD A') } });
    await open();
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, task: makeTask({ status: 'running' }),
      scopeState: { commits: { detectedRevision: 1, importantRevision: 1, dirtyReasons: ['head_changed'] } } });
    await act(async () => { await rendered.queryClient.refetchQueries({ queryKey: ['repositories'], type: 'active' }); });
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);
    stub.setLocal({ viewVersion: 3, detailViewVersion: 3, task: null, detailPatch: { commits: makeCommits(3, 'HEAD B') },
      scopeState: { commits: { detectedRevision: 1, syncedRevision: 1, importantRevision: 1, dirtyReasons: [] } } });
    await advance(POLL_MS);
    expect(sectionByTitle('最新提交')?.textContent ?? document.querySelector('[role="tabpanel"]')?.textContent).toContain('HEAD B');
    expect(rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])?.windows.commits?.detailViewVersion).toBe(3);
    const reads = stub.calls.readLocalStatus;
    await advance(POLL_MS * 3);
    expect(stub.calls.readLocalStatus).toBe(reads);
    expect(stub.calls.fetchDetail).toBe(2);
  });

  it('清单探针与轮询 status 不重叠，连续清单事件只读取最后待处理事实', async () => {
    const rendered = await mount({ local: { task: makeTask({ status: 'running' }) } });
    await open();
    const release = stub.holdNextStatus();
    await advance(POLL_MS);
    expect(stub.calls.readLocalStatus).toBe(1);
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, task: null });
    await act(async () => {
      rendered.queryClient.setQueryData(['repositories'], [{ ...repo }]);
      rendered.queryClient.setQueryData(['repositories'], [{ ...repo }]);
    });
    await settle();
    expect(stub.calls.readLocalStatus).toBe(1);
    await act(async () => release());
    await settle();
    expect(stub.calls.readLocalStatus).toBe(2);
    expect(stub.calls.fetchDetail).toBe(2);
  });

  it('完整结果与全局 error 并存时按栏目接收成功内容，失败栏目不冒充新窗口', async () => {
    const rendered = await mount({ detail: { releases: [SAMPLE_RELEASE], commits: makeCommits(2, 'old') } });
    await open();
    const previous = rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])!;
    stub.nextForceResult({ detail: makeDetail(repo, { releases: [], commits: makeCommits(3, 'full-success') }),
      columns: { ...previous.columns, releases: { status: 'failed', value: null, error: { kind: 'network', message: 'Release 失败' } } },
      syncState: previous.syncState, accessContextRevision: 1, viewVersion: 2, detailViewVersion: 2,
      error: { kind: 'network', message: 'Release 失败' }, task: null });
    await click(buttonByText('重新抓取'));
    await settle();
    const snapshot = rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])!;
    expect(snapshot.detail?.commits).toHaveLength(3);
    expect(snapshot.detail?.releases).toEqual([SAMPLE_RELEASE]);
    expect(snapshot.windows.commits?.detailViewVersion).toBe(2);
    expect(snapshot.windows.releases?.detailViewVersion).toBe(1);
    expect(snapshot.incomplete?.releases).toBe(true);
    expect(snapshot.error?.message).toBe('Release 失败');
    expect(document.querySelector('.state-error-bar')?.textContent).toContain('网络失败');
  });

  it('同毫秒明确 null 删除 Release 与失败恢复，旧打开和旧清单都不能盖回', async () => {
    setViewportWidth(1152);
    const failed = { ...repo, status: 'deleted' as const, failure: { kind: 'not_found' as const, message: '旧失败' } };
    const rendered = await mount({ repositories: [failed] });
    await open();
    const changed = { ...failed, latestTag: 'old-tag' };
    stub.setRepositories([changed]);
    const releaseList = stub.holdNextList();
    await click(buttonByText('重新抓取'));
    await settle();
    const releaseOpen = stub.holdNextOpen();
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [changed]); });
    await settle();
    const recovered = { ...repo, latestReleaseTag: null, latestTag: null, status: 'active' as const, failure: null };
    stub.setRepositories([recovered]);
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [recovered]); });
    await settle();
    await act(async () => { releaseOpen(); releaseList(); });
    await settle();
    const list = rendered.queryClient.getQueryData<Array<typeof recovered>>(['repositories']);
    const snapshot = rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id]);
    expect(list?.[0]).toMatchObject({ latestReleaseTag: null, latestTag: null, status: 'active', failure: null });
    expect(snapshot?.detail?.repository).toMatchObject({ latestReleaseTag: null, latestTag: null, status: 'active', failure: null });
    expect(document.querySelector('.repository-header-release')?.textContent).toContain('无发版');
    expect(document.querySelector('.repository-sidebar-release')?.textContent).not.toContain('v1.0.1');
    const opens = stub.calls.fetchDetail;
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...recovered }]); });
    await settle();
    await advance(POLL_MS * 3);
    expect(stub.calls.fetchDetail).toBe(opens);
  });

  it('Glance 缺省可选字段保留已知事实，明确 null 才清除且重复事实不再打开', async () => {
    const known = { ...repo, latestTag: 'known-tag', failure: { kind: 'network' as const, message: '已知失败' } };
    const rendered = await mount({ repositories: [known] });
    await open();
    const omitted = { ...repo, stars: 2345 };
    stub.setRepositories([omitted]);
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [omitted]); });
    await settle();
    expect(rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])?.detail?.repository)
      .toMatchObject({ latestTag: 'known-tag', failure: { message: '已知失败' }, stars: 2345 });
    const reads = stub.calls.fetchDetail;
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...omitted }]); });
    await settle();
    expect(stub.calls.fetchDetail).toBe(reads);
    const cleared = { ...omitted, latestTag: null, failure: null };
    stub.setRepositories([cleared]);
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [cleared]); });
    await settle();
    expect(rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])?.detail?.repository)
      .toMatchObject({ latestTag: null, failure: null });
    expect(stub.calls.fetchDetail).toBe(reads + 1);
  });

  it('Token 重置作废在途清单 status 探针，不表达旧上下文打开', async () => {
    const rendered = await mount();
    await open();
    const release = stub.holdNextStatus();
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2 });
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...repo }]); });
    await settle();
    await act(async () => {
      rendered.queryClient.removeQueries({ queryKey: ['detail'] });
      rendered.queryClient.removeQueries({ queryKey: ['repositories'] });
      rendered.queryClient.setQueryData(['repositories'], []);
    });
    await act(async () => release());
    await settle();
    expect(stub.calls.fetchDetail).toBe(1);
    expect(rendered.queryClient.getQueryData(['repositories'])).toEqual([]);
    expect(rendered.queryClient.getQueryData(['detail', repo.id])).toBeUndefined();
  });

  it('清单成功移除当前仓库也作废迟到 status 探针', async () => {
    const rendered = await mount();
    await open();
    const release = stub.holdNextStatus();
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2 });
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...repo }]); });
    await settle();
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], []); });
    await act(async () => release());
    await settle();
    expect(stub.calls.fetchDetail).toBe(1);
    expect(rendered.queryClient.getQueryData(['repositories'])).toEqual([]);
  });

  it('force 与后台本地 view 都采用权威清单排序并保留相同页面节点', async () => {
    setViewportWidth(1152);
    const second = makeGlance(2, 'owner/second');
    const rendered = await mount({ repositories: [repo, second] });
    await open();
    const panel = document.querySelector('[role="tabpanel"]');
    stub.setRepositories([second, { ...repo, activityAt: null, latestReleaseTag: 'force-new' }]);
    await click(buttonByText('重新抓取'));
    await settle();
    expect(rendered.queryClient.getQueryData<Array<{ id: number }>>(['repositories'])?.map(item => item.id)).toEqual([2, 1]);
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    // 打开安排一个后台任务，再通过 status/view 的成功路径协调新的排序。
    stub.setTask(makeTask({ status: 'running' }));
    await click(buttonByText('重新抓取'));
    stub.setRepositories([{ ...repo, latestReleaseTag: 'background-new' }, second]);
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, task: null });
    await advance(POLL_MS);
    expect(rendered.queryClient.getQueryData<Array<{ id: number }>>(['repositories'])?.map(item => item.id)).toEqual([1, 2]);
    expect(document.querySelector('.repository-header-release')?.textContent).toContain('background-new');
    expect(document.querySelector('[role="tabpanel"]')).toBe(panel);
    expect(stub.calls.fetchDetail).toBe(1);
    expect(stub.calls.refreshGlance).toBe(0);
  });

  it('Token Query 重置后迟到只读清单不恢复旧列表，清单重置本身也作废结果', async () => {
    const rendered = await mount();
    await open();
    const release = stub.holdNextList();
    await click(buttonByText('重新抓取'));
    await settle();
    await act(async () => {
      rendered.queryClient.setQueryData(['accessTokenState'], { configured: true, accessContextRevision: 2, cleanupPending: false });
      rendered.queryClient.removeQueries({ queryKey: ['detail'] });
      rendered.queryClient.removeQueries({ queryKey: ['repositories'] });
      rendered.queryClient.setQueryData(['repositories'], []);
    });
    await act(async () => release());
    await settle();
    expect(rendered.queryClient.getQueryData(['repositories'])).toEqual([]);
    expect(rendered.queryClient.getQueryData(['detail', repo.id])).toBeUndefined();
  });

  it('仅 repositories reset 也阻止旧只读清单回填', async () => {
    const rendered = await mount();
    await open();
    const release = stub.holdNextList();
    await click(buttonByText('重新抓取'));
    await settle();
    stub.setRepositories([]);
    await act(async () => { void rendered.queryClient.resetQueries({ queryKey: ['repositories'], exact: true }); });
    await act(async () => release());
    await settle();
    expect(rendered.queryClient.getQueryData(['repositories'])).toEqual([]);
  });

  it('离开详情后迟到清单不能覆盖后来收到的事实', async () => {
    const rendered = await mount();
    await open();
    const release = stub.holdNextList();
    await click(buttonByText('重新抓取'));
    await settle();
    await click(buttonByText('← 返回监控清单'));
    const latest = { ...repo, latestReleaseTag: null };
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [latest]); });
    await act(async () => release());
    await settle();
    expect(rendered.queryClient.getQueryData(['repositories'])).toEqual([latest]);
  });

  it('不可读 releases scope 保留旧字段和窗口，其他成功范围更新且只确认成功范围', async () => {
    const rendered = await mount({ detail: { releases: [SAMPLE_RELEASE], commits: makeCommits(2, 'old') }, local: { task: makeTask({ status: 'running' }) } });
    await open();
    const read = stub.api.readLocalDetail;
    stub.api.readLocalDetail = async (id, request) => {
      const result = await read(id, request);
      if (request?.mode === 'status') return result;
      return { ...result, detail: result.detail && { ...result.detail, releases: [] },
        columns: { ...result.columns, releases: undefined, tags: undefined },
        syncState: { ...result.syncState, releases: { ...result.syncState.releases!, cacheStatus: 'invalid' } },
        error: { kind: 'unknown', message: '受损本地范围' } };
    };
    // 活跃任务通过 status 推进版本，当前概览同时读取多个 scope。
    stub.setLocal({ viewVersion: 3, detailViewVersion: 3, detailPatch: { releases: [], commits: makeCommits(4, 'success') }, task: null });
    await advance(POLL_MS);
    const snapshot = rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])!;
    expect(snapshot.detail?.releases[0]?.title).toBe('Sample release');
    expect(snapshot.windows.releases?.detailViewVersion).toBe(1);
    expect(snapshot.detail?.commits[0]?.message).toContain('success');
    expect(snapshot.windows.commits?.detailViewVersion).toBe(3);
    expect(snapshot.syncState.releases?.cacheStatus).toBe('invalid');
    expect(stub.acknowledgments.filter(item => item.detailViewVersion === 3).every(item => !item.scopes.includes('releases'))).toBe(true);
    expect(document.querySelector('.state-error-bar')?.textContent).toContain('受损本地范围');
  });

  it('组合 scope 一侧成功另一侧 failed，成功字段更新，旧 PR 与窗口保留且空侧有不完整说明', async () => {
    const rendered = await mount({ detail: { issues: makeIssues(2), pullRequests: [] }, local: { task: makeTask({ status: 'running' }) } });
    await open();
    await click(tab('Issue & PR'));
    const read = stub.api.readLocalDetail;
    stub.api.readLocalDetail = async (id, request) => {
      const result = await read(id, request);
      if (request?.mode === 'status') return result;
      return { ...result, columns: { ...result.columns, pullRequests: { status: 'failed', value: null, error: { kind: 'network', message: 'PR 读取失败' } } },
        error: { kind: 'network', message: 'PR 读取失败' } };
    };
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, task: null, detailPatch: { issues: makeIssues(3), pullRequests: makePulls(2) } });
    await advance(POLL_MS);
    const snapshot = rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])!;
    expect(snapshot.detail?.issues).toHaveLength(3);
    expect(snapshot.detail?.pullRequests).toEqual([]);
    expect(snapshot.windows.issuesAndPr?.detailViewVersion).toBe(1);
    expect(snapshot.incomplete?.issuesAndPr).toBe(true);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('更多未读取');
    expect(stub.acknowledgments.some(item => item.detailViewVersion === 2 && item.scopes.includes('issuesAndPr'))).toBe(false);
  });

  it('组合分页部分失败保留当前完整页，不 advance；换版后正常恢复首页', async () => {
    const rendered = await mount({ detail: { issues: makeIssues(40), pullRequests: makePulls(2) } });
    await open();
    await click(tab('Issue & PR'));
    const read = stub.api.readLocalDetail;
    const spy = vi.spyOn(stub.api, 'readLocalDetail').mockImplementationOnce(async (id, request) => {
      const result = await read(id, request);
      return { ...result, columns: { ...result.columns, pullRequests: { status: 'failed', value: null, error: null } }, error: { kind: 'unknown', message: '组合页部分失败' } };
    });
    await click(buttonByLabel('Issue & PR 下一页'));
    await settle();
    expect(rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])?.detail?.issues[0]?.number).toBe(1);
    expect(rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])?.windows.issuesAndPr?.index).toBe(0);
    spy.mockRestore();
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2, detailPatch: { issues: makeIssues(2), pullRequests: makePulls(1) } });
    await click(buttonByLabel('Issue & PR 下一页'));
    await settle();
    expect(rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])?.detail?.issues).toHaveLength(2);
    expect(rendered.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])?.windows.issuesAndPr?.detailViewVersion).toBe(2);
    expect(lastViewRead()?.cursors).toBeUndefined();
  });

  it('同一无变化事实、失败打开、确认与对齐不构成重试循环', async () => {
    const rendered = await mount();
    await open();
    stub.setLocal({ viewVersion: 2, detailViewVersion: 2 });
    stub.nextOpenResult({ detail: null, error: { kind: 'network', message: '打开失败' } });
    await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...repo }]); });
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);
    for (let index = 0; index < 3; index += 1) {
      await act(async () => { rendered.queryClient.setQueryData(['repositories'], [{ ...repo }]); });
      await settle();
      await advance(POLL_MS);
    }
    expect(stub.calls.fetchDetail).toBe(2);
    expect(stub.calls.refreshRepository).toBe(0);
    expect(stub.calls.refreshGlance).toBe(0);
  });

  it('StrictMode 重放 setup 创建新 life，第一次 setup 的迟到高版本不能复活', async () => {
    stub = createStub({ repositories: [repo] });
    const release = stub.holdNextOpen();
    stub.nextOpenResult({ detail: makeDetail(repo, { releases: [{ ...SAMPLE_RELEASE, title: '旧 setup' }] }), error: null,
      accessContextRevision: 1, viewVersion: 99, detailViewVersion: 99 });
    view = await renderNode(stub, <StrictMode><DetailPage workspace={false} repositoryContextVisible={false}
      repositoryId={1} fullName={REPO} onRepositoryContextChange={() => {}} onBack={() => {}} onGoSettings={() => {}} /></StrictMode>);
    await settle();
    expect(stub.calls.fetchDetail).toBe(2);
    await act(async () => release());
    await settle();
    expect(view.queryClient.getQueryData<DetailViewSnapshot>(['detail', repo.id])?.detailViewVersion).toBe(1);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).not.toContain('旧 setup');
  });
});

describe('低内存与不读未展示范围', () => {
  it('不请求也不缓存 README / 目录树', async () => {
    await mount({ detail: { commits: makeCommits(12) } });
    await open();
    await click(tab('概览'));
    await settle();
    await click(tab('提交'));
    await settle();
    expect(viewScopes()).not.toContain('readme');
    expect(viewScopes()).not.toContain('tree');
    const snapshot = view?.queryClient.getQueryData<{ detail: { readmes?: unknown[]; tree?: unknown[] } }>(['detail', repo.id]);
    expect(snapshot?.detail?.readmes ?? []).toEqual([]);
    expect(snapshot?.detail?.tree ?? []).toEqual([]);
    expect(stub.readRequests.every((request) => (request.scopes ?? []).every((scope) => scope !== 'readme' && scope !== 'tree'))).toBe(true);
  });

  it('单次读取的条目上限不超过契约上限', async () => {
    await mount({ detail: { commits: makeCommits(235), releases: [SAMPLE_RELEASE] } });
    await open();
    await click(tab('提交'));
    await settle();
    await click(buttonByLabel('提交 下一页'));
    await settle();
    for (const request of stub.readRequests.filter((item) => item.mode === 'view')) {
      if (request.itemLimit !== undefined) expect(request.itemLimit).toBeLessThanOrEqual(LOCAL_READ_MAX_LIMIT);
    }
  });
});
