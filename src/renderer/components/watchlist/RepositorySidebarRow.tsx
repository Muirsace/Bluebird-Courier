import { forwardRef } from 'react';
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
  const release = repo.latestReleaseTag ?? '无发版';
  return (
    <RepositoryMotionItem ref={forwardedRef} {...props}>
      {(exiting) => (
        <div className="repository-sidebar-row" data-selected={selected ? 'true' : undefined}>
          <button
            type="button"
            className="repository-sidebar-activator"
            aria-label={`查看 ${repo.fullName} 详情`}
            aria-pressed={selected}
            title={repo.fullName}
            data-button-motion="surface"
            data-row-activator
            disabled={exiting}
            onClick={(event) => {
              if (!event.currentTarget.closest('li')?.hasAttribute('inert')) onOpen(repo);
            }}
          >
            <span className="repository-sidebar-name font-mono">{repo.fullName}</span>
            <span className="repository-sidebar-metadata">
              <span className="repository-sidebar-release font-mono" title={release}>{release}</span>
              <span className="repository-sidebar-activity" aria-label={`最近活动 ${formatRelativeTime(repo.pushedAt)}`}>
                {formatRelativeTime(repo.pushedAt)}
              </span>
            </span>
          </button>
          <div className="repository-sidebar-actions">
            <RepositoryActions repo={repo} onRemove={onRemove} disabled={exiting} />
          </div>
        </div>
      )}
    </RepositoryMotionItem>
  );
});
