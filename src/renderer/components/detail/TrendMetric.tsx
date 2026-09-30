import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js';
import type { ChartData, ChartOptions } from 'chart.js';
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
function metricOptions(palette: ChartPalette, compact: boolean): ChartOptions<'line'> {
  const axis = {
    ticks: { color: palette.label },
    grid: { color: palette.grid },
  };
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      // 只有一条数据线，图例是噪音
      legend: { display: false },
      tooltip: {
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
  const palette = resolveChartPalette(theme);

  const { metric, points, values, current, delta, spanDays, status } = summary;
  const label = METRIC_LABELS[metric];
  const color = metric === 'stars' ? palette.star : palette.fork;
  const deltaText = formatDelta(delta);
  const deltaTone = delta === 0 ? 'text-muted' : delta !== null && delta > 0 ? 'text-success' : 'text-danger';
  const first = points[0];
  const last = points[points.length - 1];

  const data: ChartData<'line', (number | null)[], string> = {
    labels: points.map((snapshot) => formatShortDate(snapshot.capturedAt)),
    datasets: [
      {
        label,
        data: values,
        borderColor: color,
        backgroundColor: color,
        tension: 0.25,
        spanGaps: true,
        pointRadius: compact ? 0 : 3,
        borderWidth: compact ? 1.5 : 2,
      },
    ],
  };

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
        <div className={compact ? 'mt-2 h-16' : 'mt-3 h-56'}>
          <Line role="img" aria-label={`${label} 趋势折线图`} options={metricOptions(palette, compact)} data={data} />
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
