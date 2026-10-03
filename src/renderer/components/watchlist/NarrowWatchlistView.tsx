import type { ReactNode, RefObject } from 'react';
import { PageSlot } from '../shell/PageHost';
import { RepoRow } from '../RepoRow';
import type { WatchlistPresentationProps } from './WatchlistPresentation';

/** Single-column page presentation; window remains its existing scroll root. */
export function NarrowWatchlistView({ chromeHost, renderList }: WatchlistPresentationProps) {
  return <><PageSlot host={chromeHost} />{renderList(RepoRow, 'repo-list')}</>;
}

export function NarrowWatchlistHeading({ count, sentinelRef }: { count: ReactNode; sentinelRef: RefObject<HTMLSpanElement> }) {
  return (
    <div className="watchlist-page-heading relative flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h1 className="text-xl font-semibold text-primary">监控清单</h1>
      {count}
      <span ref={sentinelRef} aria-hidden="true" className="watchlist-toolbar-sentinel" />
    </div>
  );
}
