import { useEffect, useState } from 'react';

export const DESKTOP_SHELL_QUERY = '(min-width: 900px)';

export function useDesktopShell(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_SHELL_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_SHELL_QUERY);
    const update = (): void => setDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return desktop;
}

/** Shell 内使用槽位，单栏仍由 document/window 滚动。 */
export function appScrollRoot(element: HTMLElement | null): HTMLElement | null {
  return element?.closest<HTMLElement>('[data-app-scroll-root]') ?? null;
}
