// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommitItem, IssueItem, PullRequestItem, ReleaseItem } from '../../src/shared/types';
import { classifyReleaseTag, dedupeReleaseTitle } from '../../src/renderer/lib/release';
import { CommitTab } from '../../src/renderer/components/detail/CommitTab';
import { CommitList } from '../../src/renderer/components/detail/CommitList';
import { DetailTabs } from '../../src/renderer/components/detail/DetailTabs';
import type { DetailTabId } from '../../src/renderer/components/detail/DetailTabs';
import { IssuesAndPulls } from '../../src/renderer/components/detail/IssuesAndPulls';
import { IssuesTab } from '../../src/renderer/components/detail/IssuesTab';
import { OverviewTab } from '../../src/renderer/components/detail/OverviewTab';
import { ReleaseList } from '../../src/renderer/components/detail/ReleaseList';
import { ReleaseTab } from '../../src/renderer/components/detail/ReleaseTab';
import type { RenderResult, StubHandle } from './helpers';
import {
  daysAgoIso,
  listRows,
  makeDetail,
  makeGlance,
  renderNode,
  sectionByTitle,
  settle,
} from './helpers';
import { createStub } from './helpers';

let view: RenderResult | null = null;
let handle: StubHandle;

/** 列表组件都要 owner/name 才能拼外链目标。 */
const REPO = { owner: 'octocat', name: 'Hello-World' };

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
});

async function render(node: Parameters<typeof renderNode>[1]): Promise<HTMLElement> {
  if (view) {
    await view.unmount();
    view = null;
  }
  handle = createStub();
  view = await renderNode(handle, node);
  await settle();
  return view.container;
}

function rowAt(index: number): HTMLElement {
  const row = listRows()[index];
  if (!row) throw new Error(`第 ${index} 行不存在`);
  return row;
}

function makeRelease(tagName: string, title = tagName, publishedAt = '2026-09-24T10:00:00.000Z'): ReleaseItem {
  return { tagName, title, publishedAt };
}

function makeCommit(index: number, message?: string): CommitItem {
  return {
    sha: `${index}7b4f4${index}f0e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6`.slice(0, 40),
    message: message ?? `第 ${index} 条提交`,
    authorName: 'Turtle',
    committedAt: daysAgoIso(index % 5, 9),
  };
}

function makeIssue(number: number, state: 'open' | 'closed' = 'open'): IssueItem {
  return { number, title: `议题 ${number}`, body: `议题 ${number} 的正文`, state, authorName: 'octocat', updatedAt: daysAgoIso(1, 9) };
}

function makePull(number: number, state: 'open' | 'closed' = 'open'): PullRequestItem {
  return { number, title: `合并请求 ${number}`, body: `合并请求 ${number} 的正文`, state, authorName: 'hubot', updatedAt: daysAgoIso(2, 9) };
}

// ---------- 纯函数：tag 分类必须保守 ----------

describe('发版分类 · classifyReleaseTag', () => {
  it('明确的 rc / beta / alpha 标记才识别', () => {
    expect(classifyReleaseTag('dsh-v0.1.7-rc.2')).toBe('rc');
    expect(classifyReleaseTag('v2.0.0-rc1')).toBe('rc');
    expect(classifyReleaseTag('v1.0.0-beta')).toBe('beta');
    expect(classifyReleaseTag('1.0.0-beta2')).toBe('beta');
    expect(classifyReleaseTag('v0.1.7-alpha')).toBe('alpha');
    expect(classifyReleaseTag('0.9.0-alpha.3')).toBe('alpha');
  });

  it('没有明确预发布标记时一律不分类：不猜 Stable，也不把 nightly 当预发布', () => {
    for (const tag of ['v1.2.3', 'nightly-2026-09-27', 'snapshot', 'canary', 'dev-build-7', '']) {
      expect(classifyReleaseTag(tag)).toBeNull();
    }
    expect(classifyReleaseTag(null)).toBeNull();
  });

  it('标题与 tag 相同时不重复展示', () => {
    expect(dedupeReleaseTitle('v1.0.0', 'v1.0.0')).toBeNull();
    expect(dedupeReleaseTitle('V1.0.0', 'v1.0.0')).toBeNull();
    expect(dedupeReleaseTitle('  ', 'v1.0.0')).toBeNull();
    expect(dedupeReleaseTitle('正式发布', 'v1.0.0')).toBe('正式发布');
  });
});

// ---------- 发版列表 ----------

describe('发版列表 · 类型与层级', () => {
  it('rc / alpha / beta 各自带文字徽章', async () => {
    await render(
      <ReleaseList
        releases={[
          makeRelease('dsh-v0.1.7-rc.2', '预发布 2'),
          makeRelease('dsh-v0.1.7-alpha.1', '内测 1'),
          makeRelease('dsh-v0.1.7-beta.1', '公测 1'),
        ]}
        owner={REPO.owner}
        name={REPO.name}
      />,
    );

    const rows = listRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('RC');
    expect(rows[1]?.textContent).toContain('Alpha');
    expect(rows[2]?.textContent).toContain('Beta');
  });

  it('不确定的 tag 不显示任何类型徽章，也绝不出现 Stable', async () => {
    await render(
      <ReleaseList
        releases={[makeRelease('v1.2.3', '正式版'), makeRelease('nightly-2026-09-27', '')]}
        owner={REPO.owner}
        name={REPO.name}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Stable');
    expect(text).not.toContain('RC');
    expect(text).not.toContain('Alpha');
    expect(text).not.toContain('Beta');
    expect(listRows()).toHaveLength(2);
  });

  it('标题与 tag 相同时 tag 只出现一次；层级是 Tag → 日期 → 标题', async () => {
    await render(
      <ReleaseList
        releases={[makeRelease('dsh-v0.1.7-rc.2', 'dsh-v0.1.7-rc.2'), makeRelease('v1.2.3', '正式版')]}
        owner={REPO.owner}
        name={REPO.name}
      />,
    );

    const [sameTag, differentTitle] = listRows();
    expect(sameTag?.textContent?.split('dsh-v0.1.7-rc.2')).toHaveLength(2);
    expect(sameTag?.textContent).toContain('2026-09-24');
    expect(sameTag?.children).toHaveLength(1); // 没有第二行的标题

    expect(differentTitle?.children).toHaveLength(2);
    expect(differentTitle?.children[1]?.textContent).toBe('正式版');
  });

  it('无发版时给紧凑空态', async () => {
    await render(<ReleaseTab releases={[]} owner={REPO.owner} name={REPO.name} />);

    expect(document.body.textContent).toContain('无发版');
    expect(listRows()).toHaveLength(0);
  });
});

// ---------- 提交列表 ----------

describe('提交列表 · 信息层级', () => {
  it('消息是第一视觉层：一行截断并保留完整文本', async () => {
    const long = 'Merge pull request #5180 from deepseek-ai/fix-token-refresh-race-condition-and-retry';
    await render(<CommitList commits={[makeCommit(1, long)]} owner={REPO.owner} name={REPO.name} />);

    const row = rowAt(0);
    const message = row.children[0] as HTMLElement;
    expect(message.textContent).toBe(long);
    expect(message.getAttribute('title')).toBe(long);
    expect(message.className).toContain('truncate');
    expect(message.className).toContain('text-primary');
    expect(row.firstElementChild?.tagName).toBe('DIV');
  });

  it('SHA 是次要信息：等宽弱色、排在作者与时间之后', async () => {
    await render(<CommitList commits={[makeCommit(1)]} owner={REPO.owner} name={REPO.name} />);

    const row = rowAt(0);
    const sha = [...row.querySelectorAll<HTMLElement>('button')].find((button) =>
      /^[0-9a-f]{7}$/.test(button.textContent ?? ''),
    );
    expect(sha).toBeDefined();
    expect(sha?.className).toContain('font-mono');
    expect(sha?.className).toContain('text-muted');
    // 可点开 GitHub 上的该次提交
    expect(sha?.getAttribute('aria-label')).toBe('在 GitHub 打开提交 17b4f41');

    const meta = row.children[1] as HTMLElement;
    expect(meta.textContent).toContain('Turtle');
    expect(meta.textContent?.indexOf('Turtle')).toBeLessThan(
      meta.textContent?.indexOf(sha?.textContent ?? '') ?? -1,
    );
  });

  it('概览只显示摘要条数，完整 Tab 保留全部数据', async () => {
    const commits = Array.from({ length: 12 }, (_, index) => makeCommit(index + 1));

    await render(<OverviewTab detail={makeDetail(makeGlance(1, 'octocat/Hello-World'), { commits })} />);
    const summary = sectionByTitle('最近提交');
    expect(summary).not.toBeNull();
    expect(listRows(summary as HTMLElement)).toHaveLength(5);
    expect(summary?.textContent).toContain('已抓取 12 条');

    await render(<CommitTab commits={commits} owner={REPO.owner} name={REPO.name} />);
    expect(listRows()).toHaveLength(12);
    expect(document.body.textContent).toContain('已抓取 12 条');

    await render(<CommitTab commits={[]} owner={REPO.owner} name={REPO.name} />);
    expect(document.body.textContent).toContain('无提交');
  });
});

// ---------- 议题与合并请求 ----------

describe('议题与合并请求 · 有数据与无数据', () => {
  it('两者都为空时只有一行紧凑空态，不摆两个空区块', async () => {
    await render(<IssuesTab issues={[]} pullRequests={[]} owner={REPO.owner} name={REPO.name} />);

    expect(document.body.textContent).toContain('✓ 当前没有开放的 Issue 或 Pull Request');
    expect(document.body.textContent).not.toContain('无议题');
    expect(document.body.textContent).not.toContain('无合并请求');
    expect(listRows()).toHaveLength(0);
  });

  it('有数据时先给计数摘要，再分区展示', async () => {
    await render(
      <IssuesAndPulls
        issues={[makeIssue(1), makeIssue(2)]}
        pullRequests={[makePull(3)]}
        owner={REPO.owner}
        name={REPO.name}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toContain('议题');
    expect(text).toContain('2 条');
    expect(text).toContain('合并请求');
    expect(text).toContain('1 条');
    expect(listRows()).toHaveLength(3);
  });

  it('展示 GitHub 返回的 Issue / PR 正文', async () => {
    await render(
      <IssuesAndPulls
        issues={[{ ...makeIssue(1), body: 'Issue 正文内容' }]}
        pullRequests={[{ ...makePull(2), body: 'PR 正文内容' }]}
        owner={REPO.owner}
        name={REPO.name}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toContain('Issue 正文内容');
    expect(text).toContain('PR 正文内容');
  });

  it('类型用文字区分，不只靠颜色', async () => {
    await render(
      <IssuesAndPulls
        issues={[makeIssue(1)]}
        pullRequests={[makePull(2, 'closed')]}
        owner={REPO.owner}
        name={REPO.name}
      />,
    );

    const issueRow = rowAt(0);
    const pullRow = rowAt(1);
    expect(issueRow.firstElementChild?.textContent).toBe('Issue');
    expect(pullRow.firstElementChild?.textContent).toBe('PR');
    // 状态同样是文字
    expect(issueRow.textContent).toContain('开启');
    expect(pullRow.textContent).toContain('已关闭');
  });
});

describe('详情页 Tab 键盘交互', () => {
  it('方向键循环切换，Home / End 到首尾并保留焦点', async () => {
    const changes: DetailTabId[] = [];
    await render(<DetailTabs active="overview" onChange={(id) => changes.push(id)} />);

    const pressOnTab = async (id: DetailTabId, key: string): Promise<void> => {
      const button = document.querySelector<HTMLButtonElement>(`#detail-tab-${id}`);
      if (!button) throw new Error(`Tab ${id} 未渲染`);
      await act(async () => {
        button.focus();
        button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    };

    await pressOnTab('overview', 'ArrowRight');
    expect(document.activeElement?.id).toBe('detail-tab-releases');
    await pressOnTab('releases', 'End');
    expect(document.activeElement?.id).toBe('detail-tab-trend');
    await pressOnTab('trend', 'Home');
    expect(document.activeElement?.id).toBe('detail-tab-overview');
    await pressOnTab('overview', 'ArrowLeft');
    expect(document.activeElement?.id).toBe('detail-tab-trend');
    expect(changes).toEqual(['releases', 'trend', 'overview', 'trend']);
  });
});
