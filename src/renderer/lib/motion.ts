/**
 * 监控清单卡片进出场的时长。数值与 styles.css 里的 keyframes 一一对应：
 * 组件、测试与"animationend 没来"的兜底都读这里的常数，不把毫秒数散落到各处。
 *
 * 弹簧感只来自新增卡片的 keyframe（-8px → +1px → 0），列表空间与其它卡片永远只有
 * 非线性缓动、没有 overshoot。
 */
export const REPO_MOTION = {
  /** 列表腾出 / 收回空间：0fr ↔ 1fr。 */
  layoutMs: 220,
  /** 新卡片本体：淡入 + 轻轻落入。 */
  enterMs: 260,
  /** 新增高亮：紧跟本体之后，只提示一次。 */
  highlightDelayMs: 240,
  highlightMs: 560,
  /** 移除：本体快速淡出、列表空间收回，两者允许重叠。 */
  exitCardMs: 150,
  exitLayoutMs: 200,
  /** prefers-reduced-motion：只留一次极短的透明度淡出，不做位移 / 缩放 / grid tween。 */
  reducedMs: 40,
  /** animationend 没派发（元素提前卸载、引擎不支持该属性动画）时的兜底余量。 */
  fallbackMs: 140,
} as const;

/** 进场阶段要等的最长一条动画结束：本体与高亮重叠，取高亮结束时刻。 */
export const REPO_ENTER_TOTAL_MS =
  REPO_MOTION.highlightDelayMs + REPO_MOTION.highlightMs;

/** 退场阶段要等的最长一条动画结束：空间收回比本体淡出慢。 */
export const REPO_EXIT_TOTAL_MS = Math.max(REPO_MOTION.exitCardMs, REPO_MOTION.exitLayoutMs);

/**
 * 兜底计时器的等待时长。正常模式下 animationend 才是主信号，这里只是"事件没来"时的余量；
 * 降级模式下动画被关掉、永远等不到 animationend，所以它本身就是唯一信号，取值要短。
 */
export function motionCompletionMs(totalMs: number): number {
  return prefersReducedMotion() ? REPO_MOTION.reducedMs : totalMs + REPO_MOTION.fallbackMs;
}


/** 读系统"减少动态效果"开关；动画开始前问一次，用来把动画降级成一次极短淡出。 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * 仓库操作浮层（`···` 菜单 / 移除确认）的时长。同样与 styles.css 的 keyframes 一一对应。
 *
 * 这里没有弹簧：浮层是高频导航的一部分，只做"从触发器方向长出来"的轻微位移 + 缩放。
 */
export const OVERLAY_MOTION = {
  /** 打开：淡入 + 轻微缩放 + 顺着触发器方向位移。 */
  enterMs: 160,
  /** 关闭：比打开更快，且不 overshoot。 */
  exitMs: 120,
  /** 菜单 → 确认：外壳宽高连续过渡 + 内容交叉淡化。 */
  swapMs: 170,
} as const;

/**
 * Detail Reveal：首次抓取完成后，Loading「解锁」成完整详情的时长。同样与 styles.css 一一对应。
 *
 * 语义是"数据就绪"而不是"新页面弹出"，所以不用 spring：只有 opacity 与几像素的 Y。
 * 各层是错峰而不是串行——相邻两层只差 30～40ms，最晚那条也在 400ms 内结束。
 * 这里只管"内容怎么进来"；Loading 自己的退出（100ms）与指标值的交叉淡化（140ms）另算。
 */
export const DETAIL_REVEAL_MOTION = {
  /** Loading 卡退出：Spinner 轻微缩小、文案上移，一起淡出。 */
  loadingExitMs: 100,
  /** 表头指标值：— → 真实值的短交叉淡化（不做 CountUp）。 */
  metricMs: 140,
  /** 抓取按钮文案：抓取中… → 重新抓取。 */
  refetchLabelMs: 120,
  /** Tabs 先于内容进入。 */
  tabsDelayMs: 80,
  tabsMs: 160,
  tabsShiftPx: 4,
  /** 概览各 Section：只做 Section 级错峰，绝不逐行 stagger。 */
  buildDelayMs: 100,
  buildMs: 210,
  buildShiftPx: 6,
  releaseDelayMs: 135,
  issueDelayMs: 165,
  trendDelayMs: 195,
  sectionMs: 200,
  sectionShiftPx: 5,
} as const;

/** 从 fetch 成功到整屏稳定：取最晚结束的那一条（趋势），其余都在它之前收尾。 */
export const DETAIL_REVEAL_TOTAL_MS =
  DETAIL_REVEAL_MOTION.trendDelayMs + DETAIL_REVEAL_MOTION.sectionMs;
