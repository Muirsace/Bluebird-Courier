// @vitest-environment happy-dom
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chart, ChartOptions, Plugin } from 'chart.js';
import { TrendMetric } from '../../src/renderer/components/detail/TrendMetric';
import { summarizeMetric } from '../../src/renderer/lib/trend';
import type { TrendScope } from '../../src/renderer/lib/trend';
import { useTheme } from '../../src/renderer/lib/theme';
import { readRendererStyles } from './support/styles';
import { click, createStub, daysAgoIso, makeSnapshot, renderNode, resetReducedMotion, setReducedMotion, settle } from './helpers';
import type { RenderResult } from './helpers';

const capture = vi.hoisted(() => ({ updates: [] as { duration: number; resize: number; active: number; values: unknown }[] }));
vi.mock('react-chartjs-2', async () => {
  const { useEffect, useRef } = await import('react');
  return { Line: ({ data, options, plugins }: { data: { labels: unknown[]; datasets: { data: unknown }[] }; options: ChartOptions<'line'>; plugins: Plugin<'line'>[] }) => {
    const chart = useRef({} as Chart<'line'>);
    useEffect(() => {
      chart.current.options = { ...options, animation: options.animation && { ...options.animation } };
      for (const plugin of plugins) plugin.beforeUpdate?.(chart.current, { mode: 'default', cancelable: true }, {});
      const animation = chart.current.options.animation;
      capture.updates.push({ duration: animation ? Number(animation.duration) : 0, resize: Number(options.transitions?.resize?.animation?.duration), active: Number(options.transitions?.active?.animation?.duration), values: data.datasets[0]?.data });
    }, [data.labels, data.datasets, options, plugins]);
    return <canvas />;
  } };
});

let view: RenderResult | null = null;
afterEach(async () => { await view?.unmount(); view = null; capture.updates.length = 0; resetReducedMotion(); });
function Harness() {
  const [scope, setScope] = useState<TrendScope>('7d');
  const [value, setValue] = useState(120);
  const [, rerender] = useState(0);
  const theme = useTheme();
  const points = [makeSnapshot(daysAgoIso(2), 100, 10), makeSnapshot(daysAgoIso(0), value, 12)];
  return <>
    <button onClick={() => setScope('30d')}>range</button>
    <button onClick={() => setScope('7d')}>range7</button>
    <button onClick={() => setValue(150)}>data</button>
    <button onClick={() => rerender(n => n + 1)}>unrelated</button>
    <button onClick={() => theme.setPreference('dark')}>theme</button>
    <TrendMetric scope={scope} summary={summarizeMetric(points, 'stars', scope, Date.now())} />
  </>;
}
async function mount(reduced = false) {
  setReducedMotion(reduced);
  view = await renderNode(createStub({ preferences: { theme: 'light' } }), <Harness />);
  await settle();
}
async function trigger(text: string) {
  await click([...document.querySelectorAll('button')].find(button => button.textContent === text)); await settle();
}
describe('Trend native animation boundary', () => {
  it('first 2+ snapshot reveal uses 300ms with unchanged values', async () => {
    await mount(); expect(capture.updates[0]?.duration).toBe(300); expect(capture.updates[0]?.values).toEqual([100, 120]);
  });
  it('range switches request animation even when 7D/30D contain the same points', async () => {
    await mount(); await trigger('range'); expect(capture.updates.at(-1)?.duration).toBe(300);
    await trigger('range7'); expect(capture.updates.at(-1)?.duration).toBe(300);
  });
  it('actual dataset change animates on the same Canvas', async () => {
    await mount(); const canvas = document.querySelector('canvas'); await trigger('data');
    expect(capture.updates.at(-1)?.duration).toBe(300); expect(capture.updates.at(-1)?.values).toEqual([100, 150]);
    expect(document.querySelector('canvas')).toBe(canvas);
  });
  it('theme repaint has zero duration and unrelated rerender does not update chart', async () => {
    await mount(); await trigger('theme'); expect(capture.updates.at(-1)?.duration).toBe(0);
    const count = capture.updates.length; await trigger('unrelated'); expect(capture.updates).toHaveLength(count);
  });
  it('resize and hover modes remain instantaneous', async () => {
    await mount(); expect(capture.updates[0]?.resize).toBe(0); expect(capture.updates[0]?.active).toBe(0);
    const count = capture.updates.length; await act(async () => window.dispatchEvent(new Event('resize')));
    expect(capture.updates).toHaveLength(count);
  });
  it('Canvas viewport avoids fractional backing-size resize that cancels first animation', () => {
    expect(readRendererStyles()).toMatch(/\.trend-chart-viewport\s*\{[^}]*width: round\(down, 100%, 1px\);[^}]*max-width: 100%/);
  });
  it('Reduced Motion paints all data with duration 0, including range/data changes', async () => {
    await mount(true); expect(capture.updates[0]?.duration).toBe(0);
    await trigger('range'); await trigger('data'); expect(capture.updates.every(update => update.duration === 0)).toBe(true);
    expect(capture.updates.at(-1)?.values).toEqual([100, 150]); expect(document.querySelector('canvas')).not.toBeNull();
  });
});
