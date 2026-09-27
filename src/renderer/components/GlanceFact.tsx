interface GlanceFactProps {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
  muted?: boolean;
}

/** 轻量信息 / 全量信息表头里的一条"标签 + 值"事实。 */
export function GlanceFact({ label, value, mono = false, accent = false, muted = false }: GlanceFactProps) {
  const valueColor = accent ? 'text-accent' : muted ? 'text-muted' : 'text-primary';
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-xs text-muted">{label}</span>
      <span
        className={`min-w-0 text-[15px] font-semibold leading-5 ${valueColor} ${mono ? 'break-all font-mono text-[13px]' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}
