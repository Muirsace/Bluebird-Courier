import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js';
import type { ChartData, ChartOptions, Plugin } from 'chart.js';
import { Line } from 'react-chartjs-2';
import { resolveChartPalette } from '../../lib/chart-theme';
import type { ChartPalette } from '../../lib/chart-theme';
import { useEffectiveTheme } from '../../lib/theme';
import { formatCount, formatDelta } from '../../lib/format';
import { METRIC_LABELS, describeInsufficient, describeSpan } from '../../lib/trend';
import type { MetricSummary, TrendScope } from '../../lib/trend';
import { formatShortDate } from '../../lib/time';

// 只注册实际用到的 chart.js 模块
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

/**
 * 单个指标一张图：Stars 与 Forks 各有独立的 Y 轴，不再共用一套刻度。
 * Y 轴按各自的数值范围自适应（不强制从 0 起），否则数量级大的那一条会把另一条压成直线。
 */
function metricOptions(palette: ChartPalette, compact: boolean, reduced: boolean): ChartOptions<'line'> {
  const axis = {
    ticks: { color: palette.label },
    grid: { color: palette.grid },
  };
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: reduced ? 0 : 300, easing: 'easeOutCubic' },
    transitions: {
      resize: { animation: { duration: 0 } },
      active: { animation: { duration: 0 } },
    },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      // 只有一条数据线，图例是噪音
      legend: { display: false },
      tooltip: {
        animation: { duration: 0 },
        backgroundColor: palette.tooltip,
        titleColor: palette.tooltipText,
        bodyColor: palette.tooltipText,
        borderColor: palette.grid,
        borderWidth: 1,
      },
    },
    scales: compact
      ? {
          x: { display: false, grid: { display: false } },
          y: { display: false, grid: { display: false } },
        }
      : {
          x: {
            ticks: { ...axis.ticks, maxRotation: 0, autoSkip: true },
            grid: { color: palette.grid },
          },
          y: axis,
        },
  };
}

interface TrendMetricProps {
  summary: MetricSummary;
  scope: TrendScope;
  /** 概览摘要里的紧凑版：无坐标轴、无刻度、矮高度。 */
  compact?: boolean;
}

/** 一个指标的趋势卡：当前值 + 变化量 + 记录范围（文本）与单条数据线的折线图。 */
export function TrendMetric({ summary, scope, compact = false }: TrendMetricProps) {
  const theme = useEffectiveTheme();
  const reduced = useReducedMotion() === true;
  const [palette, setPalette] = useState(() => resolveChartPalette(theme));
  useEffect(() => {
    let live = true;
    // ThemeProvider applies CSS tokens in its effect. Read them after that commit,
    // rather than caching the previous theme's CSS during render.
    queueMicrotask(() => {
      if (!live) return;
      const next = resolveChartPalette(theme);
      setPalette((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    });
    return () => { live = false; };
  }, [theme]);
  const options = useMemo(() => metricOptions(palette, compact, reduced), [palette, compact, reduced]);

  const { metric, points, values, current, delta, spanDays, status } = summary;
  const label = METRIC_LABELS[metric];
  const color = metric === 'stars' ? palette.star : palette.fork;
  const deltaText = formatDelta(delta);
  const deltaTone = delta === 0 ? 'text-muted' : delta !== null && delta > 0 ? 'text-success' : 'text-danger';
  const first = points[0];
  const last = points[points.length - 1];

  // Summaries are reconstructed on unrelated renders. Compare the actual timeline/values,
  // including scope (30D → 90D can contain identical points), rather than array identity.
  const dataKey = JSON.stringify([scope, points.map((point, index) => [point.capturedAt, values[index]])]);
  const currentMotion = useRef({ dataKey, reduced });
  useLayoutEffect(() => { currentMotion.current = { dataKey, reduced }; }, [dataKey, reduced]);
  // Set native duration at the update boundary, without remounting Canvas.
  // Resize/hover keep their own contract; theme repaints with unchanged data.
  const plugins = useMemo<Plugin<'line'>[]>(() => {
    let lastChart: ChartJS<'line'> | null = null;
    let lastKey: string | null = null;
    return [{
      id: 'trend-data-motion',
      beforeUpdate(chart, args) {
        if (args.mode === 'resize' || args.mode === 'active') return;
        const { dataKey: key, reduced: reduce } = currentMotion.current;
        const changed = lastChart !== chart || lastKey !== key;
        if (chart.options.animation) chart.options.animation.duration = !reduce && changed ? 300 : 0;
        lastChart = chart;
        lastKey = key;
      },
    }];
  }, []);
  const data = useMemo<ChartData<'line', (number | null)[], string>>(() => {
    const [, timeline] = JSON.parse(dataKey) as [TrendScope, [string, number | null][]];
    return {
      labels: timeline.map(([capturedAt]) => formatShortDate(capturedAt)),
      datasets: [
        {
          label,
          data: timeline.map(([, value]) => value),
          borderColor: color,
          backgroundColor: color,
          tension: 0.25,
          spanGaps: true,
          pointRadius: compact ? 0 : 3,
          borderWidth: compact ? 1.5 : 2,
        },
      ],
    };
  }, [dataKey, label, color, compact]);

  return (
    <section data-metric={metric} className="min-w-0 rounded-md bg-surface-raised p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-secondary">{label}</h3>
        <span className="text-base font-semibold text-primary">{formatCount(current)}</span>
      </div>

      {/* 图表不是唯一信息来源：变化量与记录范围都以文本给出 */}
      <p className="mt-0.5 text-xs">
        {deltaText === null ? (
          <span className="text-muted">{describeInsufficient(points)}</span>
        ) : (
          <>
            <span className={deltaTone}>{deltaText}</span>
            <span className="text-muted"> · {describeSpan(scope, spanDays)}</span>
          </>
        )}
      </p>

      {status === 'ready' ? (
        <div className={`trend-chart-viewport ${compact ? 'mt-2 h-16' : 'mt-3 h-56'}`}>
          <Line plugins={plugins} role="img" aria-label={`${label} 趋势折线图`} options={options} data={data} />
        </div>
      ) : null}

      {first && last ? (
        <p className="mt-2 text-xs text-muted">
          数据范围 {formatShortDate(first.capturedAt)} ~ {formatShortDate(last.capturedAt)} · 共 {points.length}{' '}
          次记录
        </p>
      ) : null}
    </section>
  );
}
