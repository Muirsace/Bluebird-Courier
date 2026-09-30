import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AnimationEvent as ReactAnimationEvent, CSSProperties, ReactNode, RefObject } from 'react';
import { motionCompletionMs, OVERLAY_MOTION, prefersReducedMotion } from '../../lib/motion';
import { chooseOverlayPlacement, overlayMaxWidth, VIEWPORT_SAFE_GAP } from '../../lib/overlay-placement';
import type { OverlayPlacementResult } from '../../lib/overlay-placement';

/** 两种内容的宽度（对应 w-44 / w-72）：换内容时外壳按这两个值连续过渡，不是瞬变。 */
const STAGE_WIDTH = { menu: 176, confirm: 288 } as const;

export type SurfaceStage = 'menu' | 'confirm';

interface RepositoryActionSurfaceProps {
  stage: SurfaceStage;
  /** 内容可能改变尺寸的信号（stage / busy / error 拼成）：一变就在 paint 前重新量一次。 */
  measureKey: string;
  /** 正在播关闭动画：外壳留在原位淡出，播完回调 onExitEnd。 */
  closing: boolean;
  onExitEnd: () => void;
  triggerRef: RefObject<HTMLButtonElement>;
  children: ReactNode;
}

interface SurfaceSize {
  width: number;
  height: number;
}

type SurfaceLayout = OverlayPlacementResult & SurfaceSize & { clamped: boolean };

/**
 * `···` 菜单与移除确认共用的那一个浮层外壳。
 *
 * 三层各管一件事，避免 placement、动画、尺寸互相覆盖：
 *   positioner —— 上下翻转、与触发器的间距、max-width / max-height
 *   surface    —— 边框 / 圆角 / 阴影 + 进场退场（opacity / translate / scale）
 *   content    —— 菜单 → 确认的交叉淡化，以及外壳宽高的连续过渡
 *
 * 菜单 → 确认时外壳**不卸载**：旧内容留在 out 层淡出，新内容在原地淡入，
 * 外壳从旧尺寸长到新尺寸（keyframes + CSS 变量），所以看起来是同一个框变大。
 * 位置完全由 triggerRect + 视口算出来（见 chooseOverlayPlacement），不引第三方浮层库。
 */
export function RepositoryActionSurface({
  stage,
  measureKey,
  closing,
  onExitEnd,
  triggerRef,
  children,
}: RepositoryActionSurfaceProps) {
  const positionerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** null = 还没量过：首帧先按保守值画，布局效果会在 paint 前用实测值纠正。 */
  const [layout, setLayout] = useState<SurfaceLayout | null>(null);
  /** 上一次内容尺寸：换内容时"从小到大"这件事需要一个起点。 */
  const previousSizeRef = useRef<SurfaceSize | null>(null);
  const previousContentRef = useRef<{ stage: SurfaceStage; node: ReactNode } | null>(null);
  /** 换内容期间的旧内容：留在 out 层淡出，新内容在流里淡入。 */
  const [swap, setSwap] = useState<{ outgoing: ReactNode; from: SurfaceSize } | null>(null);
  /** 尺寸补间进行中：期间不重量，免得把量到的中间态当成目标值写回去。 */
  const swappingRef = useRef(false);

  const measure = useCallback((): void => {
    const positioner = positionerRef.current;
    const surface = surfaceRef.current;
    const content = contentRef.current;
    const trigger = triggerRef.current;
    if (!positioner || !surface || !content || !trigger) return;

    const triggerRect = trigger.getBoundingClientRect();
    // 宽度只由 stage 与视口决定，先落到 DOM：确认框比菜单宽，换行位置不同、高度也不同，
    // 所以高度必须在最终宽度下量。
    const width = Math.min(STAGE_WIDTH[stage], overlayMaxWidth(triggerRect, window.innerWidth));
    positioner.style.setProperty('--overlay-width', `${width}px`);

    // 边框已经画在 surface 上，测量值要含进去才是外壳的目标高度
    const borderY = surface.offsetHeight - surface.clientHeight;
    const height = Math.round(content.getBoundingClientRect().height) + borderY;

    const placement = chooseOverlayPlacement({
      triggerRect,
      overlayHeight: height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    const clamped = height > placement.maxHeight;

    // 值没变就不写 state：滚动与 resize 会高频触发这里
    setLayout((prev) =>
      prev &&
      prev.placement === placement.placement &&
      prev.width === width &&
      prev.height === height &&
      prev.clamped === clamped &&
      prev.maxHeight === placement.maxHeight &&
      prev.maxWidth === placement.maxWidth
        ? prev
        : { ...placement, width, height, clamped },
    );
    previousSizeRef.current = { width, height };
  }, [stage, measureKey, triggerRef]);

  /** 给 resize / 滚动 / 内容变化用的重量：尺寸补间期间跳过，等它结束再补一次。 */
  const remeasure = useCallback((): void => {
    if (swappingRef.current) return;
    measure();
  }, [measure]);

  // 换内容：先读上一次的记录（下面那次 measure 会把它覆盖掉），所以这条必须排在 measure 之前
  useLayoutEffect(() => {
    const previous = previousContentRef.current;
    previousContentRef.current = { stage, node: children };
    if (!previous || previous.stage === stage) return;
    // 降级模式不做交叉淡化：直接换内容，免得两层同时可见
    if (prefersReducedMotion()) {
      setSwap(null);
      return;
    }
    const from = previousSizeRef.current;
    if (!from) return;
    // 立刻上锁：补间期间的 resize / 滚动 / RO 回调都不该把中间尺寸当成目标值
    swappingRef.current = true;
    setSwap({ outgoing: previous.node, from });
  }, [stage, children]);

  // stage / busy / error 变化后，在 paint 前重新量一次并落位
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // 换内容期间跳过的事件在这里补一次；顺便把"正在补间"的标志交给 remeasure
  useEffect(() => {
    swappingRef.current = swap !== null;
    if (!swap) measure();
  }, [swap, measure]);

  // 视口变化（窗口 resize、滚动条出现）与页面滚动后重量，placement 可能整体反过来
  useEffect(() => {
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, { passive: true, capture: true });
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, { capture: true });
    };
  }, [remeasure]);

  // 内容尺寸变化（错误提示出现、按钮进入 busy）也要跟着重量
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(remeasure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [remeasure]);

  // 旧内容留到尺寸补间结束；animationend 是主信号，兜底计时器保证一定会清掉
  useEffect(() => {
    if (!swap) return;
    const timer = window.setTimeout(() => setSwap(null), motionCompletionMs(OVERLAY_MOTION.swapMs));
    return () => window.clearTimeout(timer);
  }, [swap]);

  // 关闭动画同样以 animationend 为主信号；降级模式下它就是唯一信号
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(onExitEnd, motionCompletionMs(OVERLAY_MOTION.exitMs));
    return () => window.clearTimeout(timer);
  }, [closing, onExitEnd]);

  const handlePositionerAnimationEnd = (event: ReactAnimationEvent<HTMLDivElement>): void => {
    if (event.animationName === 'repository-action-resize') setSwap(null);
  };

  const handleSurfaceAnimationEnd = (event: ReactAnimationEvent<HTMLDivElement>): void => {
    if (event.animationName === 'repository-action-close' && closing) onExitEnd();
  };

  const placement = layout?.placement ?? 'bottom';
  const width =
    layout?.width ?? Math.min(STAGE_WIDTH[stage], Math.max(window.innerWidth - VIEWPORT_SAFE_GAP * 2, 0));
  const height = layout?.height ?? null;

  const style = {
    '--overlay-width': `${width}px`,
    '--overlay-height': height === null ? 'auto' : `${height}px`,
    '--overlay-max-width': `${layout?.maxWidth ?? window.innerWidth - VIEWPORT_SAFE_GAP * 2}px`,
    '--overlay-max-height': layout ? `${layout.maxHeight}px` : 'none',
    '--overlay-from-width': `${swap?.from.width ?? width}px`,
    '--overlay-to-width': `${width}px`,
    '--overlay-from-height': `${swap?.from.height ?? height ?? 0}px`,
    '--overlay-to-height': `${height ?? 0}px`,
  } as CSSProperties;

  return (
    <div
      ref={positionerRef}
      className="repository-action-positioner"
      data-placement={placement}
      data-swapping={swap ? 'true' : undefined}
      style={style}
      onAnimationEnd={handlePositionerAnimationEnd}
    >
      <div
        ref={surfaceRef}
        className="repository-action-surface rounded-lg border border-strong bg-surface shadow-sm"
        data-placement={placement}
        data-swapping={swap ? 'true' : undefined}
        data-closing={closing ? 'true' : undefined}
        data-clamped={layout?.clamped ? 'true' : undefined}
        onAnimationEnd={handleSurfaceAnimationEnd}
      >
        <div ref={contentRef} className="repository-action-content">
          {swap ? (
            // 旧内容只负责淡出：脱流、不可点、不进无障碍树，Tab 也不会落进去
            <div
              className="repository-action-content-out"
              aria-hidden="true"
              ref={(node) => {
                node?.setAttribute('inert', '');
              }}
            >
              {swap.outgoing}
            </div>
          ) : null}
          <div className="repository-action-content-in">{children}</div>
        </div>
      </div>
    </div>
  );
}
