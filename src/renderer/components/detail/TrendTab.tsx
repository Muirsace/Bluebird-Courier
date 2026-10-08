import { useState } from 'react';
import type { Detail } from '../../../shared/types';
import { DEFAULT_TREND_RANGE, TREND_RETENTION_NOTE } from '../../lib/trend';
import type { TrendRange } from '../../lib/trend';
import { Section } from '../Section';
import { TrendPanel } from './TrendPanel';
import { TrendRangeSelector } from './TrendRangeSelector';

/** 「趋势」Tab：时间范围选择 + Stars / Forks 两张独立趋势图。范围切换纯本地过滤。 */
export function TrendTab({ trend }: { trend: Detail['trend'] }) {
  const [range, setRange] = useState<TrendRange>(DEFAULT_TREND_RANGE);

  return (
    <Section
      title="趋势"
      action={<TrendRangeSelector value={range} onChange={setRange} />}
    >
      {/* 只提供有数据支撑的范围：不给出会让人误以为有完整 90 日历史的入口。 */}
      <p className="mb-2 text-xs text-muted">{TREND_RETENTION_NOTE}</p>
      <TrendPanel trend={trend} scope={range} />
    </Section>
  );
}
