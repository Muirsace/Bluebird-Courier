import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const DESKTOP_SHELL_QUERY = '(min-width: 900px)';

export function useDesktopShell(beforeChange?: (desktop: boolean) => void): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_SHELL_QUERY).matches);
  const mode = useRef(desktop);
  const beforeChangeRef = useRef(beforeChange);
  useLayoutEffect(() => { beforeChangeRef.current = beforeChange; });
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_SHELL_QUERY);
    const update = (): void => {
      if (mode.current === query.matches) return;
      // 在 React 改 DOM / 浏览器夹掉 window scroll 前记住旧布局的滚动位置。
      beforeChangeRef.current?.(query.matches);
      mode.current = query.matches;
      setDesktop(query.matches);
    };
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
