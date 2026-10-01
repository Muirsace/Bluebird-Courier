import type { ReactNode } from 'react';

/** Whole-content guidance. Actions stay outside the optional live message. */
export function WorkspaceMessage({ title, description, leading, children, announcement, className = '' }: {
  title: string;
  description?: ReactNode;
  leading?: ReactNode;
  children?: ReactNode;
  announcement?: 'alert' | 'status';
  className?: string;
}) {
  return (
    <div className={`state-workspace ${className}`}>
      {leading}
      <div role={announcement} aria-atomic={announcement ? true : undefined} className="min-w-0 space-y-2">
        <h2 className="text-base font-semibold text-primary">{title}</h2>
        {description ? <div className="state-description text-sm text-secondary">{description}</div> : null}
      </div>
      {children ? <div className="state-actions">{children}</div> : null}
    </div>
  );
}

/** Quiet, compact no-data information within an existing section. Never a live alert. */
export function SectionMessage({ children }: { children: ReactNode }) {
  return <div className="state-section rounded-md bg-surface-raised px-3 py-3 text-sm text-muted">{children}</div>;
}

const TONES = { neutral: 'text-secondary', success: 'text-success', warning: 'text-warning', danger: 'text-danger', info: 'text-info' } as const;

/** Caller owns lifecycle and announcement priority; this primitive only presents feedback. */
export function InlineFeedback({ children, tone = 'neutral', announcement, id, className = '' }: {
  children: ReactNode;
  tone?: keyof typeof TONES;
  announcement?: 'status' | 'alert';
  id?: string;
  className?: string;
}) {
  return (
    <div id={id} role={announcement} aria-atomic={announcement ? true : undefined}
      className={`state-inline-feedback ${TONES[tone]} ${className}`}>
      {children}
    </div>
  );
}
