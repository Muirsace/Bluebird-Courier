import { forwardRef, useEffect, useRef, useState } from 'react';
import { formatRelativeTime } from '../../lib/time';
import { RepositoryActions } from './RepositoryActions';
import { RepositoryMotionItem } from './RepositoryMotionItem';
import type { RepositoryItemProps } from './RepositoryMotionItem';

interface RepositorySidebarRowProps extends RepositoryItemProps {
  selected: boolean;
}

/** Desktop repository switcher; data and navigation remain owned by Watchlist / App. */
export const RepositorySidebarRow = forwardRef<HTMLLIElement, RepositorySidebarRowProps>(function RepositorySidebarRow({
  selected, ...props
}, forwardedRef) {
  const { repo, onOpen, onRemove } = props;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [press, setPress] = useState<'idle' | 'pressed' | 'released'>('idle');
  const releasePress = (): void => setPress((current) => current === 'pressed' ? 'released' : current);
  useEffect(() => {
    if (press !== 'released') return;
    // A rapid click / Reduced Motion may produce no transitionend. Always retire
    // the release override so later selection uses the frozen 140ms again.
    const duration = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-press-out')) || 110;
    const timeout = window.setTimeout(() => setPress((current) => current === 'released' ? 'idle' : current), duration);
    return () => window.clearTimeout(timeout);
  }, [press]);
  useEffect(() => {
    if (press !== 'pressed') return;
    const release = (): void => setPress('released');
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
    };
  }, [press]);
  const release = repo.latestReleaseTag ?? '无发版';
  return (
    <RepositoryMotionItem ref={forwardedRef} {...props}>
      {(exiting) => (
        <div className="repository-sidebar-row" data-selected={selected ? 'true' : undefined}
          data-pressed={press === 'pressed' && !exiting ? 'true' : undefined}
          data-press-released={press === 'released' && !exiting ? 'true' : undefined}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === 'background-color') {
              setPress((current) => current === 'released' ? 'idle' : current);
            }
          }}>
          <button
            ref={triggerRef}
            type="button"
            className="repository-sidebar-activator"
            aria-label={`查看 ${repo.fullName} 详情`}
            aria-pressed={selected}
            aria-haspopup="menu"
            title={repo.fullName}
            data-button-motion="surface"
            data-row-activator
            disabled={exiting}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              setPress('pressed');
            }}
            onPointerUp={releasePress}
            onPointerCancel={releasePress}
            onPointerLeave={releasePress}
            onBlur={releasePress}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setPress('pressed');
            }}
            onKeyUp={(event) => {
              if (event.key === 'Enter' || event.key === ' ') releasePress();
            }}
            onClick={(event) => {
              if (!event.currentTarget.closest('li')?.hasAttribute('inert')) onOpen(repo);
            }}
          >
            <span className="repository-sidebar-name font-mono">{repo.name}</span>
            <span className="repository-sidebar-metadata">
              <span className="repository-sidebar-secondary">
                <span className="repository-sidebar-owner" title={repo.owner}>{repo.owner}</span>
                <span aria-hidden="true">·</span>
                <span className="repository-sidebar-release font-mono" title={release}>{release}</span>
              </span>
              <span className="repository-sidebar-activity" aria-label={`最近活动 ${formatRelativeTime(repo.pushedAt)}`}>
                {formatRelativeTime(repo.pushedAt)}
              </span>
            </span>
          </button>
          <RepositoryActions repo={repo} onRemove={onRemove} disabled={exiting} contextTriggerRef={triggerRef} />
        </div>
      )}
    </RepositoryMotionItem>
  );
});
