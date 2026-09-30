interface GlanceFactProps {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
  /**
   * 给一个"旧值"时做一次短交叉淡化：旧值绝对定位淡出（不参与布局），真值原位淡入。
   * 详情首次抓取完成用它把表头的 `—` 柔和换成真实值；不传就还是原来的纯展示。
   */
  crossfadeFrom?: string;
}

/** 轻量信息 / 全量信息表头里的一条"标签 + 值"事实。 */
export function GlanceFact({
  label,
  value,
  mono = false,
  muted = false,
  crossfadeFrom,
}: GlanceFactProps) {
  const valueColor = muted ? 'text-muted' : 'text-primary';
  const valueClass = `min-w-0 text-[15px] font-semibold leading-5 ${valueColor} ${mono ? 'break-all font-mono text-[13px]' : ''}`;
  const swapping = crossfadeFrom !== undefined && crossfadeFrom !== value;

  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-xs text-muted">{label}</span>
      {swapping ? (
        <span className={`relative ${valueClass}`}>
          {/* 旧值不占位：容器宽度始终按真值算，表头不会因为换值而推挤 */}
          <span aria-hidden="true" className="detail-fact-from absolute left-0 top-0 whitespace-nowrap">
            {crossfadeFrom}
          </span>
          <span className="detail-fact-to">{value}</span>
        </span>
      ) : (
        <span className={valueClass}>{value}</span>
      )}
    </div>
  );
}
