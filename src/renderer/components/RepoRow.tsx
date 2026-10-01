import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { Glance } from '../../shared/types';
import { formatCount } from '../lib/format';
import { motionCompletionMs, REPO_MOTION } from '../lib/motion';
import { formatRelativeTime } from '../lib/time';
import { GlanceFact } from './GlanceFact';
import { RepositoryActions } from './watchlist/RepositoryActions';
import { cardLayoutTransition, cardVariants } from './watchlist/card-motion';

interface RepoRowProps {
  repo: Glance;
  onOpen: (repo: Glance) => void;
  /** 移除失败时必须 reject（Popover 就地提示并允许重试）。 */
  onRemove: (repositoryId: number) => Promise<void>;
  /** 全局「全部刷新」进行中：在抓取时间后加一句轻量提示，卡片本身保持可读。 */
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

/** 进场加高亮的总时长，供高亮阶段自己收尾用。 */
const HIGHLIGHT_TOTAL_MS = REPO_MOTION.highlightDelayMs + REPO_MOTION.highlightMs;

/**
 * 监控清单里的一张仓库卡片：仓库名 → 核心指标 → 抓取时间，三层视觉权重。
 * 主区域是真正的 button（鼠标点击与 Enter / Space 都进详情），`···` 与它平级而非嵌套。
 *
 * Motion li 负责 Presence 与位置布局；CSS 继续管理本体的高亮、Hover 和按压。
 * forwardRef 让 AnimatePresence 的 popLayout 能测量并保留同一个 li。
 */
export const RepoRow = forwardRef<HTMLLIElement, RepoRowProps>(function RepoRow({
  repo,
  onOpen,
  onRemove,
  refreshing,
  justAdded = false,
  onEntered,
  highlightRequest,
  onExited,
  removing,
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
      if (event.animationName === 'repo-card-highlight') finish();
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
      if (event.animationName === 'repo-card-highlight') finish();
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
      <div className="repo-row-clip">
        <div className="repo-row rounded-lg border border-subtle bg-surface hover:border-strong hover:bg-surface-hover">
          <div className="flex items-start gap-2 p-4">
            {/* 主点击区几乎铺满整张卡片：按下反馈由卡片整体承担（见 .repo-row:has([data-row-activator]:active)），按钮自己只做键盘焦点底色 */}
            <button
              type="button"
              onClick={() => { if (!slotRef.current?.hasAttribute('inert')) onOpen(repo); }}
              disabled={exitingCard}
              aria-label={`查看 ${repo.fullName} 详情`}
              title={repo.fullName}
              data-button-motion="surface"
              data-row-activator
              className="min-w-0 flex-1 rounded-md text-left transition-colors duration-150 ease-out focus-visible:bg-surface-hover"
            >
              <span className="block min-w-0 truncate font-mono text-lg font-semibold leading-8 text-primary">
                {repo.fullName}
              </span>
              <span className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-2">
                <GlanceFact label="Stars" value={formatCount(repo.stars)} />
                <GlanceFact
                  label="最近活动"
                  value={repo.pushedAt ? formatRelativeTime(repo.pushedAt) : '—'}
                />
                <GlanceFact
                  label="最新版本"
                  value={repo.latestReleaseTag ?? '无发版'}
                  mono
                  muted={repo.latestReleaseTag === null}
                />
              </span>
              <span className="mt-1 block text-xs text-muted">
                抓取于 {repo.fetchedAt ? formatRelativeTime(repo.fetchedAt) : '尚未抓取'}
                {refreshing ? <span className="text-secondary"> · 正在更新…</span> : null}
              </span>
            </button>

            <RepositoryActions repo={repo} onRemove={onRemove} disabled={exitingCard} />
          </div>
        </div>
      </div>
    </motion.li>
  );
});
