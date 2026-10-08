// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { CommitItem, IssueItem, PullRequestItem, ReleaseItem } from '../../src/shared/types';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  alertTexts,
  bodyText,
  buttonByLabel,
  click,
  createStub,
  makeGlance,
  menu,
  menuItem,
  openRepo,
  pointerDownOutside,
  pressEscape,
  renderApp,
  repoActionsButton,
  repoRows,
  settle,
  settleOverlayClose,
  tab,
} from './helpers';

/**
 * 「在 GitHub 打开」的渲染层契约：控件是真的 button、点它只走一次窄接口、
 * 不进入详情、不触发任何抓取；打开失败就地报错，不假装成功。
 * 主进程的 URL 构造与拒绝矩阵见 tests/main/shell-links.test.ts。
 */

const FULL_NAME = 'octocat/Hello-World';
const OWNER = 'octocat';
const NAME = 'Hello-World';

let handle: StubHandle;
let view: RenderResult | null = null;

async function mount(options: StubOptions = {}): Promise<void> {
  handle = createStub({ repositories: [makeGlance(1, FULL_NAME)], ...options });
  view = await renderApp(handle);
  await settle();
}

async function openMenu(): Promise<void> {
  await click(repoActionsButton(FULL_NAME));
  await settle();
}

async function openDetail(options: StubOptions = {}): Promise<void> {
  await mount(options);
  await openRepo(FULL_NAME);
}

function makeRelease(tagName: string): ReleaseItem {
  return { tagName, title: tagName, publishedAt: '2026-09-24T10:00:00.000Z' };
}

function makeCommit(): CommitItem {
  return {
    sha: '17b4f41f0e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6',
    message: '修正外链',
    authorName: 'Turtle',
    committedAt: '2026-09-26T09:00:00.000Z',
  };
}

function makeIssue(number: number): IssueItem {
  return { number, title: `议题 ${number}`, body: null, state: 'open', authorName: 'Turtle', updatedAt: '2026-09-26T09:00:00.000Z' };
}

function makePull(number: number): PullRequestItem {
  return { number, title: `PR ${number}`, body: null, state: 'open', authorName: 'Turtle', updatedAt: '2026-09-26T09:00:00.000Z' };
}

afterEach(async () => {
  if (view) {
    await view.unmount();
    view = null;
  }
});

describe('监控清单 · 在 GitHub 打开', () => {
  it('菜单里「在 GitHub 打开」在前，「从监控清单移除」在后，中间有分隔', async () => {
    await mount();
    await openMenu();

    const items = [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((item) =>
      item.textContent?.trim(),
    );
    expect(items).toEqual(['在 GitHub 打开', '从监控清单移除']);
    expect(menu()?.querySelector('[role="separator"]')).not.toBeNull();
    // 菜单项与按钮一样是真 button，键盘可达
    expect(menuItem('在 GitHub 打开')?.tagName).toBe('BUTTON');
  });

  it('点菜单外链：只调一次窄接口，目标是仓库本身，菜单收起且不进入详情', async () => {
    await mount();
    await openMenu();

    await click(buttonByLabel(`在 GitHub 打开 ${FULL_NAME}`));
    await settle();
    await settleOverlayClose();

    expect(handle.calls.openGitHubExternal).toBe(1);
    expect(handle.externalTargets).toEqual([{ kind: 'repository', owner: OWNER, name: NAME }]);
    expect(menu()).toBeNull();
    expect(repoRows()).toHaveLength(1);
    expect(handle.calls.fetchDetail).toBe(0);
  });

  it('打开失败：菜单留着、就地报错、仓库还在，重试会再调一次', async () => {
    await mount({ openExternalResult: { ok: false, reason: 'open_failed' } });
    await openMenu();

    await click(buttonByLabel(`在 GitHub 打开 ${FULL_NAME}`));
    await settle();

    expect(menu()).not.toBeNull();
    expect(alertTexts().join(' ')).toContain('无法打开系统浏览器');
    expect(repoRows()).toHaveLength(1);
    expect(handle.calls.fetchDetail).toBe(0);

    await click(buttonByLabel(`在 GitHub 打开 ${FULL_NAME}`));
    await settle();
    expect(handle.calls.openGitHubExternal).toBe(2);
  });

  it('主进程拒绝非法目标时，界面上说清是"被阻止打开"', async () => {
    await mount({ openExternalResult: { ok: false, reason: 'invalid_target' } });
    await openMenu();

    await click(buttonByLabel(`在 GitHub 打开 ${FULL_NAME}`));
    await settle();

    expect(alertTexts().join(' ')).toContain('链接目标不合法，已阻止打开');
    expect(handle.calls.removeRepository).toBe(0);
  });

  it('调用期间菜单不会被打掉：失败的原因必须有机会显示出来', async () => {
    await mount({ openExternalResult: { ok: false, reason: 'open_failed' } });
    await openMenu();
    const release = handle.holdNextExternalLink();

    await click(buttonByLabel(`在 GitHub 打开 ${FULL_NAME}`));
    await settle();
    await pointerDownOutside(document.body);
    await pressEscape();
    expect(menu()).not.toBeNull();

    release();
    await settle();
    expect(menu()).not.toBeNull();
    expect(alertTexts().join(' ')).toContain('无法打开系统浏览器');
  });
});

describe('详情页 · 在 GitHub 打开', () => {
  it('表头：按钮有无障碍名，点击只调窄接口并保持不重新抓取', async () => {
    await openDetail();

    const button = buttonByLabel(`在 GitHub 打开 ${FULL_NAME}`);
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('在 GitHub 打开');

    await click(button);
    await settle();

    expect(handle.externalTargets).toEqual([{ kind: 'repository', owner: OWNER, name: NAME }]);
    // 详情只抓过一次：点外链不再产生任何 GitHub 请求
    expect(handle.calls.fetchDetail).toBe(1);
  });

  it('发版 Tag 可点，目标带上 tag', async () => {
    await openDetail({ detail: { releases: [makeRelease('dsh-v0.1.7-rc.2')] } });
    await click(tab('发版'));
    await settle();

    await click(buttonByLabel('在 GitHub 打开发版 dsh-v0.1.7-rc.2'));
    await settle();

    expect(handle.externalTargets).toEqual([
      { kind: 'release', owner: OWNER, name: NAME, tagName: 'dsh-v0.1.7-rc.2' },
    ]);
  });

  it('提交 SHA 可点，目标带完整 SHA（按钮上仍只显示 7 位）', async () => {
    await openDetail({ detail: { commits: [makeCommit()] } });
    await click(tab('提交'));
    await settle();

    const button = buttonByLabel('在 GitHub 打开提交 17b4f41');
    expect(button?.textContent?.trim()).toBe('17b4f41');

    await click(button);
    await settle();

    expect(handle.externalTargets).toEqual([
      { kind: 'commit', owner: OWNER, name: NAME, sha: '17b4f41f0e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6' },
    ]);
  });

  it('议题与合并请求按各自路径打开，无障碍名区分类型', async () => {
    await openDetail({ detail: { issues: [makeIssue(3)], pullRequests: [makePull(7)] } });
    await click(tab('Issue & PR'));
    await settle();

    await click(buttonByLabel('在 GitHub 打开议题 #3'));
    await settle();
    await click(buttonByLabel('在 GitHub 打开合并请求 #7'));
    await settle();

    expect(handle.externalTargets).toEqual([
      { kind: 'issue', owner: OWNER, name: NAME, number: 3 },
      { kind: 'pull', owner: OWNER, name: NAME, number: 7 },
    ]);
  });

  it('构建：有 Actions 地址时给外链，没有则不出现', async () => {
    await openDetail({
      detail: {
        build: {
          status: 'success',
          conclusion: 'success',
          workflowName: 'CI',
          url: 'https://github.com/octocat/Hello-World/actions/runs/123',
          finishedAt: '2026-09-26T09:00:00.000Z',
        },
      },
    });
    await click(tab('构建'));
    await settle();

    await click(buttonByLabel('在 GitHub 打开这次构建'));
    await settle();

    expect(handle.externalTargets).toEqual([
      { kind: 'build', owner: OWNER, name: NAME, url: 'https://github.com/octocat/Hello-World/actions/runs/123' },
    ]);

    await view?.unmount();
    view = null;
    await openDetail({ detail: { build: { status: 'none', conclusion: null, workflowName: null, url: null, finishedAt: null } } });
    await click(tab('构建'));
    await settle();
    expect(buttonByLabel('在 GitHub 打开这次构建')).toBeNull();
    expect(bodyText()).toContain('无构建');
  });

  it('详情页外链打开失败时也就地报错，不打断详情', async () => {
    await openDetail({ openExternalResult: { ok: false, reason: 'open_failed' } });

    await click(buttonByLabel(`在 GitHub 打开 ${FULL_NAME}`));
    await settle();

    expect(alertTexts().join(' ')).toContain('无法打开系统浏览器');
    expect(bodyText()).toContain('概览');
    expect(handle.calls.fetchDetail).toBe(1);
  });

  it('外链控件都是真 button（不是可点的 div/span）', async () => {
    await openDetail({ detail: { releases: [makeRelease('v1.0.0')], commits: [makeCommit()] } });

    expect(buttonByLabel(`在 GitHub 打开 ${FULL_NAME}`)?.tagName).toBe('BUTTON');
    expect(buttonByLabel('在 GitHub 打开发版 v1.0.0')?.tagName).toBe('BUTTON');
    expect(buttonByLabel('在 GitHub 打开提交 17b4f41')?.tagName).toBe('BUTTON');
  });
});
