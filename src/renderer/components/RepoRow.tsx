import { useEffect, useRef, useState } from 'react';
import type { Glance } from '../../shared/types';
import { formatCount } from '../lib/format';
import {
  motionCompletionMs,
  REPO_ENTER_TOTAL_MS,
  REPO_EXIT_TOTAL_MS,
  REPO_MOTION,
} from '../lib/motion';
import { formatRelativeTime } from '../lib/time';
import { GlanceFact } from './GlanceFact';
import { RepositoryActions } from './watchlist/RepositoryActions';

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
  /** 移除已成功、正在播放退场；播完回报，由上层真正从列表移除。 */
  exiting?: boolean;
  onExited?: (repositoryId: number) => void;
}

/** idle → 静止；entering → 新增进场；exiting → 移除退场。 */
type MotionPhase = 'idle' | 'entering' | 'exiting';

/** 每个阶段要等哪些 keyframes 结束；齐了才收尾，否则空间会被提前掐断。 */
const PHASE_ANIMATIONS: Record<Exclude<MotionPhase, 'idle'>, string[]> = {
  entering: ['repo-slot-expand', 'repo-card-enter'],
  exiting: ['repo-slot-collapse', 'repo-card-exit'],
};

/** 进场加高亮的总时长，供高亮阶段自己收尾用。 */
const HIGHLIGHT_TOTAL_MS = REPO_MOTION.highlightDelayMs + REPO_MOTION.highlightMs;

/**
 * 监控清单里的一张仓库卡片：仓库名 → 核心指标 → 抓取时间，三层视觉权重。
 * 主区域是真正的 button（鼠标点击与 Enter / Space 都进详情），`···` 与它平级而非嵌套。
 *
 * 卡片外层（li）用 0fr ↔ 1fr 让列表腾出 / 收回空间，本体只做 opacity / transform：
 * 弹性只属于"刚新增的这一张"，列表与其它卡片永远走正常文档流。
 */
export function RepoRow({
  repo,
  onOpen,
  onRemove,
  refreshing,
  justAdded = false,
  onEntered,
  highlightRequest,
  onExited,
  exiting = false,
}: RepoRowProps) {
  const [phase, setPhase] = useState<MotionPhase>(() =>
    exiting ? 'exiting' : justAdded ? 'entering' : 'idle',
  );
  const [highlight, setHighlight] = useState(justAdded);
  const [highlightOnly, setHighlightOnly] = useState(false);
  const seenHighlightRequest = useRef<number | undefined>(undefined);
  const slotRef = useRef<HTMLLIElement>(null);

  // 移除成功由上层打开 exiting；进场只在挂载那一刻判定，后续 render 不会重播
  useEffect(() => {
    if (exiting) setPhase('exiting');
  }, [exiting]);

  useEffect(() => {
    if (highlightRequest === undefined || highlightRequest === seenHighlightRequest.current) return;
    seenHighlightRequest.current = highlightRequest;
    setHighlightOnly(true);
  }, [highlightRequest]);

  useEffect(() => {
    if (phase === 'idle') return;
    const slot = slotRef.current;
    if (!slot) return;

    const expected = PHASE_ANIMATIONS[phase];
    const seen = new Set<string>();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      setPhase('idle');
      if (phase === 'entering') onEntered?.(repo.id);
      else onExited?.(repo.id);
    };
    // animationend 是主信号；动画被降级 / 元素提前卸载 / 引擎不派发时由兜底计时器收尾
    const handleAnimationEnd = (event: AnimationEvent): void => {
      if (!expected.includes(event.animationName)) return;
      seen.add(event.animationName);
      if (seen.size === expected.length) finish();
    };

    slot.addEventListener('animationend', handleAnimationEnd);
    const timer = window.setTimeout(
      finish,
      motionCompletionMs(phase === 'entering' ? REPO_ENTER_TOTAL_MS : REPO_EXIT_TOTAL_MS),
    );
    return () => {
      slot.removeEventListener('animationend', handleAnimationEnd);
      window.clearTimeout(timer);
    };
  }, [phase, repo.id, onEntered, onExited]);

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

  // 退场期间整张卡片立即失效：鼠标点不到，键盘也 Tab 不进去
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    if (phase === 'exiting') slot.setAttribute('inert', '');
    else slot.removeAttribute('inert');
  }, [phase]);

  const exitingCard = phase === 'exiting';

  return (
    <li
      ref={slotRef}
      className="repo-row-slot"
      data-repository-id={repo.id}
      data-motion={phase}
      data-highlight={highlight ? 'true' : undefined}
      data-highlight-only={highlightOnly ? 'true' : undefined}
    >
      <div className="repo-row-clip">
        <div className="repo-row rounded-lg border border-subtle bg-surface hover:border-strong hover:bg-surface-hover">
          <div className="flex items-start gap-2 p-4">
            {/* 主点击区几乎铺满整张卡片：按下反馈由卡片整体承担（见 .repo-row:has([data-row-activator]:active)），按钮自己只做键盘焦点底色 */}
            <button
              type="button"
              onClick={() => onOpen(repo)}
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
    </li>
  );
}
