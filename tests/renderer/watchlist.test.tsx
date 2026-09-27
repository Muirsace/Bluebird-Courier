// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  alertTexts,
  bodyText,
  buttonByText,
  click,
  createStub,
  makeGlance,
  renderApp,
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
  it('加入成功：调用一次 addRepository 并清空输入框', async () => {
    await mount({ repositories: [] });
    const input = addInput();
    await typeInto(input, 'facebook/react');
    const form = input.form;
    if (!form) throw new Error('输入框不在表单内');

    await submitForm(form);
    await settle();

    expect(handle.calls.addRepository).toBe(1);
    expect(addInput().value).toBe('');
  });

  it('加入失败：页头错误条保留提示，输入内容不丢', async () => {
    await mount({
      repositories: [],
      addResult: {
        ok: false,
        repository: null,
        error: { kind: 'unknown', message: '该仓库已在监控清单中' },
      },
    });
    const input = addInput();
    await typeInto(input, 'facebook/react');
    const form = input.form;
    if (!form) throw new Error('输入框不在表单内');

    await submitForm(form);
    await settle();

    expect(alertTexts().join(' ')).toContain('该仓库已在监控清单中');
    expect(addInput().value).toBe('facebook/react');
  });
});
