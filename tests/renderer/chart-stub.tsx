/**
 * react-chartjs-2 的测试替身。
 *
 * happy-dom 的 canvas.getContext('2d') 返回 null，Chart.js 在测试环境里画不出任何像素
 * （已实测：不报错，但 canvas 是空的）。所以渲染层测试改用这个桩，把真正传给 Chart.js 的
 * data / options 摊成 `data-chart` 属性，用来断言"配置对不对"；
 * 真实绘制效果与配色由浏览器桩页面（.scratch/verify）采样 canvas 像素验证。
 */
interface StubDataset {
  label?: string;
  data?: Array<number | null>;
  borderColor?: string;
}

interface StubLineProps {
  data?: { labels?: unknown[]; datasets?: StubDataset[] };
  options?: {
    plugins?: { legend?: { display?: boolean } };
    scales?: {
      x?: { display?: boolean };
      y?: { display?: boolean };
    };
  };
  'aria-label'?: string;
}

export function Line({ data, options, ...rest }: StubLineProps) {
  const config = {
    labels: (data?.labels ?? []).map((label) => String(label)),
    datasets: (data?.datasets ?? []).map((dataset) => ({
      label: dataset.label ?? '',
      data: dataset.data ?? [],
      color: dataset.borderColor ?? '',
    })),
    legendDisplay: options?.plugins?.legend?.display ?? null,
    xDisplay: options?.scales?.x?.display ?? null,
    yDisplay: options?.scales?.y?.display ?? null,
    ariaLabel: rest['aria-label'] ?? null,
  };
  return <div data-chart={JSON.stringify(config)} />;
}
