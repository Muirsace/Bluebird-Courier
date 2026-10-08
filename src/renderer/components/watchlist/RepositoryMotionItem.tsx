import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { Glance } from '../../../shared/types';
import { motionCompletionMs, REPO_MOTION } from '../../lib/motion';
import { cardLayoutTransition, cardVariants } from './card-motion';

export interface RepositoryItemProps {
  repo: Glance;
  onOpen: (repo: Glance) => void;
  /** 移除失败时必须 reject（Popover 就地提示并允许重试）。 */
  onRemove: (repositoryId: number) => Promise<void>;
  /** 全局「检查更新」进行中：在抓取时间后加一句轻量提示，卡片本身保持可读。 */
  refreshing: boolean;
  /** 刚加入清单：只这一张播放一次进场（含轻量高亮），其它卡片不跟着动。 */
  justAdded?: boolean;
  onEntered?: (repositoryId: number) => void;
  /** 只播放高亮的请求序号；与首次新增进场状态分开，允许同一张卡片重复定位。 */
  highlightRequest?: number;
  /** 列表正在删除时，其他卡片沿用原来的收拢时长与缓动。 */
  removing: boolean;
  onExited?: (repositoryId: number) => void;
}

interface RepositoryMotionItemProps extends Pick<RepositoryItemProps,
  'repo' | 'justAdded' | 'onEntered' | 'highlightRequest' | 'removing' | 'onExited'> {
  children: (exiting: boolean) => ReactNode;
}

const HIGHLIGHT_TOTAL_MS = REPO_MOTION.highlightDelayMs + REPO_MOTION.highlightMs;

/** Cards and sidebar rows share the approved Presence, layout and highlight lifecycle. */
export const RepositoryMotionItem = forwardRef<HTMLLIElement, RepositoryMotionItemProps>(function RepositoryMotionItem({
  repo, justAdded = false, onEntered, highlightRequest, onExited, removing, children,
}, forwardedRef) {
  const reduceMotion = useReducedMotion() === true;
  // 新增只在挂载时判定，连续添加另一张卡片不会截断这一张的进场。
  const [entering, setEntering] = useState(justAdded);
  const [exitingCard, setExitingCard] = useState(false);
  const [highlight, setHighlight] = useState(justAdded);
  const [highlightOnly, setHighlightOnly] = useState(false);
  const seenHighlightRequest = useRef<number | undefined>(undefined);
  const slotRef = useRef<HTMLLIElement | null>(null);
  const setSlotRef = useCallback((node: HTMLLIElement | null): void => {
    slotRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  useEffect(() => {
    if (highlightRequest === undefined || highlightRequest === seenHighlightRequest.current) return;
    seenHighlightRequest.current = highlightRequest;
    setHighlightOnly(true);
  }, [highlightRequest]);

  // 新增高亮比本体活得久（本体 260ms 结束，高亮 800ms 落回普通 surface），单独收尾
  useEffect(() => {
    if (!highlight) return;
    const slot = slotRef.current;
    if (!slot) return;

    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      setHighlight(false);
    };
    const handleAnimationEnd = (event: AnimationEvent): void => {
      if (['repo-card-highlight', 'repository-sidebar-highlight'].includes(event.animationName)) finish();
    };

    slot.addEventListener('animationend', handleAnimationEnd);
    const timer = window.setTimeout(finish, motionCompletionMs(HIGHLIGHT_TOTAL_MS));
    return () => {
      slot.removeEventListener('animationend', handleAnimationEnd);
      window.clearTimeout(timer);
    };
  }, [highlight]);

  useEffect(() => {
    if (!highlightOnly) return;
    const slot = slotRef.current;
    if (!slot) return;

    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      setHighlightOnly(false);
    };
    const handleAnimationEnd = (event: AnimationEvent): void => {
      if (['repo-card-highlight', 'repository-sidebar-highlight'].includes(event.animationName)) finish();
    };

    slot.addEventListener('animationend', handleAnimationEnd);
    const timer = window.setTimeout(finish, motionCompletionMs(REPO_MOTION.highlightMs));
    return () => {
      slot.removeEventListener('animationend', handleAnimationEnd);
      window.clearTimeout(timer);
    };
  }, [highlightOnly]);

  return (
    <motion.li
      ref={setSlotRef}
      className="repo-row-slot"
      data-repository-id={repo.id}
      data-highlight={highlight ? 'true' : undefined}
      data-highlight-only={highlightOnly ? 'true' : undefined}
      layout={reduceMotion ? false : 'position'}
      initial={reduceMotion || !entering ? false : 'initial'}
      animate={entering ? 'enter' : 'idle'}
      exit="exit"
      variants={cardVariants(reduceMotion)}
      transition={{ layout: cardLayoutTransition(removing) }}
      style={{ pointerEvents: exitingCard ? 'none' : undefined }}
      onAnimationStart={(definition) => {
        if (definition !== 'exit') return;
        // Motion 生命周期接管退场语义；业务删除已完成，不再等待动画来更新数据。
        slotRef.current?.setAttribute('inert', '');
        setExitingCard(true);
        setHighlight(false);
        setHighlightOnly(false);
      }}
      onAnimationComplete={(definition) => {
        if (definition === 'enter') {
          setEntering(false);
          onEntered?.(repo.id);
        } else if (definition === 'exit') {
          onExited?.(repo.id);
        }
      }}
    >
      <div className="repo-row-clip">{children(exitingCard)}</div>
    </motion.li>
  );
});
