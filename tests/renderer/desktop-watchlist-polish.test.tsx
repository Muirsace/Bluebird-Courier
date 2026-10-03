// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RenderResult, StubHandle } from './helpers';
import {
  click, createStub, makeGlance, menu, menuItem, openAddInput, openRepositoryActions,
  renderApp, repoActionsButton, repoOpenButton, setViewportWidth, settle, typeInto,
} from './helpers';

let view: RenderResult | null = null;
let stub: StubHandle;
const fullName = 'very-long-organization-name-for-layout-testing/extremely-long-bluebird-courier-repository-name-for-desktop-layout';
const repo = makeGlance(1, fullName);
const other = makeGlance(2, 'owner/another-repository');

afterEach(async () => {
  await view?.unmount();
  view = null;
  setViewportWidth(768);
});

async function mount(width: number): Promise<void> {
  setViewportWidth(width);
  stub = createStub({ repositories: [repo, other] });
  view = await renderApp(stub);
  await settle();
}

describe('Desktop Watchlist static polish', () => {
  it.each([900, 1180])('%ipx exposes Desktop row and tools markers with the existing accessible controls', async width => {
    await mount(width);
    expect(document.querySelectorAll('.desktop-watchlist-view .desktop-repository-row')).toHaveLength(2);
    expect(document.querySelectorAll('.desktop-watchlist-heading')).toHaveLength(1);
    expect(document.querySelector('.desktop-watchlist-heading h2')?.textContent).toBe('监控清单');
    expect(document.querySelector('.desktop-watchlist-title .watchlist-count')?.getAttribute('aria-label')).toBe('2 个仓库');
    expect(document.querySelector('.sidebar-refresh')?.getAttribute('aria-label')).toBe('全部刷新');
    expect(document.querySelector('.sidebar-refresh')?.getAttribute('title')).toBe('全部刷新');
    expect(repoActionsButton(fullName)).toBeNull();
  });

  it('keeps Narrow cards, heading and explicit menu entry free of Desktop markers', async () => {
    await mount(899);
    expect(document.querySelector('.desktop-repository-row, .desktop-watchlist-heading')).toBeNull();
    expect(document.querySelectorAll('.narrow-watchlist-view .repo-row')).toHaveLength(2);
    expect(document.querySelector('.watchlist-page-heading h1')?.textContent).toBe('监控清单');
    expect(repoActionsButton(fullName)).not.toBeNull();
    expect(repoOpenButton(fullName)?.hasAttribute('aria-pressed')).toBe(false);
  });

  it('keeps full long identity, owner, release and activity without shortening navigation data', async () => {
    await mount(900);
    const button = repoOpenButton(fullName)!;
    expect(button.getAttribute('aria-label')).toBe('查看 ' + fullName + ' 详情');
    expect(button.title).toBe(fullName);
    expect(button.querySelector('.repository-sidebar-name')?.textContent).toBe(repo.name);
    expect(button.querySelector('.repository-sidebar-owner')?.textContent).toBe(repo.owner);
    expect(button.querySelector('.repository-sidebar-owner')?.getAttribute('title')).toBe(repo.owner);
    expect(button.querySelector('.repository-sidebar-release')?.textContent).toBe(repo.latestReleaseTag);
    expect(button.querySelector('.repository-sidebar-activity')?.getAttribute('aria-label')).toContain('最近活动');
    await click(button);
    await settle();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.closest('.desktop-repository-row')?.getAttribute('data-selected')).toBe('true');
    expect(document.querySelector('.repository-header-name')?.getAttribute('aria-label')).toBe(fullName);
  });

  it('right-clicking an unselected row retains selection and uses the original shared action target', async () => {
    await mount(900);
    await click(repoOpenButton(fullName));
    await settle();
    const requests = { ...stub.calls };
    await openRepositoryActions(other.fullName);
    expect(menu()).not.toBeNull();
    expect(repoOpenButton(fullName)?.getAttribute('aria-pressed')).toBe('true');
    expect(repoOpenButton(other.fullName)?.getAttribute('aria-pressed')).toBe('false');
    expect(stub.calls).toEqual(requests);
    await click(menuItem('在 GitHub 打开'));
    await settle();
    expect(stub.externalTargets).toEqual([{ kind: 'repository', owner: other.owner, name: other.name }]);
    expect(stub.calls.fetchDetail).toBe(requests.fetchDetail);
  });

  it('five resize cycles preserve input, feedback, selected identity and business request counts', async () => {
    await mount(900);
    const input = await openAddInput();
    await typeInto(input, fullName);
    await click(repoOpenButton(fullName));
    await settle();
    const requests = { ...stub.calls };
    for (const width of Array.from({ length: 5 }, () => [899, 900, 899]).flat()) {
      await act(async () => setViewportWidth(width));
      await settle();
      expect(input.value).toBe(fullName);
      expect(document.querySelector('.repository-header-name')?.getAttribute('aria-label')).toBe(fullName);
      if (width >= 900) {
        expect(repoOpenButton(fullName)?.getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('#add-repository-duplicate')?.textContent).toContain('已在监控清单中');
      }
      expect(stub.calls).toEqual(requests);
    }
  });
});
