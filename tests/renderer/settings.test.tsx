// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  alertTexts,
  bodyText,
  buttonByText,
  click,
  createStub,
  makeGlance,
  navButton,
  renderApp,
  repoRows,
  resetSystemTheme,
  segmentedButton,
  settle,
  submitForm,
  typeInto,
} from './helpers';

let handle: StubHandle;
let view: RenderResult | null = null;

async function mount(options: StubOptions = {}): Promise<void> {
  handle = createStub({
    ...options,
    repositories: options.repositories ?? [makeGlance(1, 'octocat/Hello-World')],
  });
  view = await renderApp(handle);
  await settle();
}

async function openSettings(): Promise<void> {
  await click(navButton('设置'));
  await settle();
}

function tokenInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('#accessToken-input');
  if (!input) throw new Error('未找到令牌输入框');
  return input;
}

beforeEach(() => {
  resetSystemTheme();
});

afterEach(async () => {
  if (view) {
    await view.unmount();
    view = null;
  }
  delete document.documentElement.dataset.theme;
});

describe('设置页 · 结构与导航', () => {
  it('分成「外观」与「GitHub」两组，且不再有重复的返回清单按钮', async () => {
    await mount();
    await openSettings();

    const text = bodyText();
    expect(text).toContain('外观');
    expect(text).toContain('主题');
    expect(text).toContain('GitHub');
    expect(text).toContain('Personal Access Token');

    // 页面不再重复显示当前页入口；Header 只指向监控清单
    expect(buttonByText('← 返回清单')).toBeNull();
    expect(navButton('监控清单')).not.toBeNull();
    expect(navButton('设置')).toBeNull();
    expect(navButton('监控清单')?.getAttribute('aria-current')).toBeNull();
  });

  it('顶部导航仍可在设置与清单间往返', async () => {
    await mount();
    await openSettings();
    expect(bodyText()).toContain('Personal Access Token');

    await click(navButton('监控清单'));
    await settle();
    expect(repoRows()).toHaveLength(1);
  });
});

describe('设置页 · 主题选择', () => {
  it('三个主题按钮的 active 状态与当前偏好一致', async () => {
    await mount({ preferences: { theme: 'dark' } });
    await openSettings();

    expect(segmentedButton('跟随系统')?.getAttribute('aria-pressed')).toBe('false');
    expect(segmentedButton('浅色')?.getAttribute('aria-pressed')).toBe('false');
    expect(segmentedButton('深色')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('切换主题只写偏好，不碰令牌状态', async () => {
    await mount();
    await openSettings();
    const before = { ...handle.calls };

    await click(segmentedButton('浅色'));
    await settle();

    expect(handle.calls.updateSettings - before.updateSettings).toBe(1);
    expect(handle.calls.saveAccessToken).toBe(before.saveAccessToken);
    expect(handle.calls.validateAccessToken).toBe(before.validateAccessToken);
  });
});

describe('设置页 · 访问令牌', () => {
  it('显示已配置状态，并且不回显已保存的令牌', async () => {
    await mount();
    await openSettings();

    expect(bodyText()).toContain('已配置');
    expect(tokenInput().value).toBe('');
    expect(tokenInput().type).toBe('password');
  });

  it('显示 / 隐藏只作用于当前输入的值', async () => {
    await mount();
    await openSettings();

    await typeInto(tokenInput(), 'ghp_typed_value');
    expect(tokenInput().type).toBe('password');

    await click(buttonByText('显示'));
    await settle();
    expect(tokenInput().type).toBe('text');

    await click(buttonByText('隐藏'));
    await settle();
    expect(tokenInput().type).toBe('password');
  });

  it('保存并验证成功：提示一次、清空输入、令牌状态更新', async () => {
    await mount();
    await openSettings();

    const input = tokenInput();
    await typeInto(input, 'ghp_valid');
    const form = input.form;
    if (!form) throw new Error('输入框不在表单内');
    await submitForm(form);
    await settle();

    expect(handle.calls.saveAccessToken).toBe(1);
    expect(bodyText()).toContain('访问令牌已保存并验证通过');
    expect(tokenInput().value).toBe('');

    // 成功后自动跳回监控清单（App 侧不再重复提示）
    await new Promise((resolve) => {
      setTimeout(resolve, 950);
    });
    await settle();
    expect(repoRows()).toHaveLength(1);
    expect(alertTexts()).toHaveLength(0);
  });

  it('保存失败：留在设置页并显示令牌错误', async () => {
    await mount({
      saveTokenResult: {
        ok: false,
        error: { kind: 'access_token_invalid', message: '令牌无效' },
      },
    });
    await openSettings();

    const input = tokenInput();
    await typeInto(input, 'ghp_wrong');
    const form = input.form;
    if (!form) throw new Error('输入框不在表单内');
    await submitForm(form);
    await settle();

    expect(alertTexts().join(' ')).toContain('令牌无效');
    expect(bodyText()).toContain('Personal Access Token');
    expect(tokenInput().value).toBe('ghp_wrong');
  });

  it('测试连接成功：给出有效提示且不保存', async () => {
    await mount();
    await openSettings();

    await typeInto(tokenInput(), 'ghp_valid');
    await click(buttonByText('测试连接'));
    await settle();

    expect(handle.calls.validateAccessToken).toBe(1);
    expect(handle.calls.saveAccessToken).toBe(0);
    expect(bodyText()).toContain('访问令牌有效');
  });

  it('测试连接失败：显示错误且不保存', async () => {
    await mount({
      validateTokenResult: {
        ok: false,
        error: { kind: 'network', message: '网络失败' },
      },
    });
    await openSettings();

    await typeInto(tokenInput(), 'ghp_valid');
    await click(buttonByText('测试连接'));
    await settle();

    expect(handle.calls.validateAccessToken).toBe(1);
    expect(handle.calls.saveAccessToken).toBe(0);
    expect(alertTexts().join(' ')).toContain('网络失败');
  });

  it('未输入令牌时两个操作都给出明确提示', async () => {
    await mount();
    await openSettings();

    await click(buttonByText('测试连接'));
    await settle();
    expect(alertTexts().join(' ')).toContain('请输入访问令牌');
    expect(handle.calls.validateAccessToken).toBe(0);

    const form = tokenInput().form;
    if (!form) throw new Error('输入框不在表单内');
    await submitForm(form);
    await settle();
    expect(alertTexts().join(' ')).toContain('请输入访问令牌');
    expect(handle.calls.saveAccessToken).toBe(0);
  });
});
