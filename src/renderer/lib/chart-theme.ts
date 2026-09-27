import type { EffectiveTheme } from '../../shared/theme';

/** 趋势图配色：Chart.js 只接受完整色值，不能是 CSS 通道三元组。 */
export interface ChartPalette {
  grid: string;
  label: string;
  tooltip: string;
  tooltipText: string;
  star: string;
  fork: string;
}

const VARIABLES: Record<keyof ChartPalette, string> = {
  grid: '--chart-grid',
  label: '--chart-label',
  tooltip: '--chart-tooltip',
  tooltipText: '--chart-tooltip-text',
  star: '--chart-star',
  fork: '--chart-fork',
};

/** 兜底色：样式未加载（构建前、测试环境）时也不能画出不可读的图表。 */
const FALLBACK: Record<EffectiveTheme, ChartPalette> = {
  light: {
    grid: 'rgba(203, 213, 225, 0.7)',
    label: '#5d697a',
    tooltip: '#ffffff',
    tooltipText: '#172033',
    star: '#047857',
    fork: '#0369a1',
  },
  dark: {
    grid: 'rgba(51, 65, 85, 0.5)',
    label: '#94a3b8',
    tooltip: 'rgba(15, 23, 42, 0.95)',
    tooltipText: '#e2e8f0',
    star: '#34d399',
    fork: '#38bdf8',
  },
};

/** 按当前主题解析图表配色：优先读 CSS 变量，读不到用兜底。 */
export function resolveChartPalette(theme: EffectiveTheme): ChartPalette {
  const fallback = FALLBACK[theme];
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return fallback;
  const computed = window.getComputedStyle(document.documentElement);
  const read = (key: keyof ChartPalette): string =>
    computed.getPropertyValue(VARIABLES[key]).trim() || fallback[key];
  return {
    grid: read('grid'),
    label: read('label'),
    tooltip: read('tooltip'),
    tooltipText: read('tooltipText'),
    star: read('star'),
    fork: read('fork'),
  };
}
