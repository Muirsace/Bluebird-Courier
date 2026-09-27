import { useEffect, useRef } from 'react';
import { Spinner } from '../Spinner';

interface RemoveRepositoryPopoverProps {
  id: string;
  fullName: string;
  /** 移除请求进行中：两个按钮都禁用，避免重复提交。 */
  busy: boolean;
  /** 移除失败的原因；失败时 Popover 不关闭，用户可重试或取消。 */
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 移除监控仓库的轻量确认 Popover：无倒计时、无二次点击，取消 / Esc / 点外部都能退出。 */
export function RemoveRepositoryPopover({
  id,
  fullName,
  busy,
  error,
  onCancel,
  onConfirm,
}: RemoveRepositoryPopoverProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // 打开即把焦点移进 Popover，键盘用户不必再 Tab 找
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      id={id}
      role="dialog"
      aria-label="从监控清单移除仓库"
      className="overlay-enter absolute right-0 top-full z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-strong bg-surface p-3 shadow-sm"
    >
      <p className="text-sm font-medium text-primary">从监控清单移除？</p>
      <p className="mt-1 break-all font-mono text-xs text-secondary">{fullName}</p>
      <p className="mt-2 text-xs text-muted">
        这不会删除 GitHub 仓库，只会停止在 OCTO 中监控。
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-9 rounded-md border border-default px-3 text-sm text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy}
          className="flex h-9 min-w-[104px] items-center justify-center gap-2 rounded-md bg-danger-solid px-3 text-sm font-medium text-danger-contrast transition-colors duration-150 ease-out hover:bg-danger-solid-hover active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
          {busy ? '移除中…' : '移除'}
        </button>
      </div>
    </div>
  );
}
