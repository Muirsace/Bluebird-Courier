import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Glance } from '../../../shared/types';
import { getApi } from '../../lib/api';
import { describeOpenFailure } from '../../lib/external-link';
import { Spinner } from '../Spinner';
import { RemoveRepositoryPopover } from './RemoveRepositoryPopover';
import { RepositoryActionSurface } from './RepositoryActionSurface';
import { DESKTOP_SHELL_QUERY } from '../../lib/app-layout';
import { resolveAppScrollRoot } from '../../lib/app-scroll-root';
import type { ContextPoint } from '../../lib/overlay-placement';

/** closed → 无浮层；menu → ··· 菜单；confirm → 移除确认。 */
type Stage = 'closed' | 'menu' | 'confirm';

interface RepositoryActionsProps {
  repo: Glance;
  /** 移除失败时必须 reject，由本组件就地提示并允许重试。 */
  onRemove: (repositoryId: number) => Promise<void>;
  /** 卡片正在退场：入口立即失效，不再接受任何操作。 */
  disabled?: boolean;
  /** Desktop uses the row itself; Narrow keeps the existing visible button. */
  contextTriggerRef?: RefObject<HTMLButtonElement>;
}

/**
 * 仓库的次要操作入口：`···` 菜单 + 移除确认，两者共用同一个 RepositoryActionSurface。
 *
 * 菜单 → 确认是"同一外壳换内容"（不卸载、不跳变），本组件只负责状态机
 * （stage / closing / busy / error）与键盘、焦点、错误处理、安全规则。
 */
export function RepositoryActions({ repo, onRemove, disabled = false, contextTriggerRef }: RepositoryActionsProps) {
  const [stage, setStage] = useState<Stage>('closed');
  /** 正在播关闭动画：外壳留在原位淡出，播完（或兜底计时器到点）才真正卸载。 */
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = contextTriggerRef ?? buttonTriggerRef;
  const [contextPoint, setContextPoint] = useState<ContextPoint>();
  const restoreFocusRef = useRef(true);
  const sessionRef = useRef(0);
  const menuItemRef = useRef<HTMLButtonElement>(null);
  const removeMenuItemRef = useRef<HTMLButtonElement>(null);
  const menuId = `repository-menu-${repo.id}`;
  const popoverId = `repository-remove-${repo.id}`;

  const open = stage !== 'closed';

  /** 立即收起：删除成功时用，保持"先关浮层、再播卡片退场"的时序。 */
  const closeNow = useCallback((): void => {
    sessionRef.current += 1;
    setBusy(false);
    setClosing(false);
    setStage('closed');
    setError(null);
  }, []);

  /**
   * 走关闭动画的收起。焦点还在浮层里、或已经被浏览器丢到 body 上（按钮刚被禁用时会这样）
   * 就交还 `···`；已经移到别的控件上（Tab / 点到别处）就保持不动，免得把焦点抢回来。
   */
  const dismiss = useCallback((): void => {
    setClosing(true);
    setError(null);
    const active = document.activeElement;
    const dropped = !active || active === document.body;
    if (restoreFocusRef.current && (dropped || containerRef.current?.contains(active))) {
      const trigger = triggerRef.current;
      if (trigger?.isConnected && !trigger.disabled && !trigger.closest('[inert]')) trigger.focus({ preventScroll: !!contextTriggerRef });
    }
  }, [triggerRef, contextTriggerRef]);

  // Both desktop gestures enter the same state machine, without invoking row selection.
  useEffect(() => {
    const trigger = contextTriggerRef?.current;
    const row = trigger?.closest('.repository-sidebar-row');
    if (!trigger || !row) return;
    const openContext = (keyboard: boolean, point?: ContextPoint): void => {
      if (disabled || busy || trigger.disabled || trigger.closest('[inert]')) return;
      sessionRef.current += 1;
      document.dispatchEvent(new CustomEvent('repository-context-open', { detail: repo.id }));
      const rect = trigger.getBoundingClientRect();
      restoreFocusRef.current = keyboard;
      setContextPoint(point ?? { x: rect.right - 12, y: rect.top + rect.height / 2 });
      setClosing(false);
      setError(null);
      setStage('menu');
    };
    const onContextMenu = (event: Event): void => {
      const mouse = event as MouseEvent;
      event.preventDefault();
      if (containerRef.current?.contains(event.target as Node)) return;
      // Chromium's ContextMenu key also emits a contextmenu event with nonzero coordinates.
      const keyboard = mouse.button !== 2;
      openContext(keyboard, keyboard ? undefined : { x: mouse.clientX, y: mouse.clientY });
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      openContext(true);
    };
    row.addEventListener('contextmenu', onContextMenu);
    trigger.addEventListener('keydown', onKeyDown);
    return () => {
      row.removeEventListener('contextmenu', onContextMenu);
      trigger.removeEventListener('keydown', onKeyDown);
    };
  }, [contextTriggerRef, disabled, busy, repo.id]);

  useLayoutEffect(() => { if (disabled) closeNow(); }, [disabled, closeNow]);

  // Cursor coordinates lose meaning when their list/viewport/context changes.
  useEffect(() => {
    if (!open || !contextTriggerRef) return;
    const trigger = contextTriggerRef.current;
    const root = resolveAppScrollRoot(trigger).element;
    const list = trigger?.closest('ul');
    const slot = trigger?.closest('li');
    const shell = trigger?.closest('.app-shell');
    const wasSettings = !!shell?.querySelector('.settings-page');
    const closeContext = (): void => {
      if (restoreFocusRef.current && window.matchMedia(DESKTOP_SHELL_QUERY).matches &&
        trigger?.isConnected && !trigger.disabled && !trigger.closest('[inert]') &&
        containerRef.current?.contains(document.activeElement)) trigger.focus({ preventScroll: true });
      closeNow();
    };
    const observer = new MutationObserver(() => {
      if (!trigger?.isConnected || slot?.hasAttribute('inert') ||
        (!wasSettings && shell?.querySelector('.settings-page'))) closeNow();
    });
    if (slot) observer.observe(slot, { attributes: true, attributeFilter: ['inert'] });
    if (shell) observer.observe(shell, { childList: true, subtree: true });
    const listObserver = new MutationObserver(closeContext);
    if (list) listObserver.observe(list, { childList: true });
    const bounds = root?.getBoundingClientRect();
    const resizeObserver = root && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      const next = root.getBoundingClientRect();
      if (bounds && (next.top !== bounds.top || next.height !== bounds.height || next.width !== bounds.width)) closeContext();
    }) : null;
    if (root) resizeObserver?.observe(root);
    const closeOther = (event: Event): void => {
      if ((event as CustomEvent<number>).detail !== repo.id) closeNow();
    };
    const onVisibility = (): void => { if (document.hidden) closeNow(); };
    root?.addEventListener('scroll', closeContext, { passive: true });
    window.addEventListener('resize', closeContext);
    window.addEventListener('blur', closeNow);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('repository-context-open', closeOther);
    return () => {
      observer.disconnect();
      listObserver.disconnect();
      resizeObserver?.disconnect();
      root?.removeEventListener('scroll', closeContext);
      window.removeEventListener('resize', closeContext);
      window.removeEventListener('blur', closeNow);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('repository-context-open', closeOther);
    };
  }, [open, contextTriggerRef, closeNow, repo.id]);

  // 浮层打开期间的通用退出：Esc / Tab / 点外部 / 焦点移出
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (closing) return;
      if (event.key === 'Escape' && !busy) {
        // 消费掉这次按键：更外层的导航（例如详情页的 Esc 返回，挂在 window 上、冒泡更晚）
        // 靠 defaultPrevented 判断"浮层先拿了这次 Esc"，就不该再切页
        event.preventDefault();
        // Desktop Omnibox also owns Esc; an open context surface consumes it first.
        if (contextTriggerRef) event.stopImmediatePropagation();
        dismiss();
        return;
      }

      if (stage !== 'menu') return;

      if (event.key === 'Tab' && !busy) {
        dismiss();
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
        items[nextIndex]?.focus({ preventScroll: !!contextTriggerRef });
      }
    }
    function handlePointerDown(event: MouseEvent): void {
      if (busy || closing) return;
      if (!containerRef.current?.contains(event.target as Node)) dismiss();
    }
    function handleFocusIn(event: FocusEvent): void {
      if (busy || closing) return;
      if (!containerRef.current?.contains(event.target as Node)) dismiss();
    }
    document.addEventListener('keydown', handleKeyDown, !!contextTriggerRef);
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('focusin', handleFocusIn);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, !!contextTriggerRef);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('focusin', handleFocusIn);
    };
  }, [open, busy, stage, closing, dismiss, contextTriggerRef]);

  // 菜单打开后把焦点交给菜单项
  useEffect(() => {
    if (stage === 'menu') menuItemRef.current?.focus({ preventScroll: !!contextTriggerRef });
  }, [stage, contextPoint, contextTriggerRef]);

  async function handleConfirm(): Promise<void> {
    const session = sessionRef.current;
    setBusy(true);
    setError(null);
    try {
      await onRemove(repo.id);
      if (session === sessionRef.current) closeNow();
    } catch {
      if (session === sessionRef.current) setError('删除失败，请稍后重试');
    } finally {
      if (session === sessionRef.current) setBusy(false);
    }
  }

  /** 跳 GitHub：成功了才收起菜单；失败时菜单留着，就地报错，不让人误以为已经跳走。 */
  async function handleOpenExternal(): Promise<void> {
    const session = sessionRef.current;
    // 调用期间锁住菜单：否则结果回来时菜单已被点掉，失败提示就没地方显示
    setBusy(true);
    setError(null);
    try {
      const result = await getApi().openGitHubExternal({
        kind: 'repository',
        owner: repo.owner,
        name: repo.name,
      });
      if (session !== sessionRef.current) return;
      if (!result.ok) {
        setError(describeOpenFailure(result.reason));
        return;
      }
      dismiss();
    } finally {
      if (session === sessionRef.current) setBusy(false);
    }
  }

  function handleTriggerClick(): void {
    if (closing) return;
    if (stage === 'closed') {
      setStage('menu');
      setError(null);
      return;
    }
    dismiss();
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      {!contextTriggerRef ? <button
        ref={triggerRef}
        type="button"
        aria-haspopup={stage === 'confirm' ? 'dialog' : 'menu'}
        aria-expanded={open}
        aria-controls={stage === 'confirm' ? popoverId : stage === 'menu' ? menuId : undefined}
        aria-label={`${repo.fullName} 的仓库操作`}
        title={`${repo.fullName} 的仓库操作`}
        disabled={disabled}
        data-button-motion="icon"
        onClick={handleTriggerClick}
        className={`repo-actions-trigger inline-flex h-8 w-8 items-center justify-center rounded-md text-lg transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-primary active:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60 ${
          open ? 'bg-surface-active text-primary' : 'text-secondary'
        }`}
      >
        ···
      </button> : null}

      {open ? (
        <RepositoryActionSurface
          stage={stage}
          measureKey={`${stage}|${busy}|${error ?? ''}`}
          closing={closing}
          onExitEnd={closeNow}
          triggerRef={triggerRef}
          contextPoint={contextPoint}
        >
          {stage === 'confirm' ? (
            <RemoveRepositoryPopover
              id={popoverId}
              fullName={repo.fullName}
              busy={busy}
              error={error}
              preventScroll={!!contextTriggerRef}
              onCancel={dismiss}
              onConfirm={() => void handleConfirm()}
            />
          ) : (
            <div role="menu" id={menuId} aria-label="仓库操作" aria-busy={busy} className="py-1">
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
          )}
        </RepositoryActionSurface>
      ) : null}
    </div>
  );
}
