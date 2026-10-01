// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_MOTION } from '../../src/renderer/lib/motion';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  alertTexts,
  buttonByText,
  click,
  createStub,
  dialog,
  makeGlance,
  menu,
  menuItem,
  navButton,
  renderApp,
  repoActionsButton,
  repoMotion,
  repoOpenButton,
  repoRows,
  repoMotionForSlot,
  repoSlot,
  resetReducedMotion,
  setReducedMotion,
  settle,
  settleMotion,
  submitForm,
  typeInto,
} from './helpers';

const FIRST = 'octocat/Hello-World';
const SECOND = 'facebook/react';
const THIRD = 'microsoft/TypeScript';

/** 包含仍由 CSS 管理的颜色高亮与其 animationend 兜底。 */
const ENTER_BUDGET = REPO_MOTION.highlightDelayMs + REPO_MOTION.highlightMs + REPO_MOTION.fallbackMs;
/** 退场与相邻卡片的位置补间，外加两帧提交余量。 */
const EXIT_BUDGET = REPO_MOTION.exitLayoutMs + 32;

let handle: StubHandle;
let view: RenderResult | null = null;

beforeEach(() => {
  // 动画窗口全部由测试推进的虚拟时间决定：真实耗时不再影响 entering / exiting 的观测
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});

afterEach(async () => {
  if (view) {
    await view.unmount();
    view = null;
  }
  resetReducedMotion();
  // Flush Motion's shared frame queue before discarding the virtual clock.
  await settleMotion(64);
  vi.useRealTimers();
});

async function mount(options: StubOptions = {}): Promise<void> {
  handle = createStub({
    repositories: [makeGlance(1, FIRST), makeGlance(2, SECOND), makeGlance(3, THIRD)],
    ...options,
  });
  view = await renderApp(handle);
  await settle();
}

async function expandAddForm(): Promise<HTMLInputElement> {
  const trigger = document.querySelector<HTMLButtonElement>('.watchlist-add-trigger');
  if (trigger?.getAttribute('aria-expanded') !== 'true') await click(trigger);
  await settle();
  const input = document.querySelector<HTMLInputElement>('input[aria-label^="监控仓库"]');
  if (!input) throw new Error('未找到添加仓库输入框');
  return input;
}

async function addRepository(fullName: string): Promise<void> {
  const input = await expandAddForm();
  await typeInto(input, fullName);
  await submitForm(input.form!);
  await settle();
}

async function openRemove(fullName: string): Promise<void> {
  await click(repoActionsButton(fullName));
  await settle();
  await click(menuItem('从监控清单移除'));
  await settle();
}

async function confirmRemove(fullName: string): Promise<void> {
  await openRemove(fullName);
  await click(buttonByText('移除'));
  await settle();
}

/** 卡片在清单里的顺序（按仓库 id）。 */
function slotIds(): string[] {
  return repoRows().map((row) => row.dataset.repositoryId ?? '');
}

describe('卡片动画 · 新增进场', () => {
  it('初始已有仓库立即可见，无集体进场或高亮', async () => {
    await mount();
    const rows = repoRows();
    expect(rows.every((row) => repoMotionForSlot(row) === 'idle')).toBe(true);
    expect(rows.every((row) => !row.hasAttribute('data-highlight'))).toBe(true);
    await settleMotion(320);
    expect(repoRows()).toEqual(rows);
    expect(handle.calls.fetchDetail).toBe(0);
  });

  it('空清单新增仍播放 enter，空列表容器不额外占据版面', async () => {
    await mount({ repositories: [] });
    expect(document.querySelector<HTMLUListElement>('.repo-list')?.hidden).toBe(true);
    await addRepository('vercel/next.js');
    expect(repoMotion('vercel/next.js')).toBe('entering');
    expect(document.querySelector<HTMLUListElement>('.repo-list')?.hidden).toBe(false);
    await settleMotion(320);
    expect(repoMotion('vercel/next.js')).toBe('idle');
  });

  it('连续新增保留卡片节点、已有菜单及各自进场，不触发详情抓取', async () => {
    await mount();
    const existing = [FIRST, SECOND, THIRD].map(repoSlot);
    const trigger = repoActionsButton(SECOND);
    await click(trigger);
    expect(menu()).not.toBeNull();
    await addRepository('vercel/next.js');
    const firstAdded = repoSlot('vercel/next.js');
    await addRepository('vitejs/vite');
    expect(slotIds()).toEqual(['5', '4', '1', '2', '3']);
    [FIRST, SECOND, THIRD].forEach((name, index) => expect(repoSlot(name)).toBe(existing[index]));
    expect(repoSlot('vercel/next.js')).toBe(firstAdded);
    expect(repoActionsButton(SECOND)).toBe(trigger);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(repoMotion('vercel/next.js')).toBe('entering');
    expect(repoMotion('vitejs/vite')).toBe('entering');
    await settleMotion(320);
    expect(repoMotion('vercel/next.js')).toBe('idle');
    expect(repoMotion('vitejs/vite')).toBe('idle');
    expect(handle.calls.fetchDetail).toBe(0);
  });

  it('新增成功后只有新卡片进入动画，旧卡片保持静止', async () => {
    await mount();
    await addRepository('vercel/next.js');

    expect(repoRows()).toHaveLength(4);
    expect(slotIds()).toEqual(['4', '1', '2', '3']);
    expect(repoMotion('vercel/next.js')).toBe('entering');
    expect(repoSlot('vercel/next.js')?.dataset.highlight).toBe('true');
    for (const fullName of [FIRST, SECOND, THIRD]) {
      expect(repoMotion(fullName)).toBe('idle');
      expect(repoSlot(fullName)?.dataset.highlight).toBeUndefined();
    }
  });

  it('列表刷新（全部刷新）不会让旧卡片重播进场', async () => {
    await mount();
    await addRepository('vercel/next.js');
    await settleMotion(ENTER_BUDGET + 20);
    expect(repoMotion('vercel/next.js')).toBe('idle');

    await click(buttonByText('全部刷新'));
    await settle();

    for (const fullName of [FIRST, SECOND, THIRD, 'vercel/next.js']) {
      expect(repoMotion(fullName)).toBe('idle');
    }
  });

  it('进场播完后清掉 entering 与高亮状态，卡片仍可聚焦', async () => {
    await mount();
    await addRepository('vercel/next.js');
    expect(repoSlot('vercel/next.js')?.getAttribute('inert')).toBeNull();

    await settleMotion(ENTER_BUDGET + 20);

    expect(repoMotion('vercel/next.js')).toBe('idle');
    expect(repoSlot('vercel/next.js')?.dataset.highlight).toBeUndefined();
    const open = repoOpenButton('vercel/next.js');
    await act(async () => open?.focus());
    expect(document.activeElement).toBe(open);
  });

  it('新增失败不触发任何进场：清单原样不动', async () => {
    await mount({
      addResult: { ok: false, repository: null, error: { kind: 'network', message: '连接中断' } },
    });
    await addRepository('vercel/next.js');

    expect(repoRows()).toHaveLength(3);
    expect(slotIds()).toEqual(['1', '2', '3']);
    expect(repoRows().every((row) => repoMotionForSlot(row) === 'idle')).toBe(true);
  });
});

describe('卡片动画 · 移除退场', () => {
  it('连续删除立即让数据生效，剩余卡片不重新挂载或抓取', async () => {
    await mount();
    const survivor = repoSlot(THIRD);
    const listCalls = handle.calls.listRepositories;
    handle.setRepositories([makeGlance(2, SECOND), makeGlance(3, THIRD)]);
    await confirmRemove(FIRST);
    handle.setRepositories([makeGlance(3, THIRD)]);
    await confirmRemove(SECOND);
    expect(repoMotion(FIRST)).toBe('exiting');
    expect(repoMotion(SECOND)).toBe('exiting');
    // Header reads authoritative query data before either retained exit DOM has finished.
    expect(handle.calls.listRepositories).toBe(listCalls + 2);
    expect(repoSlot(THIRD)).toBe(survivor);
    await settleMotion(EXIT_BUDGET + 20);
    expect(slotIds()).toEqual(['3']);
    expect(repoSlot(THIRD)).toBe(survivor);
    expect(repoMotion(THIRD)).toBe('idle');
    expect(handle.calls.fetchDetail).toBe(0);
  });

  it('删除中离开并返回不复活已删除卡片，已有卡片不重播 enter', async () => {
    await mount();
    handle.setRepositories([makeGlance(1, FIRST), makeGlance(3, THIRD)]);
    await confirmRemove(SECOND);
    expect(repoMotion(SECOND)).toBe('exiting');
    await click(navButton('设置'));
    await settle();
    await click(navButton('监控清单'));
    await settle();
    expect(slotIds()).toEqual(['1', '3']);
    expect(repoRows().every((row) => repoMotionForSlot(row) === 'idle')).toBe(true);
    await settleMotion(EXIT_BUDGET + 20);
    expect(handle.calls.fetchDetail).toBe(0);
  });

  it('删除成功后目标卡片进入退场，播完才从 DOM 移除且不跳到队尾', async () => {
    await mount();
    handle.setRepositories([makeGlance(1, FIRST), makeGlance(3, THIRD)]);

    await confirmRemove(SECOND);

    expect(handle.calls.removeRepository).toBe(1);
    expect(repoMotion(SECOND)).toBe('exiting');
    expect(slotIds()).toEqual(['1', '2', '3']);
    expect(repoMotion(FIRST)).toBe('idle');
    expect(repoMotion(THIRD)).toBe('idle');

    await settleMotion(EXIT_BUDGET + 20);

    expect(slotIds()).toEqual(['1', '3']);
    expect(repoMotion(SECOND)).toBeNull();
  });

  it('删除中间、第一、最后一张都只收起自己的空间', async () => {
    await mount();
    handle.setRepositories([makeGlance(2, SECOND), makeGlance(3, THIRD)]);
    await confirmRemove(FIRST);
    await settleMotion(EXIT_BUDGET + 20);
    expect(slotIds()).toEqual(['2', '3']);

    handle.setRepositories([makeGlance(2, SECOND)]);
    await confirmRemove(THIRD);
    await settleMotion(EXIT_BUDGET + 20);
    expect(slotIds()).toEqual(['2']);

    handle.setRepositories([]);
    await confirmRemove(SECOND);
    await settleMotion(EXIT_BUDGET + 20);
    expect(repoRows()).toHaveLength(0);
  });

  it('删除失败不触发退场：卡片原地不动，Popover 留着报错重试', async () => {
    await mount({ removeFails: true });

    await confirmRemove(SECOND);

    expect(repoMotion(SECOND)).toBe('idle');
    expect(slotIds()).toEqual(['1', '2', '3']);
    expect(dialog()).not.toBeNull();
    expect(alertTexts().join(' ')).toContain('删除失败');

    await settleMotion(EXIT_BUDGET + 40);
    expect(slotIds()).toEqual(['1', '2', '3']);
    expect(handle.calls.removeRepository).toBe(1);
  });

  it('退场中的卡片不再接受任何操作：入口失效、菜单打不开、不会重复调用 remove', async () => {
    await mount();
    handle.setRepositories([makeGlance(1, FIRST), makeGlance(3, THIRD)]);

    await confirmRemove(SECOND);

    expect(repoSlot(SECOND)?.getAttribute('inert')).toBe('');
    const trigger = repoActionsButton(SECOND);
    expect(trigger?.disabled).toBe(true);
    expect(repoOpenButton(SECOND)?.disabled).toBe(true);
    await click(repoOpenButton(SECOND));
    expect(handle.calls.fetchDetail).toBe(0);

    await click(trigger);
    await settle();
    expect(menu()).toBeNull();
    expect(handle.calls.removeRepository).toBe(1);

    await settleMotion(EXIT_BUDGET + 20);
    expect(repoMotion(SECOND)).toBeNull();
  });

  it('移除请求进行中不会重复调用 remove', async () => {
    await mount();
    const release = handle.holdNextRemove();
    await openRemove(SECOND);

    await click(buttonByText('移除'));
    await settle();
    await click(buttonByText('移除中…'));
    await settle();
    expect(handle.calls.removeRepository).toBe(1);

    handle.setRepositories([makeGlance(1, FIRST), makeGlance(3, THIRD)]);
    release();
    await settle();
    await settleMotion(EXIT_BUDGET + 20);
    expect(slotIds()).toEqual(['1', '3']);
  });

  it('刚新增就移除：进场让位给退场，卡片消失且不留进场标记', async () => {
    await mount();
    await addRepository('vercel/next.js');
    expect(repoMotion('vercel/next.js')).toBe('entering');

    handle.setRepositories([makeGlance(1, FIRST), makeGlance(2, SECOND), makeGlance(3, THIRD)]);
    await confirmRemove('vercel/next.js');

    expect(handle.calls.removeRepository).toBe(1);
    expect(repoMotion('vercel/next.js')).toBe('exiting');

    await settleMotion(EXIT_BUDGET + 20);

    expect(slotIds()).toEqual(['1', '2', '3']);
    expect(repoRows().every((row) => repoMotionForSlot(row) === 'idle')).toBe(true);
    expect(repoRows().every((row) => row.dataset.highlight === undefined)).toBe(true);
  });

  it('删除后的焦点交给下一张卡片，最后一张删除后回到新增入口', async () => {
    await mount();
    handle.setRepositories([makeGlance(1, FIRST), makeGlance(3, THIRD)]);

    await confirmRemove(SECOND);
    await settleMotion(EXIT_BUDGET + 20);
    expect(document.activeElement).toBe(repoOpenButton(THIRD));

    handle.setRepositories([makeGlance(1, FIRST)]);
    await confirmRemove(THIRD);
    await settleMotion(EXIT_BUDGET + 20);
    expect(document.activeElement).toBe(repoOpenButton(FIRST));

    handle.setRepositories([]);
    await confirmRemove(FIRST);
    await settleMotion(EXIT_BUDGET + 20);
    expect(repoRows()).toHaveLength(0);
    expect(document.activeElement).toBe(document.querySelector('.watchlist-add-trigger'));
  });
});

describe('卡片动画 · 减少动态效果', () => {
  it('开启后新增立即落位，无 translate / scale，不等待完整动画预算', async () => {
    setReducedMotion(true);
    await mount();
    await addRepository('vercel/next.js');

    expect(repoMotion('vercel/next.js')).toBe('idle');
    expect(repoSlot('vercel/next.js')?.style.transform).toBe('none');
    await settleMotion(REPO_MOTION.reducedMs + 20);

    expect(repoMotion('vercel/next.js')).toBe('idle');
    expect(repoSlot('vercel/next.js')?.dataset.highlight).toBeUndefined();
  });

  it('开启后删除只有 40ms 淡出，没有 translate / scale，功能不受影响', async () => {
    setReducedMotion(true);
    await mount();
    handle.setRepositories([makeGlance(1, FIRST), makeGlance(3, THIRD)]);

    await confirmRemove(SECOND);
    expect(repoMotion(SECOND)).toBe('exiting');
    expect(repoSlot(SECOND)?.style.transform).toBe('none');

    await settleMotion(REPO_MOTION.reducedMs + 20);
    expect(slotIds()).toEqual(['1', '3']);
    expect(document.activeElement).toBe(repoOpenButton(THIRD));
  });
});
