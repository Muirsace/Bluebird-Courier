import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  hint?: string;
  children?: ReactNode;
}

/** 清单为空：保留添加引导，区别于未选择仓库的 Workspace。 */
export function EmptyState({ title, hint, children }: EmptyStateProps) {
  return (
    <div className="state-list-empty min-w-0 rounded-md bg-surface-raised px-4 py-6 text-center">
      <p className="text-sm font-medium text-primary">{title}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      {children ? <div className="mt-4 flex justify-center">{children}</div> : null}
    </div>
  );
}
