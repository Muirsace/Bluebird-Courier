/**
 * 浮层翻转与安全边距的策略：纯几何，只吃触发器的 rect 与视口尺寸。
 *
 * 拆成纯函数是为了可测——happy-dom 给不出真实布局尺寸，DOM 测量留在组件里，
 * 这里只回答"往上还是往下、最多能多高、最多能多宽"。
 */
export type OverlayPlacement = 'top' | 'bottom';

/** 浮层与 `···` 触发器之间的间距。 */
export const TRIGGER_GAP = 8;
/** 浮层与视口边缘（上下左右同一条规则）的最小距离。 */
export const VIEWPORT_SAFE_GAP = 12;

export interface OverlayTriggerRect {
  top: number;
  bottom: number;
  right: number;
}

export interface OverlayPlacementInput {
  triggerRect: OverlayTriggerRect;
  /** 浮层想要的高度：内容自然高度（含边框）。 */
  overlayHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface OverlayPlacementResult {
  placement: OverlayPlacement;
  /** 高度上限：内容比它高就内部滚动，超出视口的部分永远不画出来。 */
  maxHeight: number;
  /** 宽度上限：右对齐触发器时，保证左侧仍留出 safe gap。 */
  maxWidth: number;
}

/**
 * 右对齐触发器时的宽度上限：左侧也要留出 safe gap，别把浮层顶到视口外。
 * 单独导出是因为组件必须"先定宽、再量高"——宽度不同，文字换行位置不同，高度也不同。
 */
export function overlayMaxWidth(triggerRect: OverlayTriggerRect, viewportWidth: number): number {
  return Math.max(
    Math.min(viewportWidth - VIEWPORT_SAFE_GAP * 2, triggerRect.right - VIEWPORT_SAFE_GAP),
    0,
  );
}

/**
 * 优先放下方（贴着触发器的常见方向）；下方不够再看上方；
 * 两边都不够时选空间更大的一侧，并把高度压到该侧可用空间里，让内容自己滚动。
 */
export function chooseOverlayPlacement({
  triggerRect,
  overlayHeight,
  viewportWidth,
  viewportHeight,
}: OverlayPlacementInput): OverlayPlacementResult {
  const spaceBelow = viewportHeight - triggerRect.bottom - VIEWPORT_SAFE_GAP;
  const spaceAbove = triggerRect.top - VIEWPORT_SAFE_GAP;
  const needed = overlayHeight + TRIGGER_GAP;

  let placement: OverlayPlacement = 'bottom';
  if (spaceBelow < needed) placement = spaceAbove >= needed ? 'top' : spaceBelow >= spaceAbove ? 'bottom' : 'top';

  const available = placement === 'bottom' ? spaceBelow : spaceAbove;
  return {
    placement,
    maxHeight: Math.max(available - TRIGGER_GAP, 0),
    maxWidth: overlayMaxWidth(triggerRect, viewportWidth),
  };
}
