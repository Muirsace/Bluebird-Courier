/**
 * 趋势计算：全部基于已抓取的历史快照在本地完成，不产生任何网络请求。
 *
 * 快照按本地日期每日一档（见主进程 snapshots.ts），因此"记录跨度"用时间差取整到天，
 * 并至少算 1 天——连续两天但都在午夜前后抓取时，时间差不足 24 小时也算两天。
 */
import type { Snapshot } from '../../shared/types';

export type TrendMetricName = 'stars' | 'forks';

/** 可选时间范围；`all` = 已记录的全部历史（概览摘要用）。 */
export type TrendRange = '7d' | '30d' | '90d';
export type TrendScope = TrendRange | 'all';

export const TREND_RANGES: readonly TrendRange[] = ['7d', '30d', '90d'];

export const TREND_RANGE_LABELS: Record<TrendRange, string> = {
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
};

export const TREND_RANGE_DAYS: Record<TrendRange, number> = { '7d': 7, '30d': 30, '90d': 90 };

export const DEFAULT_TREND_RANGE: TrendRange = '7d';

export const METRIC_LABELS: Record<TrendMetricName, string> = { stars: 'Stars', forks: 'Forks' };

const DAY_MS = 86_400_000;

/** 时间戳可解析的快照，按 capturedAt 升序；不修改入参，时间戳无效的直接丢弃。 */
export function orderSnapshots(snapshots: readonly Snapshot[]): Snapshot[] {
  return snapshots
    .map((snapshot) => ({ snapshot, time: Date.parse(snapshot.capturedAt) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time)
    .map((entry) => entry.snapshot);
}

/** 只保留落在窗口内的快照（含两端）；`all` 原样返回。入参需已按时间升序。 */
export function filterByRange(
  snapshots: readonly Snapshot[],
  scope: TrendScope,
  now: number,
): Snapshot[] {
  if (scope === 'all') return [...snapshots];
  const from = now - TREND_RANGE_DAYS[scope] * DAY_MS;
  return snapshots.filter((snapshot) => {
    const time = Date.parse(snapshot.capturedAt);
    return time >= from && time <= now;
  });
}

export interface MetricSummary {
  metric: TrendMetricName;
  /** 窗口内、按时间升序的快照。 */
  points: Snapshot[];
  /** 与 points 对齐的取值序列（可为 null，图表按 spanGaps 连线）。 */
  values: (number | null)[];
  /** 窗口内最新一个非空值；没有则为 null。 */
  current: number | null;
  /** 窗口内最早一个非空值；没有则为 null。 */
  baseline: number | null;
  /** current - baseline；有效数值点不足 2 个时为 null——不伪造增长量。 */
  delta: number | null;
  /** 窗口内的记录跨度（天，至少 1）；不足 2 个点时为 null。 */
  spanDays: number | null;
  /** empty = 窗口内无记录；insufficient = 有记录但凑不出变化量；ready = 可画可算。 */
  status: 'empty' | 'insufficient' | 'ready';
}

function readValue(snapshot: Snapshot, metric: TrendMetricName): number | null {
  const value = snapshot[metric];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 取首尾两项；空数组返回 null。 */
function firstAndLast<T>(items: readonly T[]): [T, T] | null {
  const first = items[0];
  const last = items.length > 0 ? items[items.length - 1] : undefined;
  return first === undefined || last === undefined ? null : [first, last];
}

/** 单个指标的窗口内摘要：当前值、基线值、变化量与记录跨度。 */
export function summarizeMetric(
  snapshots: readonly Snapshot[],
  metric: TrendMetricName,
  scope: TrendScope,
  now: number = Date.now(),
): MetricSummary {
  const points = filterByRange(orderSnapshots(snapshots), scope, now);
  const values = points.map((snapshot) => readValue(snapshot, metric));
  const numbers = values.filter((value): value is number => value !== null);

  const bounds = firstAndLast(points);
  const numberBounds = firstAndLast(numbers);
  const spanDays =
    bounds && points.length >= 2
      ? Math.max(
          1,
          Math.round((Date.parse(bounds[1].capturedAt) - Date.parse(bounds[0].capturedAt)) / DAY_MS),
        )
      : null;

  if (!bounds) {
    return {
      metric,
      points,
      values,
      current: null,
      baseline: null,
      delta: null,
      spanDays: null,
      status: 'empty',
    };
  }

  // 有效数值不足 2 个：不计算变化量，但把已有的唯一值照样显示出来
  if (!numberBounds || points.length < 2 || numbers.length < 2) {
    return {
      metric,
      points,
      values,
      current: numberBounds?.[0] ?? null,
      baseline: null,
      delta: null,
      spanDays,
      status: 'insufficient',
    };
  }

  const [baseline, current] = numberBounds;
  return {
    metric,
    points,
    values,
    current,
    baseline,
    delta: current - baseline,
    spanDays,
    status: 'ready',
  };
}

/** 记录范围说明：范围被真实数据填满说"过去 N 天"，否则只承认实际记录到的天数。 */
export function describeSpan(scope: TrendScope, spanDays: number | null): string {
  if (spanDays === null) return '';
  if (scope === 'all') return `已记录 ${spanDays} 天`;
  const days = TREND_RANGE_DAYS[scope];
  return spanDays >= days ? `过去 ${days} 天` : `已记录 ${spanDays} 天`;
}

/** 凑不出变化量时的说明：不显示 "+0"，避免让人以为整个时间范围都有数据。 */
export function describeInsufficient(points: readonly Snapshot[]): string {
  if (points.length === 0) return '该时间范围内暂无记录';
  return '该时间范围内的记录不足 2 次，无法计算变化';
}
