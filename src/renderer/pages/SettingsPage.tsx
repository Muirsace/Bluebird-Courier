import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, TransitionEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AccessTokenState, NormalizedError, AccessTokenResult, TokenOperationResult } from '../../shared/types';
import { getApi } from '../lib/api';
import { publishAccessTokenState, useAccessTokenState } from '../lib/access-token-state';
import { prefersReducedMotion } from '../lib/motion';
import { SettingSection } from '../components/SettingSection';
import { Spinner } from '../components/Spinner';
import { ThemeSelector } from '../components/ThemeSelector';
import { InlineFeedback } from '../components/StateMessage';

interface SettingsPageProps {
  /** 令牌保存或更换成功后调用（App 负责跳转到监控清单）。 */
  onSaved: () => void;
}

const SUCCESS_SAVED = '令牌已保存并验证';
const SUCCESS_REPLACED = '令牌已更换并验证';
const SUCCESS_VALIDATED = 'GitHub 连接正常';
const SUCCESS_CLEANED = '本地资料清理已完成';
const CLEANUP_PENDING_MESSAGE = '令牌已更换，本地资料清理未完成';
const CLEANUP_PENDING_HINT = '完成清理前不会展示旧访问上下文的本地资料；恢复清理不需要重新输入令牌。';

type TokenFeedback = { kind: 'success' | 'error'; message: string };
/** saving / validating 是首次保存与测试连接；更换流程有独立生命周期，不在这里表达。 */
type PendingOperation = 'saving' | 'validating' | null;
/** 更换生命周期阶段：starting 主进程登记中，awaiting 等待用户确认，verifying 确认请求在途。 */
type ReplacementStage = 'starting' | 'awaiting' | 'verifying';
/** 开始登记到完成/取消全过程：代号唯一标识一次更换，异步续跑按它判断是否仍属于自己。 */
interface ReplacementLifecycle {
  generation: number;
  stage: ReplacementStage;
  token: string;
}

interface ReplacementApi {
  begin(): Promise<TokenOperationResult>;
  confirm(token: string): Promise<TokenOperationResult>;
  cancel(): Promise<TokenOperationResult>;
}

/** 更换流程使用主进程的三个命名桥接方法；缺少任一方法时流程整体不可用。 */
function replacementApi(): ReplacementApi | null {
  const { beginTokenReplacement, confirmTokenReplacement, cancelTokenReplacement } = getApi();
  if (!beginTokenReplacement || !confirmTokenReplacement || !cancelTokenReplacement) return null;
  return {
    begin: () => beginTokenReplacement(),
    confirm: (token) => confirmTokenReplacement(token),
    cancel: () => cancelTokenReplacement(),
  };
}

function tokenErrorMessage(error: NormalizedError): string {
  switch (error.kind) {
    case 'access_token_invalid':
      return '令牌无效或已过期，请检查后重试';
    case 'network':
      return '无法连接 GitHub，请检查网络后重试';
    case 'not_found':
      return '当前令牌权限不足，请检查令牌权限';
    case 'rate_limited':
      return 'GitHub 请求频率受限，请稍后再试';
    case 'unknown': {
      const message = error.message.trim();
      // 不把底层 HTTP / fetch 错误直接暴露在设置界面。
      if (/\bHTTP\s+\d{3}\b|Bad credentials|ECONNRESET/i.test(message)) {
        return '无法完成操作，请稍后重试';
      }
      return message || '无法完成操作，请稍后重试';
    }
  }
}

function errorFrom(result: AccessTokenResult): NormalizedError {
  return result.error ?? { kind: 'unknown', message: '操作失败，请稍后重试' };
}

/**
 * 本次确认/清理重试对应的令牌与访问上下文是否已提交。
 *
 * 新返回用 tokenCommitted 明确表达“已提交但清理可能失败”；字段缺省的旧返回里，
 * 只有 ok=true 的确认才算已提交（begin/cancel 的 ok=true 不代表提交）。
 */
function isCommitted(result: TokenOperationResult): boolean {
  return result.tokenCommitted === true || (result.tokenCommitted === undefined && result.ok === true);
}

/** 令牌已提交但持久清理意图仍未完成；ok=false 的已提交结果也属于待清理。 */
function isCleanupPending(result: TokenOperationResult): boolean {
  return isCommitted(result) && (result.cleanupPending === true || result.ok !== true);
}

export function SettingsPage({ onSaved }: SettingsPageProps) {
  const queryClient = useQueryClient();
  const accessToken = useAccessTokenState();
  const configured = accessToken.configured;
  /** 持久清理意图：令牌与上下文已提交但旧资料清理未完成，重启后仍成立。 */
  const cleanupPending = accessToken.cleanupPending;

  const [accessTokenValue, setAccessTokenValue] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [feedback, setFeedback] = useState<TokenFeedback | null>(null);
  const [renderedFeedback, setRenderedFeedback] = useState<TokenFeedback | null>(null);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation>(null);
  /** 更换流程的渲染镜像；权威值始终在 replacementRef，避免异步续跑读到过期闭包。 */
  const [replacement, setReplacement] = useState<{ stage: ReplacementStage; token: string } | null>(null);
  /** 清理恢复入口的请求在途镜像；与更换生命周期分开，重启后没有前一次更换的局部状态。 */
  const [retryingCleanup, setRetryingCleanup] = useState(false);
  const accessTokenValueRef = useRef('');
  /** 当前更换生命周期（含 starting 阶段）；null 表示没有未收尾的更换。 */
  const replacementRef = useRef<ReplacementLifecycle | null>(null);
  const replacementSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const savedTimerRef = useRef<number | null>(null);
  const onSavedRef = useRef(onSaved);
  useLayoutEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
      // 离开页面即回收未收尾的更换（含登记中的）：作废在途续跑并让主进程清掉 awaiting。
      if (replacementRef.current !== null) {
        replacementRef.current = null;
        void replacementApi()?.cancel().catch(() => {});
      }
    };
  }, []);

  function showError(message: string): void {
    updateFeedback({ kind: 'error', message });
  }

  function updateFeedback(next: TokenFeedback | null): void {
    if (next !== null) {
      setRenderedFeedback(next);
    } else if (prefersReducedMotion()) {
      // Reduced Motion 下没有退出过渡，关闭时无需保留内容。
      setRenderedFeedback(null);
    }
    setFeedback(next);
  }

  function handleFeedbackTransitionEnd(event: TransitionEvent<HTMLDivElement>): void {
    if (
      event.target === event.currentTarget &&
      event.propertyName === 'grid-template-rows' &&
      feedback === null
    ) {
      setRenderedFeedback(null);
    }
  }

  function isCurrentRequest(requestId: number, value: string): boolean {
    return requestIdRef.current === requestId && accessTokenValueRef.current.trim() === value;
  }

  /** 异步续跑是否仍属于当前这次更换；被取代、被回收或已卸载都会返回 false。 */
  function isCurrentReplacement(generation: number): boolean {
    return replacementRef.current?.generation === generation;
  }

  /** 真实回收当前更换意图：作废所有在途续跑，并让主进程清掉已登记的 awaiting。 */
  function reclaimReplacement(): void {
    replacementRef.current = null;
    setReplacement(null);
    void replacementApi()?.cancel().catch(() => {});
  }

  function handleTokenChange(value: string): void {
    accessTokenValueRef.current = value;
    requestIdRef.current += 1;
    setAccessTokenValue(value);
    updateFeedback(null);
    // 验证当前输入时允许继续编辑；一旦输入变化，旧请求的结果与 loading 状态都失效。
    if (pendingOperation === 'validating') setPendingOperation(null);
    // 输入的令牌已改变：登记中/待确认/确认在途的更换都不再对应当前输入，真实回收并恢复可操作状态。
    if (replacementRef.current !== null) reclaimReplacement();
  }

  /** 首次配置：验证并保存，不做任何清理（本地不存在旧资料）。 */
  async function handleFirstSave(value: string): Promise<void> {
    const requestId = ++requestIdRef.current;
    setPendingOperation('saving');
    updateFeedback(null);
    try {
      const result = await getApi().saveAccessToken(value);
      if (!isCurrentRequest(requestId, value)) return;
      if (result.ok) {
        updateFeedback({ kind: 'success', message: SUCCESS_SAVED });
        accessTokenValueRef.current = '';
        setAccessTokenValue('');
        setRevealed(false);
        queryClient.setQueryData(['accessTokenState'], { configured: true });
        void queryClient.invalidateQueries({ queryKey: ['accessTokenState'] });
        scheduleOnSaved();
      } else {
        updateFeedback({ kind: 'error', message: tokenErrorMessage(errorFrom(result)) });
      }
    } catch {
      if (isCurrentRequest(requestId, value)) showError('保存失败，请稍后重试');
    } finally {
      if (requestIdRef.current === requestId) setPendingOperation(null);
    }
  }

  /** 已配置令牌：先向后端登记更换意图，由用户确认后才会真正验证与提交。 */
  async function beginReplacement(value: string): Promise<void> {
    const api = replacementApi();
    if (!api) {
      showError('当前应用不支持更换访问令牌，请重启后再试');
      return;
    }
    // 登记先于 await：登记中的编辑或离开也回收得到这次意图。
    const generation = ++replacementSeqRef.current;
    replacementRef.current = { generation, stage: 'starting', token: value };
    setReplacement({ stage: 'starting', token: value });
    updateFeedback(null);
    try {
      const begun = await api.begin();
      // 已被取消、被输入变化回收或被更新的操作取代：不改变任何界面状态，也不去取消更新的操作。
      if (!isCurrentReplacement(generation)) return;
      if (!begun.ok) {
        replacementRef.current = null;
        setReplacement(null);
        showError(tokenErrorMessage(errorFrom(begun)));
        return;
      }
      replacementRef.current = { generation, stage: 'awaiting', token: value };
      setReplacement({ stage: 'awaiting', token: value });
    } catch {
      if (!isCurrentReplacement(generation)) return;
      replacementRef.current = null;
      setReplacement(null);
      showError('无法开始更换流程，请稍后重试');
    }
  }

  async function handleSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pendingOperation !== null || replacement !== null) return;
    const value = accessTokenValue.trim();
    if (!value) {
      showError('请输入访问令牌');
      return;
    }
    if (configured) {
      await beginReplacement(value);
      return;
    }
    await handleFirstSave(value);
  }

  /**
   * 用户确认更换：后端先网络验证，成功后在同步事务里保存新令牌并推进访问上下文。
   *
   * tokenCommitted=true 是本次操作对应的令牌与上下文已提交的事实：清理失败也成立。
   * 因此判定已提交不能用 result.ok（ok=false 只说明后续清理没做完），也不能缺省字段时丢行为。
   */
  async function handleConfirmReplace(): Promise<void> {
    const current = replacementRef.current;
    if (!current || current.stage !== 'awaiting') return;
    const api = replacementApi();
    if (!api) return;
    const { generation, token } = current;
    const interactionVersion = requestIdRef.current;
    replacementRef.current = { generation, stage: 'verifying', token };
    setReplacement({ stage: 'verifying', token });
    updateFeedback(null);
    try {
      const result = await api.confirm(token);
      if (isCommitted(result)) {
        // 已提交是不可逆事实：与表单是否还有效、页面是否还在无关，先按事实协调旧上下文。
        if (!await coordinateCommittedReplacement(result)) {
          if (mountedRef.current && isCurrentReplacement(generation)) {
            replacementRef.current = null;
            setReplacement(null);
          }
          return;
        }
        const mine = isCurrentReplacement(generation);
        if (!mountedRef.current) return;
        if (!isCleanupPending(result)) {
          if (mine) {
            replacementRef.current = null;
            setReplacement(null);
            accessTokenValueRef.current = '';
            setAccessTokenValue('');
            setRevealed(false);
          }
          // 表单已被取消/改动/离开时也要如实告知：更换已经生效，旧资料已清理。
          updateFeedback({ kind: 'success', message: SUCCESS_REPLACED });
          if (mine && replacementSeqRef.current === generation && requestIdRef.current === interactionVersion) scheduleOnSaved();
          return;
        }
        // 令牌已提交但清理未完成：不宣称验证失败、不导航；恢复入口由权威 pending 状态驱动。
        if (mine) {
          replacementRef.current = null;
          setReplacement(null);
        }
        return;
      }
      // 失败（含验证被取消/被取代）：原令牌与本地资料保留，只有仍属于当前操作时才回到可重试状态。
      if (!isCurrentReplacement(generation)) return;
      replacementRef.current = { generation, stage: 'awaiting', token };
      setReplacement({ stage: 'awaiting', token });
      updateFeedback({ kind: 'error', message: tokenErrorMessage(errorFrom(result)) });
    } catch {
      if (!isCurrentReplacement(generation)) return;
      replacementRef.current = { generation, stage: 'awaiting', token };
      setReplacement({ stage: 'awaiting', token });
      showError('更换失败，请稍后重试');
    }
  }

  /**
   * 清理恢复：空令牌只重试清理。不验证、不保存令牌、不推进访问上下文，也不调用 begin。
   * 与更换生命周期无关，因此应用重启、页面刚挂载或前一次更换已收尾时都能直接恢复。
   */
  async function handleRetryCleanup(): Promise<void> {
    if (retryingCleanup) return;
    const api = replacementApi();
    if (!api) {
      showError('当前应用不支持清理访问令牌资料，请重启后再试');
      return;
    }
    const requestId = ++requestIdRef.current;
    setRetryingCleanup(true);
    updateFeedback(null);
    try {
      const result = await api.confirm('');
      // 无论成败，已提交的上下文事实都要协调；空值重试不会再次提交令牌与上下文。
      if (!await coordinateCommittedReplacement(result)) return;
      if (!mountedRef.current || requestIdRef.current !== requestId) return;
      if (result.ok === true && !isCleanupPending(result)) {
        accessToken.resolveCleanup(result.accessContextRevision);
        updateFeedback({ kind: 'success', message: SUCCESS_CLEANED });
        scheduleOnSaved();
      }
    } catch {
      if (mountedRef.current && requestIdRef.current === requestId) {
        // 无法确认清理是否完成：保持恢复入口，可再次重试，不用错误文案猜测状态。
        void accessToken.refetch();
      }
    } finally {
      if (mountedRef.current) setRetryingCleanup(false);
    }
  }

  function handleCancelReplace(): void {
    requestIdRef.current += 1;
    reclaimReplacement();
    updateFeedback(null);
  }

  /**
   * 已提交后的渲染层协调：清掉旧访问上下文的展示数据，在途旧 Promise 一并作废。
   * 与组件状态、表单生命周期、页面是否卸载都无关，因此迟到的已提交回包同样执行。
   */
  async function coordinateCommittedReplacement(result: TokenOperationResult): Promise<boolean> {
    if (!isCommitted(result)) {
      accessToken.refetch();
      return false;
    }
    const pending = isCleanupPending(result);
    const previous = queryClient.getQueryData<AccessTokenState>(['accessTokenState']);
    if (result.accessContextRevision === undefined && previous?.accessContextRevision !== undefined) {
      // 无版本旧回包不能借用当前版本宣告清理完成；只按权威本地状态恢复入口。
      try {
        publishAccessTokenState(queryClient, await getApi().accessTokenState());
      } catch {
        accessToken.refetch();
      }
      return false;
    }
    const accepted = publishAccessTokenState(queryClient, {
      ...(previous ?? { configured: true }),
      configured: true,
      cleanupPending: pending,
      ...(result.accessContextRevision !== undefined
        ? { accessContextRevision: result.accessContextRevision }
        : {}),
    });
    if (!accepted) return false;
    const stillCurrent = (): boolean => {
      const current = queryClient.getQueryData<AccessTokenState>(['accessTokenState']);
      return current?.accessContextRevision === (result.accessContextRevision ?? previous?.accessContextRevision)
        && (!pending || current?.cleanupPending === true);
    };
    void queryClient.invalidateQueries({ queryKey: ['accessTokenState'] });
    // 先取消在途请求，再重置缓存：旧数据立即退出展示，挂载中的视图随即按新上下文重读，
    // 不等下一次无关重渲染（移除查询会让已挂载观察者继续显示已销毁查询里的旧数据）。
    await queryClient.cancelQueries({ queryKey: ['repositories'] });
    if (!stillCurrent()) return false;
    await queryClient.cancelQueries({ queryKey: ['detail'] });
    if (!stillCurrent()) return false;
    await queryClient.cancelQueries({ queryKey: ['trend'] });
    if (!stillCurrent()) return false;
    await queryClient.resetQueries({ queryKey: ['repositories'] });
    if (!stillCurrent()) return false;
    await queryClient.resetQueries({ queryKey: ['detail'] });
    if (!stillCurrent()) return false;
    await queryClient.resetQueries({ queryKey: ['trend'] });
    if (!stillCurrent()) return false;
    if (!pending) accessToken.resolveCleanup(result.accessContextRevision);
    return true;
  }

  /** 让成功提示可见后再跳转。 */
  function scheduleOnSaved(): void {
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    const interactionVersion = requestIdRef.current;
    const replacementGeneration = replacementSeqRef.current;
    savedTimerRef.current = window.setTimeout(() => {
      savedTimerRef.current = null;
      // 成功提示等待期间仍可编辑或发起新操作，旧定时器不能把更新的意图带离页面。
      if (mountedRef.current && requestIdRef.current === interactionVersion && replacementSeqRef.current === replacementGeneration) onSavedRef.current();
    }, 900);
  }

  async function handleValidate(): Promise<void> {
    if (pendingOperation !== null || replacement !== null) return;
    const value = accessTokenValue.trim();
    if (!value) {
      showError('请输入访问令牌');
      return;
    }
    const requestId = ++requestIdRef.current;
    setPendingOperation('validating');
    updateFeedback(null);
    try {
      const result = await getApi().validateAccessToken(value);
      if (!isCurrentRequest(requestId, value)) return;
      if (result.ok) {
        updateFeedback({ kind: 'success', message: SUCCESS_VALIDATED });
      } else {
        updateFeedback({ kind: 'error', message: tokenErrorMessage(errorFrom(result)) });
      }
    } catch {
      if (isCurrentRequest(requestId, value)) {
        showError('无法连接 GitHub，请检查网络后重试');
      }
    } finally {
      if (requestIdRef.current === requestId) setPendingOperation(null);
    }
  }

  const replacing = replacement !== null && replacement.stage !== 'starting' ? replacement : null;
  const busy = pendingOperation !== null || replacement !== null || retryingCleanup;

  return (
    <div className="settings-page max-w-[840px]">
      <h1 className="text-xl font-semibold text-primary">设置</h1>

      <SettingSection title="外观">
        <ThemeSelector />
      </SettingSection>

      <SettingSection title="GitHub">
        <div className="settings-token-heading">
          <h3 className="min-w-0 text-sm font-medium text-secondary">Personal Access Token</h3>
          <div className="flex shrink-0 items-center gap-2">
            {accessToken.isPending ? (
              <span role="status" aria-busy="true" aria-atomic="true" className="flex items-center gap-1.5 text-xs text-muted">
                <Spinner className="h-3.5 w-3.5" /> 读取中…
              </span>
            ) : (
              <span
                className={`inline-flex h-5 items-center rounded-full border px-2 text-[11px] ${
                  configured
                    ? 'border-success/40 bg-success-soft text-success'
                    : 'border-warning/40 bg-warning-soft text-warning'
                }`}
              >
                {configured ? '已配置' : '未配置'}
              </span>
            )}
            {accessToken.isError ? (
              <button
                type="button"
                onClick={() => accessToken.refetch()}
                className="inline-flex h-8 items-center rounded border border-default px-2 text-xs text-secondary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active"
              >
                重新读取
              </button>
            ) : null}
          </div>
        </div>

        {cleanupPending ? (
          <div
            role="group"
            aria-label="本地资料清理"
            className="settings-cleanup-pending mt-4 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5"
          >
            <p className="text-sm font-medium text-secondary">{CLEANUP_PENDING_MESSAGE}</p>
            <p className="mt-1 text-xs text-muted">{CLEANUP_PENDING_HINT}</p>
            <div className="mt-2.5 flex flex-wrap items-start gap-2">
              <button
                type="button"
                onClick={() => void handleRetryCleanup()}
                disabled={retryingCleanup}
                aria-busy={retryingCleanup}
                className="flex h-9 min-w-[8rem] shrink-0 items-center justify-center gap-2 rounded-md bg-accent-solid px-4 text-sm font-medium text-accent-contrast transition-colors duration-150 ease-out hover:bg-accent-solid-hover active:bg-accent-solid-pressed disabled:cursor-not-allowed disabled:opacity-60"
              >
                {retryingCleanup ? (
                  <span aria-hidden="true">
                    <Spinner className="h-3.5 w-3.5" />
                  </span>
                ) : null}
                {retryingCleanup ? '清理中…' : '重试清理'}
              </button>
            </div>
          </div>
        ) : (
        <form onSubmit={handleSave} className="mt-4">
          <div className="space-y-3">
            <div className="min-w-0">
              <div className="settings-token-input-wrap">
                <input
                  id="accessToken-input"
                  aria-label="Personal Access Token"
                  type={revealed ? 'text' : 'password'}
                  value={accessTokenValue}
                  onChange={(event) => handleTokenChange(event.target.value)}
                  disabled={pendingOperation === 'saving'}
                  placeholder="ghp_…"
                  autoComplete="off"
                  className="h-[38px] w-full min-w-0 rounded-md border border-strong bg-app py-0 pl-3 pr-12 font-mono text-sm text-primary placeholder:text-muted transition-colors duration-150 ease-out focus:border-focus disabled:cursor-not-allowed disabled:opacity-70"
                />
                <button
                  type="button"
                  onClick={() => setRevealed((value) => !value)}
                  aria-pressed={revealed}
                  aria-label={revealed ? '隐藏令牌' : '显示令牌'}
                  title={revealed ? '隐藏令牌' : '显示令牌'}
                  data-button-motion="compact"
                  className="settings-token-visibility absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-secondary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active"
                >
                  {revealed ? (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      aria-hidden="true"
                      className="h-[18px] w-[18px]"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 3l18 18M10.6 10.7a2 2 0 002.7 2.7M9.9 5.2A11.3 11.3 0 0112 5c5.2 0 8.7 4.7 9.5 6-.3.5-1.2 1.8-2.8 3.1M6.2 6.2C3.9 7.5 2.7 9.5 2.5 11c.8 1.3 3.9 6 9.5 6 1 0 1.9-.2 2.7-.5"
                      />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      aria-hidden="true"
                      className="h-[18px] w-[18px]"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6z"
                      />
                      <circle cx="12" cy="12" r="2.5" />
                    </svg>
                  )}
                </button>
              </div>
              <p className="mt-3.5 text-xs text-muted">
                令牌仅保存在本机，不会上传到任何服务器。已保存的令牌不会回显。
              </p>
            </div>

            <div className="flex flex-wrap items-start gap-2">
              <button
                type="submit"
                disabled={busy}
                aria-busy={pendingOperation === 'saving'}
                className="flex h-9 min-w-[8.75rem] shrink-0 items-center justify-center gap-2 rounded-md bg-accent-solid px-4 text-sm font-medium text-accent-contrast transition-colors duration-150 ease-out hover:bg-accent-solid-hover active:bg-accent-solid-pressed disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pendingOperation === 'saving' ? (
                  <span aria-hidden="true">
                    <Spinner className="h-3.5 w-3.5" />
                  </span>
                ) : null}
                {pendingOperation === 'saving' ? '验证中…' : '保存并验证'}
              </button>
              <button
                type="button"
                onClick={() => void handleValidate()}
                disabled={busy}
                aria-busy={pendingOperation === 'validating'}
                className="flex h-9 min-w-[8rem] shrink-0 items-center justify-center gap-2 rounded-md border border-default px-4 text-sm text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pendingOperation === 'validating' ? (
                  <span aria-hidden="true">
                    <Spinner className="h-3.5 w-3.5" />
                  </span>
                ) : null}
                {pendingOperation === 'validating' ? '测试中…' : '测试连接'}
              </button>
            </div>

            {replacing !== null ? (
              <div
                role="group"
                aria-label="确认更换访问令牌"
                className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5"
              >
                <p className="text-sm text-secondary">
                  更换访问令牌会连接新的 GitHub 账号。成功更换后会清理本机已保存的仓库资料（监控清单、详情与趋势），需要重新添加仓库。
                </p>
                <div className="mt-2.5 flex flex-wrap items-start gap-2">
                  <button
                    type="button"
                    onClick={() => void handleConfirmReplace()}
                    disabled={replacing.stage === 'verifying'}
                    aria-busy={replacing.stage === 'verifying'}
                    className="flex h-9 min-w-[8rem] shrink-0 items-center justify-center gap-2 rounded-md bg-accent-solid px-4 text-sm font-medium text-accent-contrast transition-colors duration-150 ease-out hover:bg-accent-solid-hover active:bg-accent-solid-pressed disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {replacing.stage === 'verifying' ? (
                      <span aria-hidden="true">
                        <Spinner className="h-3.5 w-3.5" />
                      </span>
                    ) : null}
                    {replacing.stage === 'verifying' ? '验证中…' : '确认更换'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelReplace}
                    className="flex h-9 min-w-[6rem] shrink-0 items-center justify-center rounded-md border border-default px-4 text-sm text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div
            className="github-token-feedback"
            data-open={feedback ? 'true' : 'false'}
            aria-hidden={!feedback}
            onTransitionEnd={handleFeedbackTransitionEnd}
          >
            <div className="github-token-feedback-clip">
              <div className="pt-1.5">
                {renderedFeedback ? (
                  <InlineFeedback
                    announcement={feedback ? (renderedFeedback.kind === 'success' ? 'status' : 'alert') : undefined}
                    tone={renderedFeedback.kind === 'success' ? 'success' : 'danger'}
                    className="settings-inline-status github-token-feedback-status"
                  >
                    <span aria-hidden="true" className="shrink-0 font-medium">
                      {renderedFeedback.kind === 'success' ? '✓' : '⚠'}
                    </span>
                    <span className="min-w-0 break-words">{renderedFeedback.message}</span>
                  </InlineFeedback>
                ) : null}
              </div>
            </div>
          </div>
        </form>
        )}
      </SettingSection>
    </div>
  );
}
