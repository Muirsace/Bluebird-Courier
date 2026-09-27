import type { NormalizedError } from '../../shared/types';
import { describeError } from '../lib/errors';

const KIND_STYLES: Record<NormalizedError['kind'], string> = {
  access_token_invalid: 'border-danger/40 bg-danger-soft text-danger',
  rate_limited: 'border-warning/40 bg-warning-soft text-warning',
  not_found: 'border-info/40 bg-info-soft text-info',
  network: 'border-warning/40 bg-warning-soft text-warning',
  unknown: 'border-strong bg-surface-raised text-secondary',
};

interface ErrorBarProps {
  error: NormalizedError;
  /** 令牌无效时展示"去设置"入口。 */
  onGoSettings?: () => void;
  /** 附加操作按钮（如"重试"）。 */
  action?: { label: string; onClick: () => void };
}

/** 单条归一化错误的紧凑提示条，按错误类别着色。 */
export function ErrorBar({ error, onGoSettings, action }: ErrorBarProps) {
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm ${KIND_STYLES[error.kind]}`}
    >
      {error.fullName ? (
        <span className="font-mono text-xs opacity-80">{error.fullName}</span>
      ) : null}
      <span className="min-w-0 flex-1">{describeError(error)}</span>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="inline-flex h-8 shrink-0 items-center rounded border border-default bg-surface/60 px-2 text-xs transition-colors duration-150 ease-out hover:bg-surface active:bg-surface-active"
        >
          {action.label}
        </button>
      ) : null}
      {error.kind === 'access_token_invalid' && onGoSettings ? (
        <button
          type="button"
          onClick={onGoSettings}
          className="inline-flex h-8 shrink-0 items-center rounded border border-default bg-surface/60 px-2 text-xs transition-colors duration-150 ease-out hover:bg-surface active:bg-surface-active"
        >
          去设置
        </button>
      ) : null}
    </div>
  );
}
