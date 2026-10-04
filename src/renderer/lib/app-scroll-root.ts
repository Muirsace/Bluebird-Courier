/** Actual DOM ownership: Narrow uses the document; Desktop keeps two independent roots. */
export type AppScrollRoot =
  | { kind: 'window'; element: null }
  | { kind: 'sidebar'; element: HTMLElement }
  | { kind: 'workspace'; element: HTMLElement };

/** Resolve at the point of use: PageHost moves between shells without remounting its page. */
export function resolveAppScrollRoot(element: HTMLElement | null): AppScrollRoot {
  const root = element?.closest<HTMLElement>('[data-app-scroll-root]');
  const kind = root?.dataset.appScrollRoot;
  if (root && (kind === 'sidebar' || kind === 'workspace')) return { kind, element: root };
  return { kind: 'window', element: null };
}

/** App owns Sidebar restoration; the root stays inside the Watchlist portal host. */
export function findSidebarScrollRoot(host: HTMLElement): Extract<AppScrollRoot, { kind: 'sidebar' }> | null {
  const element = host.querySelector<HTMLElement>('[data-app-scroll-root="sidebar"]');
  return element ? { kind: 'sidebar', element } : null;
}

/** Position/height storage for reveal and viewport compensation; retain the document fallback. */
export function scrollPositionElement(root: AppScrollRoot): Element {
  return root.element ?? document.scrollingElement ?? document.documentElement;
}

/** Native scroll requests and scroll/scrollend listeners share this target. */
export function scrollTarget(root: AppScrollRoot): HTMLElement | Window {
  return root.element ?? window;
}

export function scrollViewportHeight(root: AppScrollRoot): number {
  return root.element?.clientHeight ?? (document.documentElement.clientHeight || window.innerHeight);
}
