// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Detail } from '../../src/shared/types';
import type { RenderResult, StubHandle } from './helpers';
import {
  buttonByText, click, createStub, daysAgoIso, makeGlance, makeSnapshot,
  renderApp, repoOpenButton, sectionByTitle, setViewportWidth, settle, tab,
} from './helpers';
import { readRendererStyles } from './support/styles';

// Geometry and actual container reflow are covered by the production browser fixture.
vi.mock('react-chartjs-2', () => import('./chart-stub'));

const repo = makeGlance(1, 'owner/repository');
const issueTitle = 'TypeScript 7 VS Code extension: a workspace configuration ' + 'TechnicalIdentifier'.repeat(12);
const pullTitle = 'Improve workspace compatibility and type inference ' + 'PullRequestIdentifier'.repeat(12);
const author = 'very-long-author-name'.repeat(10);
const tagName = 'release-candidate-very-long-tag-name-' + 'tag'.repeat(80);
const body = 'Body excerpt https://example.com/' + 'long-path'.repeat(50);
const detail: Partial<Detail> = {
  issues: [{ number: 64565, title: issueTitle, authorName: author, body, state: 'open', updatedAt: daysAgoIso(0) }],
  pullRequests: [{ number: 64590, title: pullTitle, authorName: author, body, state: 'closed', updatedAt: daysAgoIso(0) }],
  releases: [{ tagName, title: 'ReleaseTitle'.repeat(30), publishedAt: daysAgoIso(0) }],
  commits: [{ sha: 'a'.repeat(40), message: 'Commit message '.repeat(40), authorName: author, committedAt: daysAgoIso(0) }],
  build: {
    status: 'success', workflowName: 'workflow-name'.repeat(40), conclusion: 'conclusion'.repeat(40),
    finishedAt: daysAgoIso(0), url: 'https://github.com/owner/repository/actions/runs/123',
  },
  trend: [makeSnapshot(daysAgoIso(1), 100, 10), makeSnapshot(daysAgoIso(0), 110, 12)],
};
let view: RenderResult | null = null;
let stub: StubHandle;

afterEach(async () => {
  await view?.unmount();
  view = null;
  setViewportWidth(768);
});

async function mount(width = 900, data = detail): Promise<void> {
  setViewportWidth(width);
  stub = createStub({ repositories: [repo], detail: data });
  view = await renderApp(stub);
  await settle();
  await click(repoOpenButton(repo.fullName));
  await settle();
}

describe('Detail content container ownership', () => {
  it.each([900, 1152, 1366])('%ipx has one content owner outside Header and sticky Tabs', async (width) => {
    await mount(width);
    const content = document.querySelector('.detail-content-responsive')!;
    expect(content.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    expect(content.querySelector('.repository-header')).toBeNull();
    expect(content.querySelector('[role="tablist"]')).toBeNull();
    expect(content.closest('[data-workspace="true"]')).not.toBeNull();
    expect(document.querySelector('.app-shell-sidebar .detail-content-responsive')).toBeNull();
  });

  it('uses one Desktop content query for wide pairs and narrower single columns', () => {
    const css = readRendererStyles();
    expect(css).toMatch(/\.detail-page\[data-workspace='true'\] \.detail-content-responsive\s*\{\s*container: detail-content \/ inline-size;/);
    const queries = [...css.matchAll(/@container detail-content \(max-width: [^)]+\)\s*\{([\s\S]*?)\n\}/g)];
    expect(queries).toHaveLength(1);
    for (const grid of ['detail-overview-updates', 'detail-overview-issues', 'detail-trend-grid']) {
      expect(css).toMatch(new RegExp(grid + '[^}]+grid-template-columns: repeat\\(2, minmax\\(0, 1fr\\)\\)'));
      expect(queries[0]?.[1]).toContain(`.detail-page[data-workspace='true'] .${grid}`);
    }
    expect(queries[0]?.[1]).toContain('grid-template-columns: minmax(0, 1fr)');
  });

  it.each([899, 768, 480])('%ipx preserves Legacy navigation and original column rules', async (width) => {
    await mount(width);
    expect(document.querySelector('[data-workspace="false"] .detail-content-responsive')).not.toBeNull();
    expect(document.querySelector('.app-shell')).toBeNull();
    expect(buttonByText('← 返回监控清单')).not.toBeNull();
    expect(document.querySelector('.detail-overview-issues')?.classList.contains('md:grid-cols-2')).toBe(true);
    expect(document.querySelector('.detail-overview-updates')?.classList.contains('lg:grid-cols-2')).toBe(true);
    expect(document.querySelector('.detail-trend-grid')?.classList.contains('sm:grid-cols-2')).toBe(true);
  });

  it('width changes preserve content identity, selection and fetch count', async () => {
    await mount(900);
    const content = document.querySelector('.detail-content-responsive');
    const panel = content?.querySelector('[role="tabpanel"]');
    for (const width of [1152, 1366, 1000, 900, 899, 900]) {
      await act(async () => setViewportWidth(width));
      await settle();
      expect(document.querySelector('.detail-content-responsive')).toBe(content);
      expect(content?.querySelector('[role="tabpanel"]')).toBe(panel);
      expect(tab('概览')?.getAttribute('aria-selected')).toBe('true');
    }
    expect(stub.calls.fetchDetail).toBe(1);
  });
});

describe('Content readability contracts', () => {
  it('keeps Issues grouped before PRs, with complete titles and metadata in reading order', async () => {
    await mount();
    const section = sectionByTitle('Issue & PR')!;
    const groups = [...section.querySelectorAll('h3')];
    expect(groups.map(h => h.textContent)).toEqual(['最近更新的议题', '最近更新的合并请求']);
    const rows = [...section.querySelectorAll('li')];
    expect(rows).toHaveLength(2);
    for (const [index, row] of rows.entries()) {
      const title = row.querySelector('.detail-numbered-title')!;
      const meta = row.querySelector('.detail-numbered-meta')!;
      expect(title.textContent).toBe(index === 0 ? issueTitle : pullTitle);
      expect(title.className).not.toContain('truncate');
      expect(title.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(meta.children[0]?.textContent).toBe(index === 0 ? '开启' : '已关闭');
      expect(meta.children[1]?.textContent).toBe(author);
      expect(meta.children[2]?.textContent).not.toBe('');
    }
    expect(section.textContent).not.toContain(body);
  });

  it('full Issue & PR Tab retains complete title/body and safe external actions at 900', async () => {
    await mount();
    await click(tab('Issue & PR'));
    const panel = document.querySelector('[role="tabpanel"]')!;
    expect([...panel.querySelectorAll('h3')].map(h => h.textContent)).toEqual(['议题', '合并请求']);
    expect(panel.textContent).toContain(issueTitle);
    expect(panel.textContent).toContain(pullTitle);
    expect(panel.querySelectorAll('p[title]')).toHaveLength(2);
    expect(panel.querySelector('p[title]')?.getAttribute('title')).toBe(body);
    await click(panel.querySelector<HTMLButtonElement>('button[aria-label="在 GitHub 打开议题 #64565"]'));
    expect(stub.externalTargets[0]).toEqual({ kind: 'issue', owner: repo.owner, name: repo.name, number: 64565 });
    expect(stub.calls.fetchDetail).toBe(1);
  });

  it('long technical text can wrap inside content without clipping prose or widening cards', () => {
    const css = readRendererStyles();
    expect(css).toMatch(/\.detail-content-responsive\s*\{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.detail-overview-issues > \*[^}]*min-width: 0;[^}]*max-width: 100%;/);
    expect(css).toMatch(/\.detail-numbered-meta\s*\{[^}]*grid-column: 1 \/ -1;[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.detail-numbered-item > p\s*\{[^}]*grid-column: 1 \/ -1;[^}]*min-width: 0;/);
  });

  it('Overview retains release tags, commit titles, author and SHA at 900', async () => {
    await mount();
    const releases = sectionByTitle('最新发版')!;
    const commits = sectionByTitle('最近提交')!;
    expect(releases.textContent).toContain(tagName);
    expect(releases.textContent).toContain(detail.releases![0]!.title);
    expect(commits.querySelector('[title]')?.getAttribute('title')).toBe(detail.commits![0]!.message);
    expect(commits.textContent).toContain(author);
    expect(commits.textContent).toContain('aaaaaaa');
    await click(releases.querySelector<HTMLButtonElement>('button'));
    expect(stub.externalTargets[0]).toEqual({ kind: 'release', owner: repo.owner, name: repo.name, tagName });
  });

  it('Build keeps full workflow available, conclusion, badge and external action at 900', async () => {
    await mount();
    await click(tab('构建'));
    const build = sectionByTitle('构建')!;
    expect(build.textContent).toContain('构建通过');
    expect(build.querySelector('p[title]')?.getAttribute('title')).toBe(detail.build!.workflowName);
    expect(build.textContent).toContain(detail.build!.conclusion);
    await click(build.querySelector<HTMLButtonElement>('button'));
    expect(stub.externalTargets[0]).toEqual({ kind: 'build', owner: repo.owner, name: repo.name, url: detail.build!.url });
  });

  it('Trend keeps Stars/Forks order and responsive chart/range controls at 900', async () => {
    await mount();
    await click(tab('趋势'));
    const trend = sectionByTitle('趋势')!;
    expect([...trend.querySelectorAll('[data-metric]')].map(el => el.getAttribute('data-metric'))).toEqual(['stars', 'forks']);
    // 只提供有数据支撑的范围：90D 不提供（当前保留期 30 天）
    expect([...trend.querySelectorAll('[role="group"] button')].map(el => el.textContent)).toEqual(['7D', '30D']);
    expect(trend.textContent).toContain('趋势按自然日保留最近 30 天记录。');
    expect(stub.calls.fetchDetail).toBe(1);
  });

  it('empty Issue/PR remains one empty state with no forced empty grid', async () => {
    await mount(900, { issues: [], pullRequests: [] });
    const section = sectionByTitle('Issue & PR')!;
    expect(section.querySelector('.detail-overview-issues')).toBeNull();
    expect(section.textContent?.match(/当前没有开放的 Issue 或 Pull Request/g)).toHaveLength(1);
  });
});
