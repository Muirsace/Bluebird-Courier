import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NormalizedError, AccessTokenResult } from '../../shared/types';
import { getApi } from '../lib/api';
import { ErrorBar } from '../components/ErrorBar';
import { SettingSection } from '../components/SettingSection';
import { Spinner } from '../components/Spinner';
import { ThemeSelector } from '../components/ThemeSelector';

interface SettingsPageProps {
  /** 令牌保存并验证成功后调用（App 负责跳转到监控清单）。 */
  onSaved: () => void;
}

const SUCCESS_SAVED = '访问令牌已保存并验证通过';
const SUCCESS_VALIDATED = '访问令牌有效';

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
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<NormalizedError | null>(null);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  function showLocalError(message: string): void {
    setSuccess(null);
    setError({ kind: 'unknown', message });
  }

  async function handleSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = accessToken.trim();
    if (!value) {
      showLocalError('请输入访问令牌');
      return;
    }
    setSaving(true);
    setSuccess(null);
    setError(null);
    try {
      const result = await getApi().saveAccessToken(value);
      if (result.ok) {
        setSuccess(SUCCESS_SAVED);
        setAccessToken('');
        setRevealed(false);
        queryClient.setQueryData(['accessTokenState'], { configured: true });
        void queryClient.invalidateQueries({ queryKey: ['accessTokenState'] });
        // 让成功提示可见后再跳转
        if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = window.setTimeout(() => {
          savedTimerRef.current = null;
          onSaved();
        }, 900);
      } else {
        setError(errorFrom(result));
      }
    } catch {
      showLocalError('保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  }

  async function handleValidate(): Promise<void> {
    const value = accessToken.trim();
    if (!value) {
      showLocalError('请输入访问令牌');
      return;
    }
    setValidating(true);
    setSuccess(null);
    setError(null);
    try {
      const result = await getApi().validateAccessToken(value);
      if (result.ok) {
        setSuccess(SUCCESS_VALIDATED);
      } else {
        setError(errorFrom(result));
      }
    } catch {
      showLocalError('连接失败，请稍后重试');
    } finally {
      setValidating(false);
    }
  }

  return (
    <div className="max-w-[840px] space-y-4">
      <h1 className="text-xl font-semibold text-primary">设置</h1>

      <SettingSection title="外观">
        <ThemeSelector />
      </SettingSection>

      <SettingSection title="GitHub">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-secondary">Personal Access Token</span>
          {accessTokenStateQuery.isPending ? (
            <span className="flex items-center gap-2 text-muted">
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

        <form onSubmit={handleSave} className="mt-3 space-y-3">
          <div>
            <label htmlFor="accessToken-input" className="mb-1 block text-xs text-secondary">
              访问令牌
            </label>
            <div className="flex items-center gap-2">
              <input
                id="accessToken-input"
                type={revealed ? 'text' : 'password'}
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                placeholder="ghp_…"
                autoComplete="off"
                className="h-[38px] w-full min-w-0 flex-1 rounded-md border border-strong bg-app px-3 font-mono text-sm text-primary placeholder:text-muted transition-colors duration-150 ease-out focus:border-accent"
              />
              <button
                type="button"
                onClick={() => setRevealed((value) => !value)}
                aria-pressed={revealed}
                aria-label={revealed ? '隐藏令牌' : '显示令牌'}
                className="h-9 shrink-0 rounded-md border border-default px-3 text-xs text-secondary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active"
              >
                {revealed ? '隐藏' : '显示'}
              </button>
            </div>
            <p className="mt-2 text-xs text-muted">
              令牌只保存在本机，不会上传到任何服务器；已保存的令牌不会回显。
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={saving}
              aria-busy={saving}
              className="flex h-9 min-w-28 items-center justify-center gap-2 rounded-md bg-accent-solid px-4 text-sm font-medium text-accent-contrast transition-colors duration-150 ease-out hover:bg-accent-solid-hover active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
              {saving ? '保存中…' : '保存并验证'}
            </button>
            <button
              type="button"
              onClick={() => void handleValidate()}
              disabled={validating}
              aria-busy={validating}
              className="flex h-9 min-w-28 items-center justify-center gap-2 rounded-md border border-default px-4 text-sm text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60"
            >
              {validating ? <Spinner className="h-3.5 w-3.5" /> : null}
              {validating ? '连接中…' : '测试连接'}
            </button>
          </div>
        </form>

        <div className="mt-3 space-y-2">
          {success ? (
            <div
              role="status"
              className="rounded-md border border-success/40 bg-success-soft px-3 py-2 text-sm text-success"
            >
              {success}
            </div>
          ) : null}
          {error ? <ErrorBar error={error} /> : null}
        </div>
      </SettingSection>
    </div>
  );
}
