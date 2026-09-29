// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import type { AccessTokenResult, NormalizedError } from '../../src/shared/types';
import {
  alertTexts,
  bodyText,
  buttonByLabel,
  buttonByText,
  click,
  createStub,
  makeGlance,
  navButton,
  renderApp,
  repoRows,
  resetSystemTheme,
  resetReducedMotion,
  segmentedButton,
  settle,
  setReducedMotion,
  submitForm,
  typeInto,
} from './helpers';

let handle: StubHandle;
let view: RenderResult | null = null;

const tokenErrorCases: Array<{ kind: NormalizedError['kind']; expected: string }> = [
  { kind: 'access_token_invalid', expected: '令牌无效或已过期，请检查后重试' },
  { kind: 'network', expected: '无法连接 GitHub，请检查网络后重试' },
  { kind: 'not_found', expected: '当前令牌权限不足，请检查令牌权限' },
  { kind: 'rate_limited', expected: 'GitHub 请求频率受限，请稍后再试' },
];

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

function tokenFeedback(): HTMLElement | null {
  const region = document.querySelector<HTMLElement>('.github-token-feedback');
  if (region?.dataset.open !== 'true') return null;
  return region.querySelector<HTMLElement>('.github-token-feedback-status');
}

function tokenFeedbackRegion(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.github-token-feedback');
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
  resetReducedMotion();
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

    const sectionHeading = [...document.querySelectorAll('h2')].find((heading) => heading.textContent === 'GitHub');
    expect(sectionHeading?.parentElement?.classList.contains('settings-section')).toBe(true);
    expect(sectionHeading?.nextElementSibling?.classList.contains('settings-section-card')).toBe(true);
  });

  it('外观使用左侧 Setting Row，Token Header 将已配置状态靠右展示', async () => {
    await mount();
    await openSettings();

    expect(document.querySelector('.settings-row-label')?.textContent).toBe('主题');
    expect(document.querySelector('.settings-row-control')).not.toBeNull();
    const tokenHeading = document.querySelector('.settings-token-heading');
    expect(tokenHeading?.textContent).toContain('Personal Access Token');
    expect(tokenHeading?.textContent).toContain('已配置');
    expect(document.querySelector('label[for="accessToken-input"]')).toBeNull();
    expect(tokenInput().getAttribute('aria-label')).toBe('Personal Access Token');
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

    await click(buttonByLabel('显示令牌'));
    await settle();
    expect(tokenInput().type).toBe('text');

    await click(buttonByLabel('隐藏令牌'));
    await settle();
    expect(tokenInput().type).toBe('password');
  });

  it('令牌显示控制使用有名称的轻量图标按钮', async () => {
    await mount();
    await openSettings();

    const showButton = buttonByLabel('显示令牌');
    expect(showButton).not.toBeNull();
    expect(showButton?.title).toBe('显示令牌');
    expect(showButton?.querySelector('svg')).not.toBeNull();
  });

  it('Reduced Motion 下状态照常显示，输入变化时立即关闭', async () => {
    setReducedMotion(true);
    await mount();
    await openSettings();

    await click(buttonByText('测试连接'));
    expect(tokenFeedback()?.textContent).toContain('请输入访问令牌');

    await typeInto(tokenInput(), 'ghp_candidate');
    expect(tokenFeedback()).toBeNull();
    expect(tokenFeedbackRegion()?.dataset.open).toBe('false');
    expect(tokenFeedbackRegion()?.querySelector('.github-token-feedback-status')).toBeNull();
  });

  it('Token 状态容器在操作行之后展开，且上方输入与按钮 DOM 保持不变', async () => {
    await mount();
    await openSettings();

    const input = tokenInput();
    const saveButton = buttonByText('保存并验证');
    const testButton = buttonByText('测试连接');
    const form = input.form;
    if (!form) throw new Error('输入框不在表单内');
    const region = tokenFeedbackRegion();

    expect(region?.previousElementSibling?.classList.contains('space-y-3')).toBe(true);
    await click(testButton);

    expect(tokenFeedback()?.textContent).toContain('请输入访问令牌');
    expect(tokenInput()).toBe(input);
    expect(buttonByText('保存并验证')).toBe(saveButton);
    expect(buttonByText('测试连接')).toBe(testButton);
    expect(region?.parentElement).toBe(form);

    await typeInto(input, 'ghp_candidate');
    expect(tokenFeedbackRegion()?.dataset.open).toBe('false');
    expect(tokenInput()).toBe(input);
    expect(buttonByText('保存并验证')).toBe(saveButton);
    expect(buttonByText('测试连接')).toBe(testButton);
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
    expect(bodyText()).toContain('令牌已保存并验证');
    expect(tokenFeedback()?.getAttribute('role')).toBe('status');
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

    expect(alertTexts().join(' ')).toContain('令牌无效或已过期，请检查后重试');
    expect(tokenFeedback()?.className).toContain('text-danger');
    expect(tokenFeedback()?.className).not.toContain('border');
    expect(bodyText()).toContain('Personal Access Token');
    expect(tokenInput().value).toBe('ghp_wrong');
    expect(bodyText()).toContain('已配置');
  });

  it('测试连接成功：给出有效提示且不保存', async () => {
    await mount();
    await openSettings();

    await typeInto(tokenInput(), 'ghp_valid');
    await click(buttonByText('测试连接'));
    await settle();

    expect(handle.calls.validateAccessToken).toBe(1);
    expect(handle.calls.saveAccessToken).toBe(0);
    expect(bodyText()).toContain('GitHub 连接正常');
    expect(tokenFeedback()?.getAttribute('role')).toBe('status');

    await click(buttonByLabel('显示令牌'));
    expect(tokenFeedback()?.textContent).toContain('GitHub 连接正常');
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
    expect(alertTexts().join(' ')).toContain('无法连接 GitHub，请检查网络后重试');
    expect(tokenFeedback()?.getAttribute('role')).toBe('alert');
    expect(handle.calls.saveAccessToken).toBe(0);
  });

  it.each(tokenErrorCases)('按错误类别显示局部文案：$kind', async ({ kind, expected }) => {
    await mount({
      validateTokenResult: {
        ok: false,
        error: { kind, message: 'HTTP 401 Bad credentials' },
      },
    });
    await openSettings();

    await typeInto(tokenInput(), 'ghp_candidate');
    await click(buttonByText('测试连接'));
    await settle();

    expect(tokenFeedback()?.textContent).toContain(expected);
    expect(tokenFeedback()?.textContent).not.toContain('HTTP 401');
    expect(tokenFeedback()?.getAttribute('role')).toBe('alert');
  });

  it('保存并验证期间显示 loading，成功后保留本机已配置状态', async () => {
    await mount();
    await openSettings();
    await typeInto(tokenInput(), 'ghp_to_save');

    let resolveSave: (result: AccessTokenResult) => void = () => {};
    handle.api.saveAccessToken = async () => {
      handle.calls.saveAccessToken += 1;
      return await new Promise<AccessTokenResult>((resolve) => {
        resolveSave = resolve;
      });
    };

    const form = tokenInput().form;
    if (!form) throw new Error('输入框不在表单内');
    await submitForm(form);

    const saveButton = buttonByText('验证中…');
    expect(saveButton?.disabled).toBe(true);
    expect(saveButton?.getAttribute('aria-busy')).toBe('true');
    expect(buttonByText('测试连接')?.disabled).toBe(true);
    expect(tokenInput().disabled).toBe(true);

    await act(async () => {
      resolveSave({ ok: true, error: null });
    });
    await settle();

    expect(bodyText()).toContain('已配置');
    expect(tokenFeedback()?.textContent).toContain('令牌已保存并验证');
  });

  it('输入变化后立即清除旧的成功或错误状态', async () => {
    await mount();
    await openSettings();

    await typeInto(tokenInput(), 'ghp_valid');
    await click(buttonByText('测试连接'));
    await settle();
    expect(tokenFeedback()?.textContent).toContain('GitHub 连接正常');

    await typeInto(tokenInput(), 'ghp_changed');
    expect(tokenFeedback()).toBeNull();
    expect(tokenFeedbackRegion()?.dataset.open).toBe('false');
    expect(tokenFeedbackRegion()?.querySelector('.github-token-feedback-status')?.textContent).toContain(
      'GitHub 连接正常',
    );

    // 再产生一个错误状态，输入变化后也必须立即失效。
    handle.api.validateAccessToken = async () => ({
      ok: false,
      error: { kind: 'access_token_invalid', message: '底层错误不直接显示' },
    });
    await click(buttonByText('测试连接'));
    await settle();
    expect(tokenFeedback()?.textContent).toContain('令牌无效或已过期');

    await typeInto(tokenInput(), 'ghp_corrected');
    expect(tokenFeedback()).toBeNull();
    expect(tokenFeedbackRegion()?.dataset.open).toBe('false');
    expect(tokenFeedbackRegion()?.querySelector('.github-token-feedback-status')?.textContent).toContain(
      '令牌无效或已过期',
    );
  });

  it('验证中显示稳定 loading、禁用两项验证操作，并允许编辑输入', async () => {
    await mount();
    await openSettings();
    await typeInto(tokenInput(), 'ghp_first');

    let resolveValidation: (result: AccessTokenResult) => void = () => {};
    handle.api.validateAccessToken = async () => {
      handle.calls.validateAccessToken += 1;
      return await new Promise<AccessTokenResult>((resolve) => {
        resolveValidation = resolve;
      });
    };

    await click(buttonByText('测试连接'));

    const testButton = buttonByText('测试中…');
    const saveButton = buttonByText('保存并验证');
    expect(testButton?.disabled).toBe(true);
    expect(testButton?.getAttribute('aria-busy')).toBe('true');
    expect(saveButton?.disabled).toBe(true);
    expect(saveButton?.getAttribute('aria-busy')).toBe('false');
    expect(tokenInput().disabled).toBe(false);

    await typeInto(tokenInput(), 'ghp_second');
    expect(buttonByText('测试连接')?.disabled).toBe(false);
    expect(tokenFeedback()).toBeNull();

    await act(async () => {
      resolveValidation({ ok: true, error: null });
    });
    await settle();

    expect(tokenInput().value).toBe('ghp_second');
    expect(tokenFeedback()).toBeNull();
  });

  it('丢弃与当前输入不匹配的迟到验证结果', async () => {
    await mount();
    await openSettings();
    await typeInto(tokenInput(), 'ghp_old');

    let resolveValidation: (result: AccessTokenResult) => void = () => {};
    handle.api.validateAccessToken = async () =>
      await new Promise<AccessTokenResult>((resolve) => {
        resolveValidation = resolve;
      });

    await click(buttonByText('测试连接'));
    await typeInto(tokenInput(), 'ghp_new');
    await act(async () => {
      resolveValidation({ ok: true, error: null });
    });
    await settle();

    expect(tokenInput().value).toBe('ghp_new');
    expect(tokenFeedback()).toBeNull();
  });

  it('未输入令牌时两个操作都给出明确提示', async () => {
    await mount();
    await openSettings();

    await click(buttonByText('测试连接'));
    await settle();
    expect(alertTexts().join(' ')).toContain('请输入访问令牌');
    expect(tokenFeedback()?.getAttribute('role')).toBe('alert');
    expect(handle.calls.validateAccessToken).toBe(0);

    const form = tokenInput().form;
    if (!form) throw new Error('输入框不在表单内');
    await submitForm(form);
    await settle();
    expect(alertTexts().join(' ')).toContain('请输入访问令牌');
    expect(handle.calls.saveAccessToken).toBe(0);
  });
});
