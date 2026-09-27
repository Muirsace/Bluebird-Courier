import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  hint?: string;
  children?: ReactNode;
}

/** 空态占位：虚线卡片 + 说明文案。 */
export function EmptyState({ title, hint, children }: EmptyStateProps) {
  return (
    <div className="rounded-lg border border-dashed border-strong bg-surface/50 px-6 py-10 text-center">
      <p className="text-sm font-medium text-primary">{title}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      {children ? <div className="mt-4 flex justify-center">{children}</div> : null}
    </div>
  );
}
