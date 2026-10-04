import type { ReactNode, RefObject } from 'react';
import { motion } from 'motion/react';
import { PageSlot } from '../shell/PageHost';
import { RepositorySidebarRow } from './RepositorySidebarRow';
import type { WatchlistPresentationProps } from './WatchlistPresentation';

/** Sidebar presentation only. The stable page/Chrome portals own all shared state. */
export function DesktopWatchlistView({ chromeHost, renderList, sidebarScrollRootRef }: WatchlistPresentationProps & {
  sidebarScrollRootRef: RefObject<HTMLDivElement>;
}) {
  return (
    <>
      <div className="watchlist-sidebar-chrome"><PageSlot host={chromeHost} /></div>
      <motion.div ref={sidebarScrollRootRef} layoutScroll className="repository-list-viewport" data-app-scroll-root="sidebar">
        <div className="repository-list-content">{renderList(RepositorySidebarRow, 'repo-list repository-sidebar-list')}</div>
      </motion.div>
    </>
  );
}

export function DesktopWatchlistHeading({ count, refresh }: { count: ReactNode; refresh: ReactNode }) {
  return (
    <div className="desktop-watchlist-heading watchlist-page-heading relative flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="desktop-watchlist-title flex min-w-0 items-center gap-2">
        <h2 className="text-sm font-semibold text-primary">监控清单</h2>
        {count}
      </div>
      {refresh}
    </div>
  );
}
