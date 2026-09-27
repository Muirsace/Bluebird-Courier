import type { Snapshot } from '../../../shared/types';
import { formatCount } from '../../lib/format';
import { METRIC_LABELS, orderSnapshots, summarizeMetric } from '../../lib/trend';
import type { TrendMetricName, TrendScope } from '../../lib/trend';
import { TrendMetric } from './TrendMetric';

const METRICS: readonly TrendMetricName[] = ['stars', 'forks'];

interface TrendPanelProps {
  trend: Snapshot[];
  scope: TrendScope;
  /** 概览摘要用紧凑版：矮图、无坐标轴。 */
  compact?: boolean;
}

/**
 * 趋势面板：0 / 1 条快照时只给诚实说明（不画图、不显示"+0"），
 * 2 条以上才画 Stars 与 Forks 两张各自独立 Y 轴的图。
 */
export function TrendPanel({ trend, scope, compact = false }: TrendPanelProps) {
  const ordered = orderSnapshots(trend);

  if (ordered.length === 0) {
    return (
      <p className="rounded-md bg-surface-raised px-4 py-6 text-center text-xs text-muted">
        暂无趋势数据，完成更多抓取后这里会显示变化。
      </p>
    );
  }

  const [only] = ordered;
  if (only && ordered.length === 1) {
    return (
      <div className="rounded-md bg-surface-raised px-4 py-4 text-xs">
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-secondary">
          {METRICS.map((metric) => (
            <span key={metric}>
              {METRIC_LABELS[metric]} <span className="font-semibold text-primary">{formatCount(only[metric])}</span>
            </span>
          ))}
        </p>
        <p className="mt-1 text-muted">已有首次记录，需要更多历史记录才能生成趋势。</p>
      </div>
    );
  }

  const now = Date.now();
  return (
    <div className={`grid min-w-0 gap-4 ${compact ? 'sm:grid-cols-2' : 'md:grid-cols-2'}`}>
      {METRICS.map((metric) => (
        <div key={metric} className="min-w-0">
          <TrendMetric summary={summarizeMetric(ordered, metric, scope, now)} scope={scope} compact={compact} />
        </div>
      ))}
    </div>
  );
}
