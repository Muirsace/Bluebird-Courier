import type { CSSProperties, ReactNode } from 'react';

interface RevealItemProps {
  /** 相对数据到达时刻的延迟；相邻两层只差 30～40ms。 */
  delayMs: number;
  /** 这一层自己的时长。 */
  durationMs: number;
  /** 起始下移量；只影响绘制，不参与布局。 */
  shiftPx: number;
  /** 这一层额外的类名（例如让整个层级参与吸附）。 */
  className?: string;
  children: ReactNode;
}

/**
 * 详情首次揭示里的一个错峰层级。
 *
 * 自身不产生任何盒模型效果（不加 padding / margin / width），只把三个时长写成 CSS 变量；
 * 动画由 `.detail-reveal[data-reveal='revealing']` 下的那条规则统一挂上，
 * 所以揭示窗口一过（ready），节点即使因为切 Tab 重挂也不会再播一遍。
 */
export function RevealItem({ delayMs, durationMs, shiftPx, className, children }: RevealItemProps) {
  const style = {
    '--reveal-delay': `${delayMs}ms`,
    '--reveal-ms': `${durationMs}ms`,
    '--reveal-shift': `${shiftPx}px`,
  } as CSSProperties;

  return (
    <div className={`detail-reveal-item${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  );
}
