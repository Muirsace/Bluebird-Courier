// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  buttonByLabel,
  buttonByText,
  click,
  createStub,
  dialog,
  makeGlance,
  menu,
  menuItem,
  navButton,
  openRepo,
  renderApp,
  repoActionsButton,
  repoOpenButton,
  repoRows,
  settle,
  settleMotion,
  settleOverlayClose,
  tab,
} from './helpers';

/**
 * 公共 Button 交互层（styles.css 里的 button / button.transition-colors / data-button-motion）
 * 是纯 CSS，happy-dom 看不到样式；这里固定的是「本轮改动没有动到业务契约」：
 * 禁用、Loading、图标、危险、菜单、Tab、键盘可达性都还是原来的行为。
 * 视觉状态（下压 1px、scale、pressed 颜色）由 .scratch/verify 的浏览器探针与人工验收负责。
 */

let handle: StubHandle;
let view: RenderResult | null = null;

async function mount(options: StubOptions = {}): Promise<void> {
  handle = createStub({ repositories: [makeGlance(1, 'octocat/Hello-World')], ...options });
  view = await renderApp(handle);
  await settle();
}

afterEach(async () => {
  if (view) {
    await view.unmount();
    view = null;
  }
});

describe('公共按钮交互层 · 禁用与 Loading', () => {
  it('禁用按钮：点击不触发业务调用，且保持 disabled', async () => {
    await mount({ repositories: [] });
    const join = document.querySelector<HTMLButtonElement>(
      '.watchlist-add-form .watchlist-add-control-row > .watchlist-add-action',
    );
    if (!join) throw new Error('未找到加入按钮');
    expect(join.disabled).toBe(true);

    await click(join);
    await settle();

    expect(handle.calls.addRepository).toBe(0);
    expect(join.disabled).toBe(true);
  });

  it('Loading 按钮：请求挂起期间禁用且不重复发起，结束后恢复可用', async () => {
    await mount();
    const release = handle.holdNextRefresh();
    const before = { ...handle.calls };

    await click(buttonByText('全部刷新'));
    await settle();
    expect(handle.calls.refreshGlance - before.refreshGlance).toBe(1);
    expect(buttonByText('刷新中…')?.disabled).toBe(true);

    await click(buttonByText('刷新中…'));
    await settle();
    expect(handle.calls.refreshGlance - before.refreshGlance).toBe(1);

    release();
    await settle();
    expect(buttonByText('全部刷新')?.disabled).toBe(false);
  });
});

describe('公共按钮交互层 · 各类按钮行为不变', () => {
  it('图标按钮（···）能打开菜单并触发菜单动作', async () => {
    await mount();
    await click(repoActionsButton('octocat/Hello-World'));
    await settle();
    expect(menu()).not.toBeNull();

    await click(menuItem('在 GitHub 打开'));
    await settle();
    expect(handle.calls.openGitHubExternal).toBe(1);
  });

  it('危险按钮（移除）语义不变：确认一次只调用一次 removeRepository', async () => {
    await mount();
    await click(repoActionsButton('octocat/Hello-World'));
    await settle();
    await click(menuItem('从监控清单移除'));
    await settle();
    expect(dialog()).not.toBeNull();

    handle.setRepositories([]);
    await click(buttonByText('移除'));
    await settle();
    expect(handle.calls.removeRepository).toBe(1);

    await settleMotion();
    expect(repoRows()).toHaveLength(0);
  });

  it('次要按钮：取消关闭 Popover 且不删除', async () => {
    await mount();
    await click(repoActionsButton('octocat/Hello-World'));
    await settle();
    await click(menuItem('从监控清单移除'));
    await settle();

    await click(buttonByText('取消'));
    await settle();
    await settleOverlayClose();

    expect(dialog()).toBeNull();
    expect(handle.calls.removeRepository).toBe(0);
    expect(repoRows()).toHaveLength(1);
  });

  it('设置页主按钮与显示令牌按钮行为不变', async () => {
    await mount();
    await click(navButton('设置'));
    await settle();

    await click(buttonByLabel('显示令牌'));
    await settle();
    const input = document.querySelector<HTMLInputElement>('#accessToken-input');
    expect(input?.type).toBe('text');
    expect(buttonByLabel('隐藏令牌')).not.toBeNull();

    await click(buttonByLabel('隐藏令牌'));
    await settle();
    expect(document.querySelector<HTMLInputElement>('#accessToken-input')?.type).toBe('password');
  });

  it('详情 Tab 是真按钮：点击切换 aria-selected', async () => {
    await mount();
    await openRepo('octocat/Hello-World');
    const releases = tab('发版');
    if (!releases) throw new Error('未找到发版 Tab');
    expect(releases.tagName).toBe('BUTTON');
    expect(releases.type).toBe('button');

    await click(releases);
    await settle();
    expect(releases.getAttribute('aria-selected')).toBe('true');
    expect(tab('概览')?.getAttribute('aria-selected')).toBe('false');
  });
});

describe('公共按钮交互层 · 力度分级', () => {
  /**
   * 设计不变量（不是样式细节）：按下反馈由整张卡片承担（.repo-row:has([data-row-activator]:active)
   * 一次画灰 + 一次下压），主点击区只是触发器。回归时两头都容易坏：公共层重新给它加压会变成
   * 卡里还有一张小卡在下压；标记被删掉则整卡反馈静默消失。
   */
  it('整卡主点击区只做触发器：不进公共按压层，但带着整卡反馈需要的标记', async () => {
    await mount();
    const openButton = repoOpenButton('octocat/Hello-World');
    expect(openButton?.dataset.buttonMotion).toBe('surface');
    expect(openButton?.hasAttribute('data-row-activator')).toBe(true);
  });
});

describe('公共按钮交互层 · 键盘可达性', () => {
  it('可按下控件都是真 button、可聚焦、未退出无障碍路径', async () => {    await mount();
    const controls = [
      buttonByLabel('新增仓库'),
      buttonByText('全部刷新'),
      repoActionsButton('octocat/Hello-World'),
    ];
    for (const control of controls) {
      expect(control).not.toBeNull();
      expect(control?.tagName).toBe('BUTTON');
      expect(control?.type).toBe('button');
      expect(control?.disabled).toBe(false);
      expect(control?.closest('[aria-hidden="true"]')).toBeNull();
      expect(control?.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });
});
