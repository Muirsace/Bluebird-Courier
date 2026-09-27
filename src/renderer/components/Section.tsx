import type { ReactNode } from 'react';

interface SectionProps {
  /** 更新类别名称（发版 / 提交 / 议题与合并请求 / 构建状态 / 星标趋势）。 */
  title: string;
  /** 标题右侧的附加控件（如趋势的时间范围选择）。 */
  action?: ReactNode;
  children: ReactNode;
}

/** 全量信息里的一个更新类别区块。 */
export function Section({ title, action, children }: SectionProps) {
  return (
    <section className="min-w-0 rounded-lg border border-subtle bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold text-primary">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
