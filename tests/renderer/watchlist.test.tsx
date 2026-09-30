// @vitest-environment happy-dom
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddRepositoryForm } from '../../src/renderer/components/watchlist/AddRepositoryForm';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  alertTexts,
  bodyText,
  buttonByLabel,
  buttonByText,
  click,
  createStub,
  makeGlance,
  pressEscape,
  renderApp,
  renderNode,
  repoOpenButton,
  repoRows,
  settle,
  submitForm,
  typeInto,
} from './helpers';

let handle: StubHandle;
let view: RenderResult | null = null;

async function mount(options: StubOptions = {}): Promise<void> {
  handle = createStub(options);
  view = await renderApp(handle);
  await settle();
}

afterEach(async () => {
  if (view) {
    await view.unmount();
    view = null;
  }
});

function addInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[aria-label^="监控仓库"]');
  if (!input) throw new Error('未找到添加仓库输入框');
  return input;
}

function addSubmitButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    '.watchlist-add-form .watchlist-add-control-row > .watchlist-add-action',
  );
  if (!button) throw new Error('未找到加入仓库按钮');
  return button;
}

function addStatus(): HTMLElement | null {
  const status = document.querySelector<HTMLElement>('.watchlist-add-form [role="status"]');
  return status?.closest('[aria-hidden="true"]') ? null : status;
}

function addError(): HTMLElement | null {
  const error = document.querySelector<HTMLElement>('.watchlist-add-form [role="alert"]');
  return error?.closest('[aria-hidden="true"]') ? null : error;
}

function activeAddButtonLabel(): string {
  return addSubmitButton().querySelector('.watchlist-add-action-label > span')?.textContent?.trim() ?? '';
}

async function pointerDown(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
}

async function expandAddForm(): Promise<HTMLInputElement> {
  await click(buttonByLabel('新增仓库'));
  await settle();
  return addInput();
}

describe('监控清单 · 数量与状态', () => {
  it('仓库数量显示为当前列表真实数量', async () => {
    await mount({ repositories: [makeGlance(1, 'octocat/Hello-World')] });
    expect(bodyText()).toContain('1 个仓库');
    expect(repoRows()).toHaveLength(1);

    await view?.unmount();
    view = null;

    await mount({
      repositories: [makeGlance(1, 'a/one'), makeGlance(2, 'b/two'), makeGlance(3, 'c/three')],
    });
    expect(bodyText()).toContain('3 个仓库');
    expect(repoRows()).toHaveLength(3);
  });

  it('首次读取尚未返回：显示加载中，不显示空态', async () => {
    handle = createStub({ repositories: [] });
    const release = handle.holdNextList();
    view = await renderApp(handle);
    await settle();

    expect(bodyText()).toContain('正在加载监控清单');
    expect(bodyText()).not.toContain('还没有监控仓库');
    expect(bodyText()).not.toContain('个仓库');

    release();
    await settle();
    expect(bodyText()).toContain('还没有监控仓库');
  });

  it('读取成功但清单为 0：显示空态与 0 个仓库', async () => {
    await mount({ repositories: [] });
    expect(bodyText()).toContain('还没有监控仓库');
    expect(bodyText()).toContain('0 个仓库');
    expect(repoRows()).toHaveLength(0);
  });

  it('读取失败且无缓存：只显示错误条，绝不显示空态', async () => {
    await mount({ listFailFrom: 1 });
    expect(alertTexts().join(' ')).toContain('监控清单加载失败');
    expect(bodyText()).not.toContain('还没有监控仓库');
    expect(repoRows()).toHaveLength(0);
  });
});

describe('监控清单 · 全部刷新', () => {
  it('刷新期间卡片保持可读，只有按钮与行内文案提示正在更新', async () => {
    await mount({ repositories: [makeGlance(1, 'octocat/Hello-World'), makeGlance(2, 'facebook/react')] });
    const before = { ...handle.calls };
    const release = handle.holdNextRefresh();

    await click(buttonByText('全部刷新'));
    await settle();

    expect(handle.calls.refreshGlance - before.refreshGlance).toBe(1);
    expect(buttonByText('刷新中…')).not.toBeNull();
    expect(bodyText()).toContain('正在更新…');
    expect(repoRows()).toHaveLength(2);
    expect(bodyText()).not.toContain('还没有监控仓库');

    release();
    await settle();
    expect(buttonByText('全部刷新')).not.toBeNull();
    expect(bodyText()).not.toContain('正在更新…');
    expect(repoRows()).toHaveLength(2);
  });

  it('点击全部刷新只触发一次 refreshGlance（刷新中再点无效）', async () => {
    await mount({ repositories: [makeGlance(1, 'octocat/Hello-World')] });
    const before = { ...handle.calls };
    const release = handle.holdNextRefresh();

    await click(buttonByText('全部刷新'));
    await settle();
    await click(buttonByText('刷新中…'));
    await settle();

    expect(handle.calls.refreshGlance - before.refreshGlance).toBe(1);

    release();
    await settle();
  });

  it('刷新失败：缓存清单继续显示，只多一条错误条', async () => {
    await mount({ repositories: [makeGlance(1, 'octocat/Hello-World')], refreshGlanceFails: true });

    await click(buttonByText('全部刷新'));
    await settle();

    expect(alertTexts().join(' ')).toContain('抓取失败');
    expect(repoRows()).toHaveLength(1);
    expect(bodyText()).toContain('octocat/Hello-World');
    expect(bodyText()).not.toContain('还没有监控仓库');
  });
});

describe('监控清单 · 打开详情', () => {
  it('点击卡片主区域进入详情，且只抓取一次全量信息', async () => {
    await mount({ repositories: [makeGlance(1, 'octocat/Hello-World')] });

    await click(repoOpenButton('octocat/Hello-World'));
    await settle();

    expect(handle.calls.fetchDetail).toBe(1);
    expect(bodyText()).toContain('octocat/Hello-World');
    expect(bodyText()).toContain('概览');
  });

  it('主区域是真正的 button，且内部没有嵌套交互元素', async () => {
    await mount({ repositories: [makeGlance(1, 'octocat/Hello-World')] });
    const open = repoOpenButton('octocat/Hello-World');

    expect(open?.tagName).toBe('BUTTON');
    expect(open?.getAttribute('type')).toBe('button');
    expect(open?.querySelector('button, a, [role="button"], input')).toBeNull();
    // ··· 与主区域平级（同一容器内的兄弟节点），不是被嵌套进去的
    expect(open?.parentElement?.querySelector('button[aria-label$="的仓库操作"]')).not.toBeNull();
  });
});

describe('监控清单 · 添加仓库', () => {
  it('默认折叠：只显示新增仓库和全部刷新操作', async () => {
    await mount({ repositories: [] });
    expect(buttonByLabel('新增仓库')).not.toBeNull();
    expect(buttonByText('全部刷新')).not.toBeNull();
    expect(addSubmitButton().getAttribute('aria-hidden')).toBe('true');
  });

  it('折叠时保留动画 DOM，但 input 被禁用并退出 Tab 与读屏操作路径', async () => {
    await mount({ repositories: [] });
    const input = addInput();
    expect(input.disabled).toBe(true);
    expect(input.tabIndex).toBe(-1);
    expect(input.parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(addSubmitButton().disabled).toBe(true);
    expect(addSubmitButton().type).toBe('button');
    expect(addSubmitButton().tabIndex).toBe(-1);
  });

  it('新增仓库入口是真实 button，点击后展开表单', async () => {
    await mount({ repositories: [] });
    const trigger = buttonByLabel('新增仓库');
    expect(trigger?.tagName).toBe('BUTTON');
    expect(trigger?.type).toBe('button');
    await click(trigger);
    expect(addInput().form).not.toBeNull();
    expect(addSubmitButton()).not.toBe(trigger);
    expect(addSubmitButton().getAttribute('aria-hidden')).toBe('false');
    expect(addSubmitButton().disabled).toBe(true);
  });

  it('标题、单一工具栏和仓库列表共用页面内容容器，折叠和展开从添加区域起点开始', async () => {
    await mount({ repositories: [makeGlance(1, 'octocat/Hello-World')] });
    const page = document.querySelector('.watchlist-page');
    const addArea = document.querySelector('.watchlist-add-form');
    const toolbar = document.querySelector('.watchlist-page-toolbar');
    expect(page?.querySelector('.watchlist-page-heading h1')?.textContent).toBe('监控清单');
    expect(page?.firstElementChild?.contains(addArea)).toBe(false);
    expect(toolbar?.contains(addArea)).toBe(true);
    expect(addArea?.contains(buttonByLabel('新增仓库'))).toBe(true);
    expect(document.querySelectorAll('.watchlist-page-toolbar')).toHaveLength(1);
    expect(document.querySelectorAll('.watchlist-add-form')).toHaveLength(1);
    const toolbarBeforeExpand = toolbar;
    const addAreaBeforeExpand = addArea;
    const input = await expandAddForm();
    expect(toolbarBeforeExpand).toBe(document.querySelector('.watchlist-page-toolbar'));
    expect(addAreaBeforeExpand).toBe(document.querySelector('.watchlist-add-form'));
    expect(toolbar?.contains(input.form)).toBe(true);
    expect(input.parentElement).toBe(input.form?.querySelector('.watchlist-add-field'));
    expect(input.parentElement?.parentElement).toBe(input.form?.firstElementChild);
    expect(addSubmitButton().parentElement).toBe(input.form?.firstElementChild);
  });

  it('展开后 input 自动获得焦点', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    expect(document.activeElement).toBe(input);
  });

  it('Escape 收起表单并把焦点交还新增入口', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    await pressEscape();
    await settle();
    expect(input.disabled).toBe(true);
    expect(input.tabIndex).toBe(-1);
    expect(input.parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(buttonByLabel('新增仓库'));
    await expandAddForm();
    expect(addInput().value).toBe('');
  });

  it('展开空输入时显示禁用的加入按钮并预留操作列', async () => {
    await mount({ repositories: [] });
    await expandAddForm();
    const action = addSubmitButton();
    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-hidden')).toBe('false');
    expect(action.tabIndex).toBe(0);
    expect(activeAddButtonLabel()).toBe('加入');
    expect(document.querySelector('.watchlist-add-form .add-repository-status')).toBeNull();

    await typeInto(addInput(), 'facebook/react');
    expect(addSubmitButton()).toBe(action);
    expect(action.disabled).toBe(false);
    expect(activeAddButtonLabel()).toBe('加入');
  });

  it('有效 owner/repo 和 GitHub URL 输入可提交', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'https://github.com/facebook/react.git');
    expect(addSubmitButton().disabled).toBe(false);
    expect(addSubmitButton().getAttribute('aria-hidden')).toBe('false');
    expect(document.querySelector('.watchlist-add-form .add-repository-status')).toBeNull();
  });

  it('本地识别重复仓库：已添加可切到清除，修改输入后恢复加入', async () => {
    await mount({ repositories: [makeGlance(1, 'deepseek-ai/deepseek-harness')] });
    const listCalls = handle.calls.listRepositories;
    const input = await expandAddForm();
    await typeInto(input, 'https://github.com/DeepSeek-AI/DeepSeek-Harness.git');
    expect(activeAddButtonLabel()).toBe('已添加');
    expect(addSubmitButton().disabled).toBe(false);
    expect(addSubmitButton().type).toBe('button');
    expect(addStatus()).not.toBeNull();
    expect(input.value).toBe('https://github.com/DeepSeek-AI/DeepSeek-Harness.git');
    await click(addSubmitButton());
    expect(activeAddButtonLabel()).toBe('清除');
    expect(addStatus()?.textContent).toContain('打开详情');
    await typeInto(input, 'facebook/react');
    expect(addStatus()).toBeNull();
    expect(activeAddButtonLabel()).toBe('加入');
    expect(addSubmitButton().disabled).toBe(false);
    expect(handle.calls.addRepository).toBe(0);
    expect(handle.calls.listRepositories).toBe(listCalls);
    await click(addSubmitButton());
    await settle();
    expect(handle.calls.addRepository).toBe(1);
  });

  it('重复仓库按钮阶段结束后变为清除，但 duplicate message 仍保留', async () => {
    await mount({ repositories: [makeGlance(1, 'deepseek-ai/deepseek-harness')] });
    const input = await expandAddForm();
    await typeInto(input, 'deepseek-ai/deepseek-harness');
    expect(activeAddButtonLabel()).toBe('已添加');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(activeAddButtonLabel()).toBe('清除');
    expect(addSubmitButton().disabled).toBe(false);
    expect(input.value).toBe('deepseek-ai/deepseek-harness');
    expect(handle.calls.addRepository).toBe(0);
    expect(addStatus()?.textContent).toContain('已在监控清单中');
    expect(addStatus()?.textContent).toContain('打开详情');
    await pointerDown(buttonByText('全部刷新')!);
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('重复状态是 inline status，不使用整宽错误 banner', async () => {
    await mount({ repositories: [makeGlance(1, 'deepseek-ai/deepseek-harness')] });
    const input = await expandAddForm();
    await typeInto(input, 'deepseek-ai/deepseek-harness');
    expect(addStatus()?.textContent).toContain('deepseek-ai/deepseek-harness');
    expect(addStatus()?.textContent).toContain('已在监控清单中');
    expect(addStatus()?.textContent).not.toContain('查看');
    expect(addStatus()?.textContent).toContain('打开详情');
    expect(input.form?.querySelector('.watchlist-inline-message')?.contains(addStatus() ?? null)).toBe(
      true,
    );
    expect(addStatus()?.closest('.watchlist-inline-message')?.getAttribute('data-open')).toBe('true');
    expect(addSubmitButton().parentElement).toBe(input.form?.firstElementChild);
    expect(addError()).toBeNull();
    expect(alertTexts().join(' ')).not.toContain('该仓库已在监控清单中');
  });

  it('重复状态「打开详情」直接进入对应仓库 Detail 且不改变排序', async () => {
    await mount({ repositories: [makeGlance(1, 'deepseek-ai/deepseek-harness')] });
    const orderBefore = repoRows().map((row) => row.dataset.repositoryId);
    const input = await expandAddForm();
    await typeInto(input, 'deepseek-ai/deepseek-harness');
    await pointerDown(addStatus()!);
    expect(addStatus()?.textContent).toContain('打开详情');
    expect(repoRows().map((row) => row.dataset.repositoryId)).toEqual(orderBefore);
    await click(buttonByText('打开详情'));
    await settle();
    expect(bodyText()).toContain('概览');
    expect(bodyText()).toContain('deepseek-ai/deepseek-harness');
    expect(handle.calls.fetchDetail).toBe(1);
  });

  it('修改重复输入后立即清除旧状态并重新计算按钮', async () => {
    await mount({ repositories: [makeGlance(1, 'deepseek-ai/deepseek-harness')] });
    const input = await expandAddForm();
    await typeInto(input, 'deepseek-ai/deepseek-harness');
    expect(addStatus()).not.toBeNull();
    await typeInto(input, 'deepseek-ai/deepseek-harness ');
    expect(activeAddButtonLabel()).toBe('已添加');
    expect(addSubmitButton().disabled).toBe(false);
    await typeInto(input, 'facebook/react');
    expect(addStatus()).toBeNull();
    expect(addSubmitButton().disabled).toBe(false);
    expect(bodyText()).not.toContain('deepseek-ai/deepseek-harness 已在监控清单中');
  });

  it('Invalid 切到 Duplicate 时提示容器保持展开，仓库列表仍在正常文档流', async () => {
    await mount({ repositories: [makeGlance(1, 'deepseek-ai/deepseek-harness')] });
    const input = await expandAddForm();
    const region = document.querySelector('.watchlist-inline-message');
    const list = repoRows()[0]?.parentElement;
    const page = list?.parentElement;
    await typeInto(input, '11111');
    expect(region?.getAttribute('data-open')).toBe('true');
    expect(region?.parentElement).toBe(input.form);
    await typeInto(input, 'deepseek-ai/deepseek-harness');
    expect(document.querySelector('.watchlist-inline-message')).toBe(region);
    expect(region?.getAttribute('data-open')).toBe('true');
    expect(addStatus()?.textContent).toContain('已在监控清单中');
    expect(list?.parentElement).toBe(page);
    expect(handle.calls.addRepository).toBe(0);
  });

  it('提示消失时保留内容供退出过渡，立即退出读屏路径后再移除', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, '11111');
    const region = document.querySelector('.watchlist-inline-message');
    expect(region?.getAttribute('data-open')).toBe('true');
    await typeInto(input, 'facebook/react');
    expect(region?.getAttribute('data-open')).toBe('false');
    expect(region?.getAttribute('aria-hidden')).toBe('true');
    expect(region?.querySelector('.add-repository-status')).not.toBeNull();
    await vi.waitFor(() => expect(region?.querySelector('.add-repository-status')).toBeNull());
    expect(addSubmitButton().disabled).toBe(false);
  });

  it('Escape 清除重复状态及本次输入，重新展开后是空表单', async () => {
    await mount({ repositories: [makeGlance(1, 'deepseek-ai/deepseek-harness')] });
    const input = await expandAddForm();
    await typeInto(input, 'deepseek-ai/deepseek-harness');
    expect(addStatus()).not.toBeNull();
    await pressEscape();
    await expandAddForm();
    expect(addInput().value).toBe('');
    expect(addStatus()).toBeNull();
    expect(addSubmitButton().disabled).toBe(true);
  });

  it('无效输入显示轻量校验和清除按钮，清除后可重新输入', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'not a repository');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(activeAddButtonLabel()).toBe('清除');
    expect(addSubmitButton().type).toBe('button');
    expect(addSubmitButton().disabled).toBe(false);
    expect(document.querySelector('.watchlist-add-form .add-repository-status')?.textContent).toBe(
      '请输入 owner/repo 或 GitHub 仓库地址',
    );
    expect(addError()).toBeNull();
    await click(addSubmitButton());
    expect(input.value).toBe('');
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('true');
    expect(activeAddButtonLabel()).toBe('加入');
    expect(addSubmitButton().disabled).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('非法输入变为有效输入时复用右侧按钮，不重新收起操作列', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, '11111');
    const action = addSubmitButton();
    expect(activeAddButtonLabel()).toBe('清除');
    await typeInto(input, 'facebook/react');
    expect(addSubmitButton()).toBe(action);
    expect(activeAddButtonLabel()).toBe('加入');
    expect(action.type).toBe('submit');
  });

  it('无效输入即使触发表单 submit 也不会调用 addRepository', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'not a repository');
    if (!input.form) throw new Error('输入框不在表单内');
    await submitForm(input.form);
    expect(handle.calls.addRepository).toBe(0);
  });

  it('后端重复响应映射到相同状态并刷新本地清单', async () => {
    const repository = makeGlance(2, 'deepseek-ai/deepseek-harness');
    await mount({
      repositories: [],
      addResult: {
        ok: false,
        repository: null,
        error: { kind: 'unknown', message: '该仓库已在监控清单中', fullName: repository.fullName },
      },
    });
    handle.setRepositories([repository]);
    const input = await expandAddForm();
    await typeInto(input, repository.fullName);
    await submitForm(input.form!);
    await settle();
    expect(handle.calls.addRepository).toBe(1);
    expect(addStatus()?.textContent).toContain(repository.fullName);
    expect(addStatus()?.textContent).toContain('已在监控清单中');
    expect(addStatus()?.textContent).not.toContain('查看');
    expect(addError()).toBeNull();
    expect(buttonByText('打开详情')?.disabled).toBe(false);
    expect(addSubmitButton().disabled).toBe(false);
    await typeInto(input, 'facebook/react');
    expect(addStatus()).toBeNull();
    expect(handle.calls.addRepository).toBe(1);
  });

  it('有效输入通过表单提交（Enter 使用相同 submit 行为）', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    if (!input.form) throw new Error('输入框不在表单内');
    await submitForm(input.form);
    await settle();
    expect(handle.calls.addRepository).toBe(1);
    expect(handle.addInputs).toEqual(['facebook/react']);
  });

  it('可见新增成功后点击已添加切到清除，取消自动收起；清除只回到空输入编辑', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    const form = input.form;
    if (!form) throw new Error('输入框不在表单内');

    await submitForm(form);
    await settle();

    expect(handle.calls.addRepository).toBe(1);
    expect(addInput().value).toBe('');
    expect(addInput().disabled).toBe(false);
    expect(activeAddButtonLabel()).toBe('已添加');
    expect(addSubmitButton().disabled).toBe(false);
    expect(addStatus()?.textContent).toContain('facebook/react 已加入监控清单');
    expect(document.querySelector('.watchlist-added-notice')).toBeNull();
    expect(buttonByText('查看位置')).toBeNull();
    await pointerDown(buttonByText('全部刷新')!);
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('true');
    await click(addSubmitButton());
    expect(activeAddButtonLabel()).toBe('清除');
    expect(addSubmitButton().disabled).toBe(false);
    expect(addStatus()?.textContent).toContain('facebook/react 已加入监控清单');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('true');
    await click(addSubmitButton());
    expect(addInput().value).toBe('');
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('true');
    expect(activeAddButtonLabel()).toBe('加入');
    expect(addSubmitButton().disabled).toBe(true);
    expect(document.activeElement).toBe(addInput());
    expect(addStatus()).toBeNull();
    expect(handle.calls.addRepository).toBe(1);
    expect(bodyText()).toContain('1 个仓库');
  });

  it('可见新增成功后无操作，约 1.4 秒自动收起整个表单', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    await submitForm(input.form!);
    await settle();
    expect(activeAddButtonLabel()).toBe('已添加');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('false');
    expect(addInput().disabled).toBe(true);
    expect(addStatus()).toBeNull();
  });

  it('成功反馈期间开始输入新仓库时不自动清除新内容', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    await submitForm(input.form!);
    await settle();
    await typeInto(input, 'facebook/vue');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(input.value).toBe('facebook/vue');
    expect(activeAddButtonLabel()).toBe('加入');
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('加入失败：错误在表单内显示，输入保留且不收起', async () => {
    await mount({
      repositories: [],
      addResult: {
        ok: false,
        repository: null,
        error: { kind: 'network', message: '连接中断' },
      },
    });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    const form = input.form;
    if (!form) throw new Error('输入框不在表单内');

    await submitForm(form);
    await settle();

    expect(addError()?.textContent).toContain('网络失败');
    expect(addInput().value).toBe('facebook/react');
    expect(addInput().disabled).toBe(false);
    expect(activeAddButtonLabel()).toBe('清除');
    expect(addSubmitButton().type).toBe('button');
    await submitForm(form);
    expect(handle.calls.addRepository).toBe(1);
    await click(addSubmitButton());
    expect(addInput().value).toBe('');
    expect(buttonByLabel('新增仓库')?.getAttribute('aria-expanded')).toBe('true');
    expect(activeAddButtonLabel()).toBe('加入');
    expect(addSubmitButton().disabled).toBe(true);
  });

  it('Remote Error 对应的输入一旦修改，错误立即回收且按钮恢复加入', async () => {
    await mount({
      repositories: [],
      addResult: {
        ok: false,
        repository: null,
        error: { kind: 'not_found', message: '仓库不存在或无权访问' },
      },
    });
    const input = await expandAddForm();
    await typeInto(input, 'owner/not-found');
    await submitForm(input.form!);
    await settle();

    expect(addError()?.textContent).toContain('仓库不存在或无权访问');
    expect(activeAddButtonLabel()).toBe('清除');
    await submitForm(input.form!);
    expect(handle.calls.addRepository).toBe(1);

    await typeInto(input, 'owner/another-repo');
    expect(addError()).toBeNull();
    expect(activeAddButtonLabel()).toBe('加入');
    expect(addSubmitButton().type).toBe('submit');
    expect(addSubmitButton().disabled).toBe(false);
  });

  it('Escape 清除本次加入错误，重新展开不显示残留错误', async () => {
    await mount({
      repositories: [],
      addResult: { ok: false, repository: null, error: { kind: 'network', message: '连接中断' } },
    });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    await submitForm(input.form!);
    await settle();
    expect(addError()).not.toBeNull();
    await pressEscape();
    await expandAddForm();
    expect(addInput().value).toBe('');
    expect(addError()).toBeNull();
  });

  it('添加中显示 spinner 文案并禁止重复提交', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    const release = handle.holdNextAdd();
    if (!input.form) throw new Error('输入框不在表单内');
    await submitForm(input.form);
    await settle();
    expect(activeAddButtonLabel()).toBe('加入中…');
    expect(addSubmitButton().querySelector('.watchlist-add-spinner')).not.toBeNull();
    expect(addSubmitButton().disabled).toBe(true);
    await submitForm(input.form);
    expect(handle.calls.addRepository).toBe(1);
    release();
    await settle();
    expect(activeAddButtonLabel()).toBe('已添加');
  });

  it('空输入点击外部收起，非空输入点击外部保留内容', async () => {
    await mount({ repositories: [] });
    let input = await expandAddForm();
    await pointerDown(buttonByText('全部刷新')!);
    expect(addInput().disabled).toBe(true);
    input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    await pointerDown(buttonByText('全部刷新')!);
    expect(addInput().value).toBe('facebook/react');
  });

  it('空输入外部点击收起时不抢回新目标的焦点', async () => {
    await mount({ repositories: [] });
    await expandAddForm();
    const refresh = buttonByText('全部刷新');
    if (!refresh) throw new Error('未找到全部刷新');
    await act(async () => {
      refresh.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      refresh.focus();
    });
    expect(addInput().disabled).toBe(true);
    expect(document.activeElement).toBe(refresh);
  });

  it('点击输入框或加入按钮属于表单内部，不触发 outside 收起', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await pointerDown(input);
    expect(addInput()).toBe(input);
    await typeInto(input, 'facebook/react');
    await pointerDown(addSubmitButton());
    await click(addSubmitButton());
    await settle();
    expect(handle.calls.addRepository).toBe(1);
  });

  it('提交中点击外部保持展开，成功后保留行内已添加反馈', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    const release = handle.holdNextAdd();
    await submitForm(input.form!);
    await settle();
    await pointerDown(buttonByText('全部刷新')!);
    expect(addInput().value).toBe('facebook/react');
    release();
    await settle();
    expect(addInput().disabled).toBe(false);
    expect(activeAddButtonLabel()).toBe('已添加');
    expect(addInput().value).toBe('');
    expect(addStatus()?.textContent).toContain('facebook/react 已加入监控清单');
  });

  it('即使输入为空，只要正在提交，外部 pointerdown 也不收起', async () => {
    let setAdding = (_next: boolean): void => {};
    function Harness() {
      const [adding, updateAdding] = useState(false);
      setAdding = updateAdding;
      return (
        <>
          <AddRepositoryForm
            repositories={[]}
            adding={adding}
            onSubmit={async () => ({
              result: { ok: true, repository: null, error: null },
              newCardPosition: 'visible',
            })}
            onOpenRepository={() => {}}
            onViewPosition={() => {}}
          />
          <button type="button">外部区域</button>
        </>
      );
    }
    view = await renderNode(createStub(), <Harness />);
    await expandAddForm();
    await act(async () => setAdding(true));
    await pointerDown(buttonByText('外部区域')!);
    expect(addInput()).not.toBeNull();
    await act(async () => setAdding(false));
    await pointerDown(buttonByText('外部区域')!);
    expect(addInput().disabled).toBe(true);
  });

  it('点击页面其他位置不会自动收起或丢弃非空输入', async () => {
    await mount({ repositories: [] });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    await pointerDown(buttonByText('全部刷新')!);
    await click(buttonByText('全部刷新'));
    await settle();
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('facebook/react');
  });

  it('展开后的 Tab 顺序是 Input、加入、全部刷新、仓库卡片', async () => {
    await mount({ repositories: [makeGlance(1, 'octocat/Hello-World')] });
    const input = await expandAddForm();
    await typeInto(input, 'facebook/react');
    const toolbar = document.querySelector('.watchlist-toolbar');
    if (!toolbar) throw new Error('未找到 Watchlist Toolbar');
    const controls = [...toolbar.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')]
      .filter((control) => !control.disabled && !control.closest('[aria-hidden="true"]'))
      .map((control) => control.getAttribute('aria-label') ?? control.textContent?.trim());
    expect(controls[0]).toContain('监控仓库');
    expect(controls[1]).toBe('加入仓库');
    expect(controls[2]).toBe('全部刷新');
    expect(repoOpenButton('octocat/Hello-World')).not.toBeNull();
  });
});
