import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, TransitionEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NormalizedError, AccessTokenResult } from '../../shared/types';
import { getApi } from '../lib/api';
import { prefersReducedMotion } from '../lib/motion';
import { SettingSection } from '../components/SettingSection';
import { Spinner } from '../components/Spinner';
import { ThemeSelector } from '../components/ThemeSelector';
import { InlineFeedback } from '../components/StateMessage';

interface SettingsPageProps {
  /** 令牌保存并验证成功后调用（App 负责跳转到监控清单）。 */
  onSaved: () => void;
}

const SUCCESS_SAVED = '令牌已保存并验证';
const SUCCESS_VALIDATED = 'GitHub 连接正常';

type TokenFeedback = { kind: 'success' | 'error'; message: string };

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

export function SettingsPage({ onSaved }: SettingsPageProps) {
  const queryClient = useQueryClient();
  const accessTokenStateQuery = useQuery({
    queryKey: ['accessTokenState'],
    queryFn: () => getApi().accessTokenState(),
  });
  const configured = accessTokenStateQuery.data?.configured ?? false;

  const [accessToken, setAccessToken] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [feedback, setFeedback] = useState<TokenFeedback | null>(null);
  const [renderedFeedback, setRenderedFeedback] = useState<TokenFeedback | null>(null);
  const [pendingOperation, setPendingOperation] = useState<'saving' | 'validating' | null>(null);
  const accessTokenValueRef = useRef('');
  const requestIdRef = useRef(0);
  const savedTimerRef = useRef<number | null>(null);
  const onSavedRef = useRef(onSaved);
  useLayoutEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
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

  function handleTokenChange(value: string): void {
    accessTokenValueRef.current = value;
    requestIdRef.current += 1;
    setAccessToken(value);
    updateFeedback(null);
    // 验证当前输入时允许继续编辑；一旦输入变化，旧请求的结果与 loading 状态都失效。
    if (pendingOperation === 'validating') setPendingOperation(null);
  }

  async function handleSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pendingOperation !== null) return;
    const value = accessToken.trim();
    if (!value) {
      showError('请输入访问令牌');
      return;
    }
    const requestId = ++requestIdRef.current;
    setPendingOperation('saving');
    updateFeedback(null);
    try {
      const result = await getApi().saveAccessToken(value);
      if (!isCurrentRequest(requestId, value)) return;
      if (result.ok) {
        updateFeedback({ kind: 'success', message: SUCCESS_SAVED });
        accessTokenValueRef.current = '';
        setAccessToken('');
        setRevealed(false);
        queryClient.setQueryData(['accessTokenState'], { configured: true });
        void queryClient.invalidateQueries({ queryKey: ['accessTokenState'] });
        // 让成功提示可见后再跳转
        if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = window.setTimeout(() => {
          savedTimerRef.current = null;
          onSavedRef.current();
        }, 900);
      } else {
        updateFeedback({ kind: 'error', message: tokenErrorMessage(errorFrom(result)) });
      }
    } catch {
      if (isCurrentRequest(requestId, value)) showError('保存失败，请稍后重试');
    } finally {
      if (requestIdRef.current === requestId) setPendingOperation(null);
    }
  }

  async function handleValidate(): Promise<void> {
    if (pendingOperation !== null) return;
    const value = accessToken.trim();
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

  const busy = pendingOperation !== null;

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
            {accessTokenStateQuery.isPending ? (
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
            {accessTokenStateQuery.isError ? (
              <button
                type="button"
                onClick={() => void accessTokenStateQuery.refetch()}
                className="inline-flex h-8 items-center rounded border border-default px-2 text-xs text-secondary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active"
              >
                重新读取
              </button>
            ) : null}
          </div>
        </div>

        <form onSubmit={handleSave} className="mt-4">
          <div className="space-y-3">
            <div className="min-w-0">
              <div className="settings-token-input-wrap">
                <input
                  id="accessToken-input"
                  aria-label="Personal Access Token"
                  type={revealed ? 'text' : 'password'}
                  value={accessToken}
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
      </SettingSection>
    </div>
  );
}
