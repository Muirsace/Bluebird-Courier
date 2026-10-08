// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import type { AccessTokenResult, NormalizedError, TokenOperationResult } from '../../src/shared/types';
import {
  alertTexts,
  bodyText,
  buttonByLabel,
  buttonByText,
  click,
  createStub,
  makeGlance,
  navButton,
  openRepo,
  renderApp,
  repoOpenButton,
  repoRows,
  resetSystemTheme,
  resetReducedMotion,
  segmentedButton,
  settle,
  settleMotion,
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

/** 已配置令牌的更换流程使用三个命名桥接方法；这里安装可控替身并记录调用。 */
function attachReplacement(confirmResult?: TokenOperationResult) {
  const state = {
    began: 0,
    confirmed: [] as string[],
    cancelled: 0,
    confirmResult: confirmResult ?? ({ ok: true, state: 'completed', error: null } as TokenOperationResult),
  };
  let beginGate: Promise<void> | null = null;
  let confirmGate: Promise<void> | null = null;
  handle.api.beginTokenReplacement = async () => {
    state.began += 1;
    // 闸门只作用于当前这一次登记：之后的登记立即返回。
    const gate = beginGate;
    beginGate = null;
    if (gate) await gate;
    return { ok: true, state: 'awaiting_confirmation' as const, error: null };
  };
  handle.api.confirmTokenReplacement = async (token: string) => {
    state.confirmed.push(token);
    const gate = confirmGate;
    confirmGate = null;
    if (gate) await gate;
    return state.confirmResult;
  };
  handle.api.cancelTokenReplacement = async () => {
    state.cancelled += 1;
    return { ok: true, state: 'idle' as const, error: null };
  };
  const hold = (set: (gate: Promise<void> | null) => void): (() => void) => {
    let release = (): void => {};
    set(new Promise<void>((resolve) => {
      release = () => {
        set(null);
        resolve();
      };
    }));
    return release;
  };
  return {
    state,
    /** 挂起下一次开始登记的请求；返回放行函数。 */
    holdBegin(): () => void {
      return hold((gate) => { beginGate = gate; });
    },
    /** 挂起下一次确认请求；返回放行函数。 */
    holdConfirm(): () => void {
      return hold((gate) => { confirmGate = gate; });
    },
  };
}

async function mount(options: StubOptions = {}, configured = true): Promise<void> {
  handle = createStub({
    ...options,
    repositories: options.repositories ?? [makeGlance(1, 'octocat/Hello-World')],
  });
  if (!configured) handle.api.accessTokenState = async () => ({ configured: false });
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

  it('首次保存成功：提示一次、清空输入、令牌状态更新', async () => {
    await mount({}, false);
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
    }, false);
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
    expect(bodyText()).toContain('未配置');
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

  it('首次保存期间显示 loading，成功后保留本机已配置状态', async () => {
    await mount({}, false);
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

    // 保存成功后主进程会报告已配置（重读访问令牌状态时返回 true）。
    handle.api.accessTokenState = async () => ({ configured: true });
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

describe('设置页 · 更换已配置的令牌', () => {
  async function beginReplacementFlow(): Promise<ReturnType<typeof attachReplacement>> {
    const replacement = attachReplacement();
    await typeInto(tokenInput(), 'ghp_replacement');
    const form = tokenInput().form;
    if (!form) throw new Error('输入框不在表单内');
    await submitForm(form);
    await settle();
    return replacement;
  }

  it('提交先进入确认并明示会清理本地资料，确认后走更换桥接', async () => {
    await mount();
    await openSettings();
    const replacement = await beginReplacementFlow();

    expect(replacement.state.began).toBe(1);
    expect(replacement.state.confirmed).toHaveLength(0);
    // 已配置的令牌不经过直接保存（后端同样拒绝绕过确认的保存）。
    expect(handle.calls.saveAccessToken).toBe(0);
    expect(bodyText()).toContain('清理本机已保存的仓库资料');

    await click(buttonByText('确认更换'));
    await settle();

    expect(replacement.state.confirmed).toEqual(['ghp_replacement']);
    expect(bodyText()).toContain('令牌已更换并验证');
    expect(tokenInput().value).toBe('');

    await new Promise((resolve) => {
      setTimeout(resolve, 950);
    });
    await settle();
    expect(document.querySelector('.settings-page')).toBeNull();
    expect(repoRows()).toHaveLength(1);
  });

  it('取消更换：真实取消后端操作，保留输入与原资料且不导航', async () => {
    await mount();
    await openSettings();
    const replacement = await beginReplacementFlow();

    await click(buttonByText('取消'));
    await settle();

    expect(replacement.state.cancelled).toBe(1);
    expect(replacement.state.confirmed).toHaveLength(0);
    expect(buttonByText('确认更换')).toBeNull();
    expect(tokenInput().value).toBe('ghp_replacement');
    expect(bodyText()).not.toContain('已更换');

    await new Promise((resolve) => {
      setTimeout(resolve, 950);
    });
    await settle();
    expect(document.querySelector('.settings-page')).not.toBeNull();
    await click(navButton('监控清单'));
    await settle();
    expect(repoRows()).toHaveLength(1);
  });

  it('验证失败：错误就地展示，可直接重新确认', async () => {
    await mount();
    await openSettings();
    const replacement = attachReplacement({ ok: false, state: 'failed', error: { kind: 'access_token_invalid', message: 'Bad credentials' } });
    await typeInto(tokenInput(), 'ghp_first_try');
    await submitForm(tokenInput().form!);
    await settle();

    await click(buttonByText('确认更换'));
    await settle();
    expect(tokenFeedback()?.textContent).toContain('令牌无效或已过期，请检查后重试');
    expect(tokenFeedback()?.textContent).not.toContain('Bad credentials');
    // 失败不是死状态：面板保留，可直接重试。
    expect(buttonByText('确认更换')).not.toBeNull();

    replacement.state.confirmResult = { ok: true, state: 'completed', error: null };
    await click(buttonByText('确认更换'));
    await settle();
    expect(replacement.state.confirmed).toEqual(['ghp_first_try', 'ghp_first_try']);
    expect(bodyText()).toContain('令牌已更换并验证');
  });

  it('取消晚到：已提交的成功仍清理旧清单缓存，且不自动导航', async () => {
    await mount();
    const replacement = attachReplacement();
    // 旧清单与旧详情先真正进入展示缓存
    await openRepo('octocat/Hello-World');
    await settle();
    expect(handle.calls.fetchDetail).toBe(1);
    await openSettings();
    await typeInto(tokenInput(), 'ghp_replacement');
    await submitForm(tokenInput().form!);
    await settle();

    const release = replacement.holdConfirm();
    await click(buttonByText('确认更换'));
    await click(buttonByText('取消'));
    await settle();
    expect(replacement.state.cancelled).toBe(1);

    // 主进程其实已经保存新令牌并清理资料，只是回包晚于取消；此后重读返回清空结果
    handle.setRepositories([]);
    await act(async () => release());
    await settle();

    // 已提交是不可逆事实：如实告知，而不是假装取消有效
    expect(tokenFeedback()?.textContent).toContain('令牌已更换并验证');
    await new Promise((resolve) => {
      setTimeout(resolve, 950);
    });
    await settle();
    expect(document.querySelector('.settings-page')).not.toBeNull();

    // 旧清单缓存被清掉：回到清单看到的是清空后的重读结果，不是旧行
    await click(navButton('监控清单'));
    await settle();
    await settleMotion();
    expect(repoRows()).toHaveLength(0);
    expect(bodyText()).toContain('还没有监控仓库');
  });

  it('输入变化后迟到的已提交成功：清理旧上下文且不覆盖正在编辑的输入', async () => {
    await mount();
    const replacement = attachReplacement();
    await openSettings();
    await typeInto(tokenInput(), 'ghp_replacement');
    await submitForm(tokenInput().form!);
    await settle();

    const release = replacement.holdConfirm();
    await click(buttonByText('确认更换'));
    await typeInto(tokenInput(), 'ghp_edited_later');
    expect(replacement.state.cancelled).toBe(1);

    handle.setRepositories([]);
    await act(async () => release());
    await settle();

    // 输入不被覆盖、面板不再出现，但已提交的成功仍被披露并清理旧缓存
    expect(tokenInput().value).toBe('ghp_edited_later');
    expect(buttonByText('确认更换')).toBeNull();
    expect(tokenFeedback()?.textContent).toContain('令牌已更换并验证');
    await click(navButton('监控清单'));
    await settle();
    await settleMotion();
    expect(repoRows()).toHaveLength(0);
  });

  it('确认在途时离开设置页：迟到的已提交成功仍清理旧上下文，不回填已卸载页面', async () => {
    await mount();
    const replacement = attachReplacement();
    await openSettings();
    await typeInto(tokenInput(), 'ghp_replacement');
    await submitForm(tokenInput().form!);
    await settle();

    const release = replacement.holdConfirm();
    await click(buttonByText('确认更换'));
    await click(navButton('监控清单'));
    await settle();
    expect(replacement.state.cancelled).toBe(1);
    expect(document.querySelector('.settings-page')).toBeNull();

    handle.setRepositories([]);
    await act(async () => release());
    await settle();
    // 退场动画播完才断言旧行从清单消失（happy-dom 不自动跑 CSS 动画）
    await settleMotion();

    // 已卸载页面不回填状态、不导航；旧上下文缓存仍然必须清掉
    expect(document.querySelector('.settings-page')).toBeNull();
    expect(bodyText()).not.toContain('已更换');
    expect(repoRows()).toHaveLength(0);
    expect(bodyText()).toContain('还没有监控仓库');
  });

  it('已提交成功但回包延迟：旧详情缓存被清理，重进详情重新抓取', async () => {
    await mount();
    const replacement = attachReplacement();
    await openRepo('octocat/Hello-World');
    await settle();
    expect(handle.calls.fetchDetail).toBe(1);
    await openSettings();
    await typeInto(tokenInput(), 'ghp_replacement');
    await submitForm(tokenInput().form!);
    await settle();

    const release = replacement.holdConfirm();
    await click(buttonByText('确认更换'));
    await click(buttonByText('取消'));
    await act(async () => release());
    await settle();
    await settleMotion();

    // 清单在旧上下文的缓存里仍在（本例不做清单清空），但详情缓存必须已经不可复用
    await click(navButton('监控清单'));
    await settle();
    expect(repoOpenButton('octocat/Hello-World')).not.toBeNull();
    await click(repoOpenButton('octocat/Hello-World'));
    await settle();
    expect(handle.calls.fetchDetail).toBe(2);
  });

  it('验证被取消的失败不会清理：旧清单与旧详情原样保留', async () => {
    await mount();
    const replacement = attachReplacement();
    await openRepo('octocat/Hello-World');
    await settle();
    expect(handle.calls.fetchDetail).toBe(1);
    await openSettings();
    await typeInto(tokenInput(), 'ghp_replacement');
    await submitForm(tokenInput().form!);
    await settle();

    const release = replacement.holdConfirm();
    await click(buttonByText('确认更换'));
    await click(buttonByText('取消'));
    await settle();
    expect(replacement.state.cancelled).toBe(1);

    // 后端返回"验证已被取消"的失败：资料保留，不清任何缓存
    replacement.state.confirmResult = { ok: false, state: 'idle', error: { kind: 'unknown', message: '更换访问令牌操作已取消，未做任何修改' } };
    await act(async () => release());
    await settle();
    expect(bodyText()).not.toContain('已更换');

    await click(navButton('监控清单'));
    await settle();
    expect(repoRows()).toHaveLength(1);
    await click(repoOpenButton('octocat/Hello-World'));
    await settle();
    // 旧详情缓存仍可直接展示：重进只表达一次打开意图，没有强制命令
    expect(handle.calls.fetchDetail).toBe(2);
    expect(handle.calls.refreshRepository).toBe(0);
    expect(document.querySelector('.detail-reveal')?.getAttribute('data-reveal')).toBe('ready');
  });

  it('begin 登记在途时编辑：回收旧意图、恢复可操作，且不取消更新的操作', async () => {
    await mount();
    await openSettings();
    const replacement = attachReplacement();
    const releaseBegin = replacement.holdBegin();
    await typeInto(tokenInput(), 'ghp_first_value');
    await submitForm(tokenInput().form!);
    expect(buttonByText('保存并验证')?.disabled).toBe(true);

    await typeInto(tokenInput(), 'ghp_second_value');
    // 编辑即回收：可操作状态恢复，后端 awaiting 被真实取消
    expect(buttonByText('保存并验证')?.disabled).toBe(false);
    expect(replacement.state.cancelled).toBe(1);

    // 新的一次登记先完成，随后旧 begin 才迟到返回
    await submitForm(tokenInput().form!);
    await settle();
    expect(replacement.state.began).toBe(2);
    expect(buttonByText('确认更换')).not.toBeNull();

    await act(async () => releaseBegin());
    await settle();
    // 迟到的旧 begin 不打开/关闭任何面板，也不取消更新的操作
    expect(replacement.state.cancelled).toBe(1);
    expect(buttonByText('确认更换')).not.toBeNull();
  });

  it('begin 登记在途时离开设置页：后端 awaiting 被真实取消', async () => {
    await mount();
    await openSettings();
    const replacement = attachReplacement();
    const releaseBegin = replacement.holdBegin();
    await typeInto(tokenInput(), 'ghp_pending');
    await submitForm(tokenInput().form!);
    await click(navButton('监控清单'));
    await settle();
    expect(replacement.state.cancelled).toBe(1);

    await act(async () => releaseBegin());
    await settle();
    expect(document.querySelector('.settings-page')).toBeNull();
    expect(alertTexts()).toHaveLength(0);
  });

  it('重复点击确认只提交一次请求', async () => {
    await mount();
    await openSettings();
    const replacement = await beginReplacementFlow();

    const release = replacement.holdConfirm();
    await click(buttonByText('确认更换'));
    await click(buttonByText('验证中…'));
    expect(replacement.state.confirmed).toHaveLength(1);

    await act(async () => release());
    await settle();
    expect(replacement.state.confirmed).toHaveLength(1);
    expect(bodyText()).toContain('令牌已更换并验证');
  });

  it('旧成功的缓存重读完成后，不导航打断新发起的更换', async () => {
    await mount();
    await openSettings();
    const replacement = await beginReplacementFlow();
    const readLocal = handle.api.listRepositories;
    let releaseRead = (): void => {};
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    handle.api.listRepositories = async () => { await gate; return readLocal(); };

    await click(buttonByText('确认更换'));
    await settle();
    await typeInto(tokenInput(), 'ghp_next_operation');
    await submitForm(tokenInput().form!);
    await settle();
    expect(replacement.state.began).toBe(2);
    await act(async () => releaseRead());
    await settle();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 950)); });
    await settle();

    expect(document.querySelector('.settings-page')).not.toBeNull();
    expect(buttonByText('确认更换')).not.toBeNull();
    expect(tokenInput().value).toBe('ghp_next_operation');
  });

  it('确认成功取消旧清单Query，旧请求迟到返回不能回填新上下文缓存', async () => {
    await mount();
    await openSettings();
    await beginReplacementFlow();
    const readLocal = handle.api.listRepositories;
    const oldRepositories = await readLocal();
    let releaseOld = (): void => {};
    const gate = new Promise<void>(resolve => { releaseOld = resolve; });
    let holdNextRead = true;
    handle.api.listRepositories = async () => {
      if (holdNextRead) { holdNextRead = false; await gate; return oldRepositories; }
      return readLocal();
    };
    await act(async () => { void view!.queryClient.refetchQueries({ queryKey: ['repositories'] }); });
    await settle();
    handle.setRepositories([]);
    await click(buttonByText('确认更换'));
    await settle();
    expect(view!.queryClient.getQueryData(['repositories'])).toEqual([]);

    await act(async () => releaseOld());
    await settle();
    expect(view!.queryClient.getQueryData(['repositories'])).toEqual([]);
    await click(navButton('监控清单'));
    await settleMotion();
    expect(repoRows()).toHaveLength(0);
  });

  it('成功提示的等待期内发起新更换，旧定时导航不得取消新操作', async () => {
    await mount();
    await openSettings();
    const replacement = await beginReplacementFlow();
    await click(buttonByText('确认更换'));
    await settle();
    await typeInto(tokenInput(), 'ghp_next_operation');
    await submitForm(tokenInput().form!);
    await settle();
    expect(replacement.state.began).toBe(2);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 950)); });
    await settle();

    expect(document.querySelector('.settings-page')).not.toBeNull();
    expect(buttonByText('确认更换')).not.toBeNull();
    expect(tokenInput().value).toBe('ghp_next_operation');
  });

  it('成功更换后丢弃旧清单缓存，重读后显示清空结果', async () => {
    await mount();
    const replacement = attachReplacement();
    // 先进入详情，让清单与详情的展示数据都进入过缓存。
    await openRepo('octocat/Hello-World');
    await settle();
    await openSettings();
    await typeInto(tokenInput(), 'ghp_replacement');
    await submitForm(tokenInput().form!);
    await settle();

    // 主进程按新上下文清空旧资料：此后的重读返回清空结果。
    handle.setRepositories([]);
    await click(buttonByText('确认更换'));
    await settle();
    expect(replacement.state.confirmed).toEqual(['ghp_replacement']);

    await new Promise((resolve) => {
      setTimeout(resolve, 950);
    });
    await settle();
    expect(document.querySelector('.settings-page')).toBeNull();
    expect(repoRows()).toHaveLength(0);
    expect(bodyText()).toContain('还没有监控仓库');
  });
});
