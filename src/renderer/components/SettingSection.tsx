import type { ReactNode } from 'react';

interface SettingSectionProps {
  title: string;
  children: ReactNode;
}

/** 设置页分组：Section 标题在卡片外，层级由间距表达。 */
export function SettingSection({ title, children }: SettingSectionProps) {
  return (
    <section className="settings-section">
      <h2 className="settings-section-heading text-sm font-semibold text-primary">{title}</h2>
      <div className="settings-section-card rounded-lg border border-subtle bg-surface p-4">{children}</div>
    </section>
  );
}
