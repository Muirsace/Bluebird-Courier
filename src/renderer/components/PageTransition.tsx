import type { ReactNode } from 'react';

/**
 * 页面切换的三个层级，方向必须表达导航层级而不是一律左右滑：
 * top     —— 同级顶级页（监控清单 ↔ 设置）：淡入 + 极轻 Y 位移
 * forward —— 父级进子级（清单 → 仓库详情）：淡入 + 向右 10px 的方向感
 * back    —— 子级返回父级（详情 → 清单）：淡入 + 向左 8px 的方向感
 */
export type PageMotion = 'top' | 'forward' | 'back';

interface PageTransitionProps {
  /** null = 首屏：应用还没发生过导航，直接显示，不播切换动画。 */
  motion: PageMotion | null;
  children: ReactNode;
}

/**
 * 顶级页与详情之间的内容切换容器：只包 main 里的内容区，
 * Header / 导航 / Logo / 背景都在它外面，切换时完全静止。
 *
 * key 由调用方按导航状态给出，所以只有真实导航会换节点并重播进场；
 * 数据刷新、主题切换、resize 都不会。动画只做 enter（旧内容随重挂载立即消失），
 * 不走 exit + enter 串行，整段不会超过 210ms。
 */
export function PageTransition({ motion, children }: PageTransitionProps) {
  return (
    <div className="view-transition" data-view-motion={motion ?? undefined} data-testid="page-transition">
      {children}
    </div>
  );
}
