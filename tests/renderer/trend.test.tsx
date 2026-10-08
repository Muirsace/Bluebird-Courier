// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Detail, Snapshot } from '../../src/shared/types';
import {
  DEFAULT_TREND_RANGE,
  describeInsufficient,
  describeSpan,
  filterByRange,
  orderSnapshots,
  summarizeMetric,
} from '../../src/renderer/lib/trend';
import { formatCount, formatDelta } from '../../src/renderer/lib/format';
import type { RenderResult, StubHandle } from './helpers';
import {
  chartConfigs,
  click,
  createStub,
  daysAgoIso,
  makeGlance,
  makeSnapshot,
  navButton,
  openRepo,
  renderApp,
  sectionByTitle,
  segmentedButton,
  settle,
  tab,
  trendCard,
} from './helpers';

// happy-dom 画不出 canvas：用桩把传给 Chart.js 的配置摊到 DOM 上（见 chart-stub.tsx）
vi.mock('react-chartjs-2', () => import('./chart-stub'));

const REPO = 'octocat/Hello-World';
const TREND_FIXTURE_TODAY = new Date('2026-09-27T00:00:00');

function trendFixtureDaysAgoIso(daysAgo: number): string {
  const date = new Date(TREND_FIXTURE_TODAY);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

let view: RenderResult | null = null;

beforeEach(() => {
  // 固定"现在"为正午：快照都在本地 0 点，7 天窗口边界与任何数据点都隔 12 小时
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-27T12:00:00'));
});

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
  vi.useRealTimers();
});

function mmdd(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

type ChartConfig = ReturnType<typeof chartConfigs>[number];

/** 取第 index 张图的配置；不存在直接报错，省得每处都判空。 */
function chartAt(index: number): ChartConfig {
  const chart = chartConfigs()[index];
  if (!chart) throw new Error(`第 ${index} 张图表不存在`);
  return chart;
}

/** 第 index 张图的第一条数据线。 */
function seriesAt(index: number): ChartConfig['datasets'][number] {
  const dataset = chartAt(index).datasets[0];
  if (!dataset) throw new Error(`第 ${index} 张图表没有数据线`);
  return dataset;
}

/** 进某个仓库的详情、切到指定 Tab。 */
async function openDetailTab(detail: Partial<Detail>, label: string): Promise<StubHandle> {
  const handle = createStub({ repositories: [makeGlance(1, REPO)], detail });
  view = await renderApp(handle);
  await openRepo(REPO);
  await click(tab(label));
  await settle();
  return handle;
}

// ---------- 纯计算层：不依赖 DOM ----------

describe('趋势计算 · orderSnapshots', () => {
  it('按时间升序且不修改入参；时间戳无效的记录被丢弃', () => {
    const input: Snapshot[] = [
      makeSnapshot(daysAgoIso(1), 10, 1),
      makeSnapshot('不是时间', 99, 99),
      makeSnapshot(daysAgoIso(3), 30, 3),
      makeSnapshot(daysAgoIso(2), 20, 2),
    ];
    const before = input.map((snapshot) => snapshot.capturedAt);

    const ordered = orderSnapshots(input);

    expect(ordered.map((snapshot) => snapshot.stars)).toEqual([30, 20, 10]);
    expect(input.map((snapshot) => snapshot.capturedAt)).toEqual(before);
    expect(ordered).not.toBe(input);
  });
});

describe('趋势计算 · 范围与变化量', () => {
  it('时间范围只保留窗口内的记录', () => {
    const now = Date.parse(daysAgoIso(0));
    const snapshots = orderSnapshots([
      makeSnapshot(daysAgoIso(0), 100, 10),
      makeSnapshot(daysAgoIso(7), 93, 3),
      makeSnapshot(daysAgoIso(8), 92, 2),
    ]);

    expect(filterByRange(snapshots, '7d', now).map((s) => s.stars)).toEqual([93, 100]);
    expect(filterByRange(snapshots, 'all', now).map((s) => s.stars)).toEqual([92, 93, 100]);
  });

  it('stars / forks 各自独立计算变化量', () => {
    const now = Date.parse(daysAgoIso(0));
    const snapshots = [
      makeSnapshot(daysAgoIso(2), 236_787, 28_463),
      makeSnapshot(daysAgoIso(0), 236_929, 28_484),
    ];

    const stars = summarizeMetric(snapshots, 'stars', '7d', now);
    const forks = summarizeMetric(snapshots, 'forks', '7d', now);

    expect(stars.delta).toBe(142);
    expect(stars.current).toBe(236_929);
    expect(forks.delta).toBe(21);
    expect(forks.current).toBe(28_484);
    expect(stars.spanDays).toBe(2);
  });

  it('有效数值点不足 2 个时不计算变化量', () => {
    const now = Date.parse(daysAgoIso(0));

    expect(summarizeMetric([], 'stars', '7d', now).status).toBe('empty');
    expect(summarizeMetric([], 'stars', '7d', now).delta).toBeNull();

    const single = summarizeMetric([makeSnapshot(daysAgoIso(1), 100, 10)], 'stars', '7d', now);
    expect(single.status).toBe('insufficient');
    expect(single.delta).toBeNull();
    expect(single.current).toBe(100);

    const withNulls = summarizeMetric(
      [
        makeSnapshot(daysAgoIso(2), null, null),
        makeSnapshot(daysAgoIso(1), 100, null),
        makeSnapshot(daysAgoIso(0), null, null),
      ],
      'stars',
      '7d',
      now,
    );
    expect(withNulls.status).toBe('insufficient');
    expect(withNulls.delta).toBeNull();
    expect(withNulls.values).toEqual([null, 100, null]);
  });

  it('范围没被真实数据填满时只承认实际记录天数', () => {
    expect(describeSpan('7d', 7)).toBe('过去 7 天');
    expect(describeSpan('7d', 2)).toBe('已记录 2 天');
    expect(describeSpan('30d', 9)).toBe('已记录 9 天');
    expect(describeSpan('all', 12)).toBe('已记录 12 天');
    expect(describeInsufficient([])).toBe('该时间范围内暂无记录');
    expect(describeInsufficient([makeSnapshot(daysAgoIso(1), 1, 1)])).toBe(
      '该时间范围内的记录不足 2 次，无法计算变化',
    );
  });

  it('变化量与数字格式：带符号、千分位、不缩写', () => {
    expect(formatDelta(142)).toBe('+142');
    expect(formatDelta(-12)).toBe('-12');
    expect(formatDelta(0)).toBe('0');
    expect(formatDelta(null)).toBeNull();
    expect(formatCount(236_929)).toBe('236,929');
    expect(formatCount(null)).toBe('—');
  });
});

// ---------- 渲染层：空态与两张独立的图 ----------

describe('趋势 · 空态与积累态', () => {
  it('0 条快照：说明随抓取积累，不画图也不显示 +0', async () => {
    await openDetailTab({ trend: [] }, '趋势');

    expect(document.body.textContent).toContain('暂无趋势数据，完成更多抓取后这里会显示变化。');
    expect(trendCard('stars')).toBeNull();
    expect(chartConfigs()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('+0');
  });

  it('1 条快照：给出首次记录的值并说明还需更多历史', async () => {
    await openDetailTab({ trend: [makeSnapshot(daysAgoIso(0), 236_929, 28_484)] }, '趋势');

    expect(document.body.textContent).toContain('已有首次记录，需要更多历史记录才能生成趋势。');
    expect(document.body.textContent).toContain('236,929');
    expect(document.body.textContent).toContain('28,484');
    expect(chartConfigs()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('+0');
  });

  it('2 条以上：Stars / Forks 各一张图，各自只有一条数据线', async () => {
    await openDetailTab(
      {
        trend: [
          makeSnapshot(daysAgoIso(2), 236_787, 28_463),
          makeSnapshot(daysAgoIso(1), 236_850, 28_470),
          makeSnapshot(daysAgoIso(0), 236_929, 28_484),
        ],
      },
      '趋势',
    );

    const charts = chartConfigs();
    expect(charts).toHaveLength(2);
    expect(charts.map((chart) => chart.datasets.map((dataset) => dataset.label))).toEqual([
      ['Stars'],
      ['Forks'],
    ]);
    // 两张图各自独立：任何一张都不带另一条线
    expect(charts.every((chart) => chart.datasets.length === 1)).toBe(true);
    expect(seriesAt(0).data).toEqual([236_787, 236_850, 236_929]);
    expect(seriesAt(1).data).toEqual([28_463, 28_470, 28_484]);
    // 单条线不需要图例
    expect(charts.every((chart) => chart.legendDisplay === false)).toBe(true);
  });

  it('快照乱序时仍按时间升序画图', async () => {
    const day0 = daysAgoIso(0);
    const day1 = daysAgoIso(1);
    const day2 = daysAgoIso(2);
    await openDetailTab(
      {
        trend: [
          makeSnapshot(day0, 300, 30),
          makeSnapshot(day2, 100, 10),
          makeSnapshot(day1, 200, 20),
        ],
      },
      '趋势',
    );

    expect(chartAt(0).labels).toEqual([mmdd(day2), mmdd(day1), mmdd(day0)]);
    expect(seriesAt(0).data).toEqual([100, 200, 300]);
  });

  it('变化量以文本给出：图表不是唯一信息来源', async () => {
    await openDetailTab(
      {
        trend: [
          makeSnapshot(daysAgoIso(2), 236_787, 28_463),
          makeSnapshot(daysAgoIso(0), 236_929, 28_484),
        ],
      },
      '趋势',
    );

    const stars = trendCard('stars');
    const forks = trendCard('forks');
    expect(stars?.textContent).toContain('+142');
    expect(stars?.textContent).toContain('已记录 2 天');
    expect(stars?.textContent).toContain('数据范围');
    expect(forks?.textContent).toContain('+21');
    // 默认范围被真实数据填不满时不谎称"过去 7 天"
    expect(stars?.textContent).not.toContain('过去 7 天');
  });
});

// ---------- 渲染层：时间范围 ----------

describe('趋势 · 时间范围', () => {
  const TEN_DAYS = Array.from({ length: 10 }, (_, index) =>
    makeSnapshot(trendFixtureDaysAgoIso(9 - index), 1_000 + index, 100 + index),
  );

  it('范围切换只做本地过滤，点数与变化量随之变化', async () => {
    await openDetailTab({ trend: TEN_DAYS }, '趋势');

    // 10 天记录里，7D 窗口覆盖到 7 天前 0 点之前 → 剩 7 个点
    expect(seriesAt(0).data).toHaveLength(7);
    expect(trendCard('stars')?.textContent).toContain('+6');
    expect(trendCard('stars')?.textContent).toContain('已记录 6 天');

    await click(segmentedButton('30D'));
    await settle();

    expect(seriesAt(0).data).toHaveLength(10);
    expect(trendCard('stars')?.textContent).toContain('+9');
    expect(trendCard('stars')?.textContent).toContain('已记录 9 天');
  });

  it('只提供有数据支撑的范围：7D / 30D，并说明当前保留期', async () => {
    await openDetailTab({ trend: TEN_DAYS }, '趋势');

    expect(segmentedButton('7D')?.getAttribute('aria-pressed')).toBe('true');
    expect(segmentedButton('30D')?.getAttribute('aria-pressed')).toBe('false');
    // 90D 不提供：当前保留期只有 30 天，给出 90D 会让人误以为有完整历史
    expect(segmentedButton('90D')).toBeNull();
    expect(document.querySelector('[role="group"] button')?.parentElement?.textContent)
      .not.toContain('90D');
    expect(sectionByTitle('趋势')?.textContent).toContain('趋势按自然日保留最近 30 天记录。');
    expect(DEFAULT_TREND_RANGE).toBe('7d');

    await click(segmentedButton('30D'));
    await settle();
    expect(segmentedButton('30D')?.getAttribute('aria-pressed')).toBe('true');
    expect(segmentedButton('7D')?.getAttribute('aria-pressed')).toBe('false');
  });
});

// ---------- 渲染层：双主题 ----------

describe('趋势 · 双主题', () => {
  const TWO_POINTS = [
    makeSnapshot(trendFixtureDaysAgoIso(1), 100, 10),
    makeSnapshot(trendFixtureDaysAgoIso(0), 120, 12),
  ];

  it('主题切换后两条线各自使用对应的 chart-star / chart-fork token', async () => {
    const light = createStub({
      repositories: [makeGlance(1, REPO)],
      detail: { trend: TWO_POINTS },
      preferences: { theme: 'light' },
    });
    view = await renderApp(light);
    await openRepo(REPO);
    await click(tab('趋势'));
    await settle();
    const lightColors = chartConfigs().map((chart) => chart.datasets[0]?.color ?? '');
    await view.unmount();
    view = null;

    const dark = createStub({
      repositories: [makeGlance(1, REPO)],
      detail: { trend: TWO_POINTS },
      preferences: { theme: 'dark' },
    });
    view = await renderApp(dark);
    await openRepo(REPO);
    await click(tab('趋势'));
    await settle();
    const darkColors = chartConfigs().map((chart) => chart.datasets[0]?.color ?? '');

    expect(lightColors).toHaveLength(2);
    expect(darkColors).toHaveLength(2);
    expect(new Set(lightColors).size).toBe(2);
    expect(lightColors).not.toEqual(darkColors);
  });
});

// ---------- 网络行为：切范围 / 切 Tab / 切主题都不重抓 ----------

describe('趋势 · 不产生额外请求', () => {
  it('切范围、切 Tab、切主题都不增加 fetchDetail', async () => {
    const handle = await openDetailTab(
      {
        trend: [
          makeSnapshot(daysAgoIso(2), 100, 10),
          makeSnapshot(daysAgoIso(1), 110, 11),
          makeSnapshot(daysAgoIso(0), 120, 12),
        ],
      },
      '趋势',
    );
    expect(handle.calls.fetchDetail).toBe(1);

    await click(segmentedButton('30D'));
    await settle();
    await click(segmentedButton('7D'));
    await settle();
    expect(handle.calls.fetchDetail).toBe(1);

    for (const label of ['发版', '提交', 'Issue & PR', '构建', '概览', '趋势']) {
      await click(tab(label));
      await settle();
    }
    expect(handle.calls.fetchDetail).toBe(1);

    // 去设置换成深色再回来：缓存命中，只表达一次打开意图，没有强制命令
    await click(navButton('设置'));
    await settle();
    await click(segmentedButton('深色'));
    await settle();
    await click(navButton('监控清单'));
    await settle();
    await openRepo(REPO);
    expect(handle.calls.fetchDetail).toBe(2);
    expect(handle.calls.refreshRepository).toBe(0);
  });
});
