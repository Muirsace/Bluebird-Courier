import { useState } from 'react';
import type { Detail } from '../../../shared/types';
import { DEFAULT_TREND_RANGE } from '../../lib/trend';
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
      <TrendPanel trend={trend} scope={range} />
    </Section>
  );
}
