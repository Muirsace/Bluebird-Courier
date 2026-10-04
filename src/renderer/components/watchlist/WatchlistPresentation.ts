import type { ComponentType, ReactNode } from 'react';
import type { RepositoryItemProps } from './RepositoryMotionItem';

/** The page owns list state and Presence; each view chooses its existing item DOM. */
export interface WatchlistPresentationProps {
  chromeHost: HTMLElement;
  renderList: (Item: ComponentType<RepositoryItemProps & { selected: boolean }>, className: string) => ReactNode;
}
