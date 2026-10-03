import type { ReactNode, RefObject } from 'react';
import { motion } from 'motion/react';
import { PageSlot } from '../shell/PageHost';
import { RepositorySidebarRow } from './RepositorySidebarRow';
import type { WatchlistPresentationProps } from './WatchlistPresentation';

/** Sidebar presentation only. The stable page/Chrome portals own all shared state. */
export function DesktopWatchlistView({ chromeHost, renderList, listViewportRef }: WatchlistPresentationProps & {
  listViewportRef: RefObject<HTMLDivElement>;
}) {
  return (
    <>
      <div className="watchlist-sidebar-chrome"><PageSlot host={chromeHost} /></div>
      <motion.div ref={listViewportRef} layoutScroll className="repository-list-viewport" data-app-scroll-root="sidebar">
        <div className="repository-list-content">{renderList(RepositorySidebarRow, 'repo-list repository-sidebar-list')}</div>
      </motion.div>
    </>
  );
}

export function DesktopWatchlistHeading({ count, refresh }: { count: ReactNode; refresh: ReactNode }) {
  return (
    <div className="watchlist-page-heading relative flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-base font-semibold text-primary">监控清单</h2>
      <div className="watchlist-title-actions flex items-center gap-2">{count}{refresh}</div>
    </div>
  );
}
