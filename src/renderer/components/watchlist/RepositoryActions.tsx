import { useEffect, useRef, useState } from 'react';
import type { Glance } from '../../../shared/types';
import { getApi } from '../../lib/api';
import { describeOpenFailure } from '../../lib/external-link';
import { Spinner } from '../Spinner';
import { RemoveRepositoryPopover } from './RemoveRepositoryPopover';

/** closed → 无浮层；menu → ··· 菜单；confirm → 移除确认 Popover。 */
type Stage = 'closed' | 'menu' | 'confirm';

interface RepositoryActionsProps {
  repo: Glance;
  /** 移除失败时必须 reject，由本组件就地提示并允许重试。 */
  onRemove: (repositoryId: number) => Promise<void>;
  /** 卡片正在退场：入口立即失效，不再接受任何操作。 */
  disabled?: boolean;
}

/** 仓库的次要操作入口：`···` 菜单 + 移除确认 Popover，两者都从卡片主点击区里独立出来。 */
export function RepositoryActions({ repo, onRemove, disabled = false }: RepositoryActionsProps) {
  const [stage, setStage] = useState<Stage>('closed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuItemRef = useRef<HTMLButtonElement>(null);
  const removeMenuItemRef = useRef<HTMLButtonElement>(null);
  const menuId = `repository-menu-${repo.id}`;
  const popoverId = `repository-remove-${repo.id}`;

  const open = stage !== 'closed';

  // 浮层打开期间的通用退出：Esc 关闭并交还焦点；点浮层外部关闭
  useEffect(() => {
    if (!open) return;
    function close(): void {
      setStage('closed');
      setError(null);
      triggerRef.current?.focus();
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) {
        close();
        return;
      }

      if (stage !== 'menu') return;

      if (event.key === 'Tab' && !busy) {
        setStage('closed');
        setError(null);
        return;
      }

      const items = [menuItemRef.current, removeMenuItemRef.current];
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement | null);
      let nextIndex: number | null = null;
      if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = items.length - 1;

      if (nextIndex !== null) {
        event.preventDefault();
        items[nextIndex]?.focus();
      }
    }
    function handlePointerDown(event: MouseEvent): void {
      if (busy) return;
      if (!containerRef.current?.contains(event.target as Node)) {
        setStage('closed');
        setError(null);
      }
    }
    function handleFocusIn(event: FocusEvent): void {
      if (busy) return;
      if (!containerRef.current?.contains(event.target as Node)) {
        setStage('closed');
        setError(null);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('focusin', handleFocusIn);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('focusin', handleFocusIn);
    };
  }, [open, busy, stage]);

  // 菜单打开后把焦点交给菜单项
  useEffect(() => {
    if (stage === 'menu') menuItemRef.current?.focus();
  }, [stage]);

  async function handleConfirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onRemove(repo.id);
      setStage('closed');
    } catch {
      setError('删除失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  /** 跳 GitHub：成功了才收起菜单；失败时菜单留着，就地报错，不让人误以为已经跳走。 */
  async function handleOpenExternal(): Promise<void> {
    // 调用期间锁住菜单：否则结果回来时菜单已被点掉，失败提示就没地方显示
    setBusy(true);
    setError(null);
    try {
      const result = await getApi().openGitHubExternal({
        kind: 'repository',
        owner: repo.owner,
        name: repo.name,
      });
      if (!result.ok) {
        setError(describeOpenFailure(result.reason));
        return;
      }
      setStage('closed');
      triggerRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup={stage === 'confirm' ? 'dialog' : 'menu'}
        aria-expanded={open}
        aria-controls={stage === 'confirm' ? popoverId : stage === 'menu' ? menuId : undefined}
        aria-label={`${repo.fullName} 的仓库操作`}
        title={`${repo.fullName} 的仓库操作`}
        disabled={disabled}
        data-button-motion="icon"
        onClick={() => setStage(stage === 'closed' ? 'menu' : 'closed')}
        className={`repo-actions-trigger inline-flex h-8 w-8 items-center justify-center rounded-md text-lg transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-primary active:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60 ${
          open ? 'bg-surface-active text-primary' : 'text-secondary'
        }`}
      >
        ···
      </button>

      {stage === 'menu' ? (
        <div
          role="menu"
          id={menuId}
          aria-label="仓库操作"
          aria-busy={busy}
          className="overlay-enter absolute right-0 top-full z-20 mt-1 w-44 max-w-[calc(100vw-2rem)] rounded-lg border border-strong bg-surface py-1 shadow-sm"
        >
          <button
            ref={menuItemRef}
            type="button"
            tabIndex={0}
            role="menuitem"
            aria-label={`在 GitHub 打开 ${repo.fullName}`}
            data-button-motion="surface"
            onClick={() => void handleOpenExternal()}
            disabled={busy}
            className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-sm text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
            {busy ? '打开中…' : '在 GitHub 打开'}
          </button>
          <div role="separator" className="my-1 border-t border-subtle" />
          <button
            ref={removeMenuItemRef}
            type="button"
            tabIndex={-1}
            role="menuitem"
            data-button-motion="surface"
            onClick={() => {
              setError(null);
              setStage('confirm');
            }}
            disabled={busy}
            className="flex min-h-9 w-full items-center px-3 text-left text-sm text-danger transition-colors duration-150 ease-out hover:bg-danger-soft active:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-60"
          >
            从监控清单移除
          </button>
          {error ? (
            <p role="alert" className="px-3 py-1.5 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {stage === 'confirm' ? (
        <RemoveRepositoryPopover
          id={popoverId}
          fullName={repo.fullName}
          busy={busy}
          error={error}
          onCancel={() => {
            setStage('closed');
            setError(null);
            triggerRef.current?.focus();
          }}
          onConfirm={() => void handleConfirm()}
        />
      ) : null}
    </div>
  );
}
