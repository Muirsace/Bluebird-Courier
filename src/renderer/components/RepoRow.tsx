import { forwardRef } from 'react';
import { formatCount } from '../lib/format';
import { formatRelativeTime } from '../lib/time';
import { GlanceFact } from './GlanceFact';
import { RepositoryActions } from './watchlist/RepositoryActions';
import { RepositoryMotionItem } from './watchlist/RepositoryMotionItem';
import type { RepositoryItemProps } from './watchlist/RepositoryMotionItem';

/** Legacy large card for the single-column Watchlist. Menu and activator are siblings. */
export const RepoRow = forwardRef<HTMLLIElement, RepositoryItemProps>(function RepoRow(props, forwardedRef) {
  const { repo, onOpen, onRemove, refreshing } = props;
  return (
    <RepositoryMotionItem ref={forwardedRef} {...props}>
      {(exitingCard) => (
        <div className="repo-row rounded-lg border border-subtle bg-surface hover:border-strong hover:bg-surface-hover">
          <div className="flex items-start gap-2 p-4">
            {/* 主点击区几乎铺满整张卡片：按下反馈由卡片整体承担（见 .repo-row:has([data-row-activator]:active)），按钮自己只做键盘焦点底色 */}
            <button
              type="button"
              onClick={(event) => { if (!event.currentTarget.closest('li')?.hasAttribute('inert')) onOpen(repo); }}
              disabled={exitingCard}
              aria-label={`查看 ${repo.fullName} 详情`}
              title={repo.fullName}
              data-button-motion="surface"
              data-row-activator
              className="min-w-0 flex-1 rounded-md text-left transition-colors duration-150 ease-out focus-visible:bg-surface-hover"
            >
              <span className="block min-w-0 truncate font-mono text-lg font-semibold leading-8 text-primary">
                {repo.fullName}
              </span>
              <span className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-2">
                <GlanceFact label="Stars" value={formatCount(repo.stars)} />
                <GlanceFact
                  label="最近活动"
                  value={repo.pushedAt ? formatRelativeTime(repo.pushedAt) : '—'}
                />
                <GlanceFact
                  label="最新版本"
                  value={repo.latestReleaseTag ?? '无发版'}
                  mono
                  muted={repo.latestReleaseTag === null}
                />
              </span>
              <span className="mt-1 block text-xs text-muted">
                抓取于 {repo.fetchedAt ? formatRelativeTime(repo.fetchedAt) : '尚未抓取'}
                {refreshing ? <span className="text-secondary"> · 正在更新…</span> : null}
              </span>
            </button>

            <RepositoryActions repo={repo} onRemove={onRemove} disabled={exitingCard} />
          </div>
        </div>
      )}
    </RepositoryMotionItem>
  );
});
