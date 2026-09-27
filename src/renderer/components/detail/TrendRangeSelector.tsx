import { TREND_RANGES, TREND_RANGE_LABELS } from '../../lib/trend';
import type { TrendRange } from '../../lib/trend';

interface TrendRangeSelectorProps {
  value: TrendRange;
  onChange: (range: TrendRange) => void;
}

/** 时间范围分段控件：纯本地过滤，不产生任何请求。 */
export function TrendRangeSelector({ value, onChange }: TrendRangeSelectorProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id="trend-range-label" className="text-xs text-secondary">
        时间范围
      </span>
      <div
        role="group"
        aria-labelledby="trend-range-label"
        className="inline-flex h-8 overflow-hidden rounded-md border border-default"
      >
        {TREND_RANGES.map((range) => {
          const active = range === value;
          return (
            <button
              key={range}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(range)}
              className={`h-full border-l border-default px-3 text-xs transition-colors duration-150 ease-out first:border-l-0 focus-visible:outline-offset-[-3px] ${
                active
                  ? 'bg-accent-soft font-medium text-accent active:bg-surface-active'
                  : 'text-secondary hover:bg-surface-hover hover:text-primary active:bg-surface-active'
              }`}
            >
              {TREND_RANGE_LABELS[range]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
