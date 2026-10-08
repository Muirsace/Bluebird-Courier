// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import type { RenderResult, StubHandle } from './helpers';
import type { AccessTokenState, TokenOperationResult } from '../../src/shared/types';
import {
  bodyText,
  buttonByText,
  click,
  createStub,
  makeGlance,
  navButton,
  openRepo,
  renderApp,
  repoRows,
  resetReducedMotion,
  resetSystemTheme,
  setViewportWidth,
  settle,
  submitForm,
  typeInto,
} from './helpers';

let view: RenderResult | null = null;

beforeEach(() => {
  setViewportWidth(1152);
  resetSystemTheme();
});

afterEach(async () => {
  await view?.unmount();
  view = null;
  onlineManager.setOnline(true);
  setViewportWidth(768);
  resetReducedMotion();
});

const REPO = 'octocat/Hello-World';

/**
 * 本单命名 IPC 的局部替身：begin / confirm / cancel 独立计数并记录入参。
 * 不覆盖全局 helper，只包装这些命名方法，保证"begin/validate 未被调用"能被实证。
 */
interface TokenBridge {
  state: { began: number; confirmed: string[]; cancelled: number };
  /** 下一次 confirm 的返回；同时可作为延迟挂起的目标。 */
  setConfirmResult(result: TokenOperationResult): void;
  /** 挂起下一次 confirm；返回放行函数。 */
  holdConfirm(): () => void;
}

function installTokenBridge(handle: StubHandle): TokenBridge {
  const state = { began: 0, confirmed: [] as string[], cancelled: 0 };
  let nextConfirm: TokenOperationResult = { ok: true, state: 'completed', error: null };
  let confirmGate: Promise<void> | null = null;
  handle.api.beginTokenReplacement = async () => {
    state.began += 1;
    return { ok: true, state: 'awaiting_confirmation', error: null };
  };
  handle.api.confirmTokenReplacement = async (token: string) => {
    state.confirmed.push(token);
    const gate = confirmGate;
    confirmGate = null;
    if (gate) await gate;
    return nextConfirm;
  };
  handle.api.cancelTokenReplacement = async () => {
    state.cancelled += 1;
    return { ok: true, state: 'idle', error: null };
  };
  return {
    state,
    setConfirmResult(result) {
      nextConfirm = result;
    },
    holdConfirm() {
      let release = (): void => {};
      confirmGate = new Promise<void>((resolve) => {
        release = () => {
          confirmGate = null;
          resolve();
        };
      });
      return release;
    },
  };
}

/** 让主进程此后如实返回持久清理意图（重启 / 清理未完成时的权威状态）。 */
function setCleanupPending(handle: StubHandle, pending: boolean, revision: number): void {
  handle.api.accessTokenState = async () => ({
    configured: true,
    cleanupPending: pending,
    accessContextRevision: revision,
  });
}

function tokenInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('#accessToken-input');
}

function cleanupPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.settings-cleanup-pending');
}

function detailHeader(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.repository-header');
}

async function mount(handle: StubHandle): Promise<void> {
  view = await renderApp(handle);
  await settle();
}

async function openSettings(): Promise<void> {
  await click(navButton('设置'));
  await settle();
}

async function beginReplacement(handle: StubHandle, token: string): Promise<TokenBridge> {
  const bridge = installTokenBridge(handle);
  await typeInto(tokenInput()!, token);
  await submitForm(tokenInput()!.form!);
  await settle();
  return bridge;
}

const COMMITTED_PENDING: TokenOperationResult = {
  ok: false,
  state: 'failed',
  error: { kind: 'unknown', message: '访问令牌已更换，但本地资料清理未完成，请重试更换确认以完成清理' },
  tokenCommitted: true,
  cleanupPending: true,
  accessContextRevision: 2,
};

const COMMITTED_DONE: TokenOperationResult = {
  ok: true,
  state: 'completed',
  error: null,
  tokenCommitted: true,
  cleanupPending: false,
  accessContextRevision: 2,
};

async function releaseAndSettle(release: () => void): Promise<void> {
  await act(async () => release());
  await settle();
}

/** 推进成功提示的等待期，验证是否发生自动导航。 */
async function passSuccessWindow(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 950));
  });
  await settle();
}

describe('令牌已提交但清理未完成', () => {
  it('已提交且清理失败：旧上下文退出展示、给出准确文案且可无输入重试', async () => {
    const handle = createStub({ repositories: [makeGlance(1, REPO)] });
    await mount(handle);
    await openRepo(REPO);
    expect(detailHeader()).not.toBeNull();
    expect(view!.queryClient.getQueryData(['detail', 1])).toBeDefined();

    await openSettings();
    const bridge = await beginReplacement(handle, 'ghp_replacement');
    // 主进程已经提交新令牌与上下文，但跨 feature 清理没做完
    setCleanupPending(handle, true, 2);
    bridge.setConfirmResult(COMMITTED_PENDING);
    await click(buttonByText('确认更换'));
    await settle();

    // 准确的产品文案：不宣称更换未生效，也不宣称资料已清理
    expect(cleanupPanel()).not.toBeNull();
    expect(cleanupPanel()?.textContent).toContain('令牌已更换，本地资料清理未完成');
    expect(bodyText()).not.toContain('令牌无效');
    // 不再要求输入 / 再次确认更换
    expect(tokenInput()).toBeNull();
    expect(buttonByText('确认更换')).toBeNull();
    expect(buttonByText('重试清理')).not.toBeNull();
    // 旧 details Query 已退出展示上下文
    expect(detailHeader()).toBeNull();
    expect(view!.queryClient.getQueryData(['detail', 1])).toBeUndefined();

    // 无输入重试清理：confirm 只收到空值，不经过 begin / 网络校验
    handle.setRepositories([]);
    setCleanupPending(handle, false, 2);
    bridge.setConfirmResult(COMMITTED_DONE);
    await click(buttonByText('重试清理'));
    await settle();

    expect(bridge.state.confirmed).toEqual(['ghp_replacement', '']);
    expect(bridge.state.began).toBe(1);
    expect(handle.calls.validateAccessToken).toBe(0);
    expect(cleanupPanel()).toBeNull();
    expect(bodyText()).toContain('本地资料清理已完成');
  });

  it('应用重启即处于持久 pending：直接显示恢复入口，无需新令牌', async () => {
    const handle = createStub({ repositories: [makeGlance(1, REPO)] });
    setCleanupPending(handle, true, 5);
    const bridge = installTokenBridge(handle);
    await mount(handle);

    // 入口收敛到设置页的清理恢复；旧清单不闪现，也不自动抓取
    expect(cleanupPanel()).not.toBeNull();
    expect(bodyText()).toContain('令牌已更换，本地资料清理未完成');
    expect(repoRows()).toHaveLength(0);
    expect(document.querySelector('.watchlist-page')).toBeNull();
    expect(handle.calls.fetchDetail).toBe(0);
    expect(tokenInput()).toBeNull();

    setCleanupPending(handle, false, 5);
    bridge.setConfirmResult({ ok: true, state: 'completed', error: null, tokenCommitted: true, cleanupPending: false, accessContextRevision: 5 });
    await click(buttonByText('重试清理'));
    await settle();

    // 只重试清理：空值 confirm，没有 begin 也没有真实网络校验
    expect(bridge.state.confirmed).toEqual(['']);
    expect(bridge.state.began).toBe(0);
    expect(handle.calls.validateAccessToken).toBe(0);
    expect(cleanupPanel()).toBeNull();
    expect(bodyText()).toContain('本地资料清理已完成');
  });

  it('重试仍失败保持 pending 且可再次重试，成功才解除', async () => {
    const handle = createStub({ repositories: [] });
    setCleanupPending(handle, true, 6);
    const bridge = installTokenBridge(handle);
    await mount(handle);

    bridge.setConfirmResult(COMMITTED_PENDING);
    await click(buttonByText('重试清理'));
    await settle();
    // 失败的原始文案不猜测状态：仍显示待清理入口，可再次重试
    expect(cleanupPanel()).not.toBeNull();
    expect(buttonByText('重试清理')).not.toBeNull();
    expect(bodyText()).not.toContain('请重试更换确认');

    setCleanupPending(handle, false, 6);
    bridge.setConfirmResult({ ok: true, state: 'completed', error: null, tokenCommitted: true, cleanupPending: false, accessContextRevision: 6 });
    await click(buttonByText('重试清理'));
    await settle();

    expect(bridge.state.confirmed).toEqual(['', '']);
    expect(cleanupPanel()).toBeNull();
    expect(bodyText()).toContain('本地资料清理已完成');
  });
});

describe('已提交事实与表单生命周期解耦', () => {
  it('确认在途编辑输入后迟到的已提交仍清旧上下文，且不导航覆盖新意图', async () => {
    const handle = createStub({ repositories: [makeGlance(1, REPO)] });
    await mount(handle);
    await openRepo(REPO);
    await openSettings();
    const bridge = await beginReplacement(handle, 'ghp_replacement');
    setCleanupPending(handle, true, 2);

    const release = bridge.holdConfirm();
    bridge.setConfirmResult(COMMITTED_PENDING);
    await click(buttonByText('确认更换'));
    // 编辑输入 = 回收当前更换意图（真实取消主进程 awaiting）
    await typeInto(tokenInput()!, 'ghp_edited_later');
    expect(bridge.state.cancelled).toBe(1);
    await releaseAndSettle(release);

    // 已提交是不可逆事实：旧上下文的详情 Query 被清掉，不保留旧 context
    expect(view!.queryClient.getQueryData(['detail', 1])).toBeUndefined();
    // 不因旧回包导航覆盖新意图，也不谎称更换验证成功
    expect(bodyText()).not.toContain('令牌已更换并验证');
    expect(cleanupPanel()).not.toBeNull();
    await passSuccessWindow();
    expect(document.querySelector('.settings-page')).not.toBeNull();
  });

  it('确认在途离开设置页：迟到的已提交清旧上下文并落回恢复入口，不回填旧页面状态', async () => {
    setViewportWidth(768);
    const handle = createStub({ repositories: [makeGlance(1, REPO)] });
    await mount(handle);
    await openRepo(REPO);
    await openSettings();
    const bridge = await beginReplacement(handle, 'ghp_replacement');
    setCleanupPending(handle, true, 3);

    const release = bridge.holdConfirm();
    bridge.setConfirmResult({ ...COMMITTED_PENDING, accessContextRevision: 3 });
    await click(buttonByText('确认更换'));
    await click(navButton('监控清单'));
    await settle();
    expect(bridge.state.cancelled).toBe(1);
    expect(document.querySelector('.settings-page')).toBeNull();

    await releaseAndSettle(release);

    // 已提交 + 待清理：落回清理恢复入口，旧详情不再挂在工作区
    expect(detailHeader()).toBeNull();
    expect(view!.queryClient.getQueryData(['detail', 1])).toBeUndefined();
    expect(cleanupPanel()).not.toBeNull();
    // 卸载后的旧表单状态没有被回填：没有成功文案、也没有令牌输入
    expect(bodyText()).not.toContain('令牌已更换并验证');
    expect(tokenInput()).toBeNull();
  });
});

describe('权威 pending 状态不被迟到回包覆盖', () => {
  it('旧已完成状态读取不能撤销更新上下文的待清理状态', async () => {
    const handle = createStub({ repositories: [] });
    setCleanupPending(handle, false, 7);
    await mount(handle);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    handle.api.accessTokenState = async () => {
      await gate;
      return { configured: true, cleanupPending: false, accessContextRevision: 7 };
    };
    await act(async () => { void view!.queryClient.refetchQueries({ queryKey: ['accessTokenState'] }); });
    await act(async () => { view!.queryClient.setQueryData(['accessTokenState'], {
      configured: true, cleanupPending: true, accessContextRevision: 8,
    }); });
    await settle();
    expect(cleanupPanel()).not.toBeNull();
    await releaseAndSettle(release);
    expect(view!.queryClient.getQueryData<AccessTokenState>(['accessTokenState'])?.accessContextRevision).toBe(8);
    expect(cleanupPanel()).not.toBeNull();
  });

  it.each([7, undefined])('旧成功确认不覆盖更新的待清理状态，也不清掉更新的Query（版本=%s）', async (staleRevision) => {
    const handle = createStub({ repositories: [] });
    setCleanupPending(handle, false, 7);
    await mount(handle);
    await openSettings();
    const bridge = await beginReplacement(handle, 'ghp_old_request');
    bridge.setConfirmResult({ ...COMMITTED_DONE, accessContextRevision: staleRevision });
    const release = bridge.holdConfirm();
    await click(buttonByText('确认更换'));
    let releaseState = (): void => {};
    const gate = new Promise<void>((resolve) => { releaseState = resolve; });
    handle.api.accessTokenState = async () => {
      await gate;
      return { configured: true, cleanupPending: true, accessContextRevision: 8 };
    };
    await act(async () => {
      view!.queryClient.setQueryData(['accessTokenState'], { configured: true, cleanupPending: true, accessContextRevision: 8 });
      view!.queryClient.setQueryData(['detail', 99], { accessContextRevision: 8, marker: 'new-context' });
    });
    await settle();
    await releaseAndSettle(release);
    expect(view!.queryClient.getQueryData<AccessTokenState>(['accessTokenState'])?.accessContextRevision).toBe(8);
    expect(view!.queryClient.getQueryData(['detail', 99])).toEqual({ accessContextRevision: 8, marker: 'new-context' });
    expect(cleanupPanel()).not.toBeNull();
    await releaseAndSettle(releaseState);
  });

  it('旧清理重试完成不能解除后来上下文的清理义务', async () => {
    const handle = createStub({ repositories: [] });
    setCleanupPending(handle, true, 7);
    const bridge = installTokenBridge(handle);
    await mount(handle);
    bridge.setConfirmResult({ ...COMMITTED_DONE, accessContextRevision: 7 });
    const release = bridge.holdConfirm();
    await click(buttonByText('重试清理'));
    setCleanupPending(handle, true, 8);
    await act(async () => { view!.queryClient.setQueryData(['accessTokenState'], {
      configured: true, cleanupPending: true, accessContextRevision: 8,
    }); });
    await settle();
    await releaseAndSettle(release);
    expect(view!.queryClient.getQueryData<AccessTokenState>(['accessTokenState'])?.accessContextRevision).toBe(8);
    expect(cleanupPanel()).not.toBeNull();
    expect(bodyText()).not.toContain('本地资料清理已完成');
  });

  it.each([7, 6])('同版本或更旧的旧 pending 回包（revision=%i）晚到不恢复已完成清理', async (staleRevision) => {
    const handle = createStub({ repositories: [] });
    setCleanupPending(handle, true, 7);
    const bridge = installTokenBridge(handle);
    await mount(handle);
    expect(cleanupPanel()).not.toBeNull();

    // 让令牌状态的下一次读取挂起并返回一份过时的 pending
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    handle.api.accessTokenState = async (): Promise<AccessTokenState> => {
      await gate;
      return { configured: true, cleanupPending: true, accessContextRevision: staleRevision };
    };

    setCleanupPending(handle, false, 7);
    bridge.setConfirmResult({ ok: true, state: 'completed', error: null, tokenCommitted: true, cleanupPending: false, accessContextRevision: 7 });
    await click(buttonByText('重试清理'));
    await settle();
    expect(cleanupPanel()).toBeNull();

    await releaseAndSettle(release);

    // 权威完成状态不被同版本 / 更旧的旧 pending 回包覆盖
    expect(cleanupPanel()).toBeNull();
    expect(bodyText()).toContain('本地资料清理已完成');
  });
});

describe('App 旧选中详情退出展示', () => {
  it('离开设置后的迟到已完成更换也撤下旧选中详情', async () => {
    setViewportWidth(768);
    const handle = createStub({ repositories: [makeGlance(1, REPO)] });
    await mount(handle);
    await openRepo(REPO);
    await openSettings();
    const bridge = await beginReplacement(handle, 'ghp_committed_later');
    bridge.setConfirmResult(COMMITTED_DONE);
    const release = bridge.holdConfirm();
    await click(buttonByText('确认更换'));
    await click(navButton('监控清单'));
    await settle();
    await openRepo(REPO);
    expect(detailHeader()).not.toBeNull();
    handle.setRepositories([]);
    setCleanupPending(handle, false, 2);
    await releaseAndSettle(release);
    expect(detailHeader()).toBeNull();
    expect(document.querySelector('.detail-page')).toBeNull();
    expect(bodyText()).toContain('还没有监控仓库');
  });

  it('已提交后旧 list / detail 的迟到 Promise 不能恢复旧上下文展示', async () => {
    const handle = createStub({ repositories: [makeGlance(1, REPO)] });
    await mount(handle);
    await openRepo(REPO);
    expect(detailHeader()).not.toBeNull();
    await openSettings();

    const bridge = await beginReplacement(handle, 'ghp_replacement');
    setCleanupPending(handle, true, 4);
    // 一份旧上下文的清单读取在途：提交后的重置会触发读取，这里让它迟到返回旧内容
    const releaseList = handle.holdNextList();
    bridge.setConfirmResult({ ...COMMITTED_PENDING, accessContextRevision: 4 });
    await click(buttonByText('确认更换'));
    await settle();

    // 旧详情不再挂在工作区，侧栏也不再展示旧清单
    expect(detailHeader()).toBeNull();
    expect(document.querySelector('.watchlist-page')).toBeNull();

    await releaseAndSettle(releaseList);

    // 迟到的旧上下文回包不能把旧仓库 / 旧详情带回界面
    expect(repoRows()).toHaveLength(0);
    expect(detailHeader()).toBeNull();
    expect(view!.queryClient.getQueryData(['detail', 1])).toBeUndefined();
  });

  it('清理失败期间清单导航不可用，成功清理后按安全节奏回到清单', async () => {
    setViewportWidth(768);
    const handle = createStub({ repositories: [makeGlance(1, REPO)] });
    await mount(handle);
    await openSettings();
    const bridge = await beginReplacement(handle, 'ghp_replacement');
    setCleanupPending(handle, true, 8);
    bridge.setConfirmResult({ ...COMMITTED_PENDING, accessContextRevision: 8 });
    await click(buttonByText('确认更换'));
    await settle();

    // 待清理期间不提供会落到空白清单的入口
    expect(navButton('监控清单')?.disabled).toBe(true);

    handle.setRepositories([]);
    setCleanupPending(handle, false, 8);
    bridge.setConfirmResult({ ok: true, state: 'completed', error: null, tokenCommitted: true, cleanupPending: false, accessContextRevision: 8 });
    await click(buttonByText('重试清理'));
    await settle();

    expect(navButton('监控清单')?.disabled).toBe(false);
    await passSuccessWindow();
    expect(document.querySelector('.settings-page')).toBeNull();
    expect(bodyText()).toContain('还没有监控仓库');
  });
});

describe('旧返回字段缺省保持既有语义', () => {
  it('缺省 tokenCommitted 的成功确认仍按 ok 处理并清旧上下文', async () => {
    const handle = createStub({ repositories: [makeGlance(1, REPO)] });
    await mount(handle);
    await openRepo(REPO);
    await openSettings();
    const bridge = await beginReplacement(handle, 'ghp_replacement');

    handle.setRepositories([]);
    bridge.setConfirmResult({ ok: true, state: 'completed', error: null });
    await click(buttonByText('确认更换'));
    await settle();

    expect(bodyText()).toContain('令牌已更换并验证');
    expect(view!.queryClient.getQueryData(['detail', 1])).toBeUndefined();
    await passSuccessWindow();
    expect(document.querySelector('.settings-page')).toBeNull();
    expect(repoRows()).toHaveLength(0);
  });

  it('缺省新字段的验证失败保留原令牌与旧资料，不清理', async () => {
    const handle = createStub({ repositories: [makeGlance(1, REPO)] });
    await mount(handle);
    await openRepo(REPO);
    await openSettings();
    const bridge = await beginReplacement(handle, 'ghp_first_try');

    bridge.setConfirmResult({ ok: false, state: 'failed', error: { kind: 'access_token_invalid', message: 'Bad credentials' } });
    await click(buttonByText('确认更换'));
    await settle();

    expect(bodyText()).toContain('令牌无效或已过期，请检查后重试');
    expect(view!.queryClient.getQueryData(['detail', 1])).toBeDefined();
    // 失败不是死状态：面板保留可重试，旧资料未清理
    expect(buttonByText('确认更换')).not.toBeNull();
    expect(cleanupPanel()).toBeNull();
  });
});
