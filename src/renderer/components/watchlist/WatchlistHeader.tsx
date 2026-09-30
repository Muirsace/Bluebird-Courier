import { useLayoutEffect, useRef, useState } from 'react';
import { AddRepositoryForm } from './AddRepositoryForm';
import { Spinner } from '../Spinner';
import type { Glance } from '../../../shared/types';
import type { AddRepositoryOutcome } from './AddRepositoryForm';

interface WatchlistHeaderProps {
  /** 当前清单里的仓库数量；读取中为 null（此时不显示数量，避免先显示 0 再跳数）。 */
  repositoryCount: number | null;
  repositories: Glance[];
  adding: boolean;
  onAdd: (fullName: string) => Promise<AddRepositoryOutcome>;
  onOpenRepository: (repository: Glance) => void;
  onViewPosition: (repositoryId: number, onRevealSettled: () => void) => void;
  refreshing: boolean;
  onRefresh: () => void;
}

/** 清单页标题与唯一一组页面操作。 */
export function WatchlistHeader({
  repositoryCount,
  repositories,
  adding,
  onAdd,
  onOpenRepository,
  onViewPosition,
  refreshing,
  onRefresh,
}: WatchlistHeaderProps) {
  const toolbarSentinelRef = useRef<HTMLSpanElement>(null);
  const [toolbarStuck, setToolbarStuck] = useState(false);

  useLayoutEffect(() => {
    const sentinel = toolbarSentinelRef.current;
    const appHeader = document.querySelector<HTMLElement>('header');
    if (!sentinel || !appHeader || typeof IntersectionObserver === 'undefined') return;

    let observer: IntersectionObserver | null = null;
    const observeAtHeader = (): void => {
      observer?.disconnect();
      // Read the rendered Header height because IntersectionObserver rootMargin cannot use CSS vars.
      const headerHeight = appHeader.getBoundingClientRect().height;
      setToolbarStuck(sentinel.getBoundingClientRect().top <= headerHeight);
      observer = new IntersectionObserver(
        ([entry]) => setToolbarStuck(entry ? !entry.isIntersecting : false),
        { rootMargin: `-${headerHeight}px 0px 0px 0px`, threshold: 0 },
      );
      observer.observe(sentinel);
    };

    observeAtHeader();
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(observeAtHeader);
    resizeObserver?.observe(appHeader);

    return () => {
      observer?.disconnect();
      resizeObserver?.disconnect();
    };
  }, []);

  return (
    <>
      <div className="watchlist-page-heading relative flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold text-primary">监控清单</h1>
        {repositoryCount !== null ? (
          <span className="text-sm text-secondary">{repositoryCount} 个仓库</span>
        ) : null}
        <span
          ref={toolbarSentinelRef}
          aria-hidden="true"
          className="watchlist-toolbar-sentinel"
        />
      </div>

      <div className="watchlist-page-toolbar" data-stuck={toolbarStuck ? 'true' : undefined}>
        <div className="watchlist-toolbar flex w-full flex-wrap items-start gap-2">
          <AddRepositoryForm
            repositories={repositories}
            adding={adding}
            onSubmit={onAdd}
            onOpenRepository={onOpenRepository}
            onViewPosition={onViewPosition}
          />
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-busy={refreshing}
            className="ml-auto flex h-9 min-w-26 shrink-0 items-center justify-center gap-2 rounded-md border border-accent-border bg-accent-soft px-3 text-sm text-accent transition-colors duration-150 ease-out hover:border-accent hover:bg-accent-soft/70 active:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? <Spinner className="h-3.5 w-3.5" /> : null}
            {refreshing ? '刷新中…' : '全部刷新'}
          </button>
        </div>
      </div>
    </>
  );
}
