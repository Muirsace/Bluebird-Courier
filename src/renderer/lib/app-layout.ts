import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const DESKTOP_SHELL_QUERY = '(min-width: 900px)';

export type LayoutMode = 'desktop' | 'narrow';

export function useLayoutMode(beforeChange?: (layoutMode: LayoutMode) => void): LayoutMode {
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => window.matchMedia(DESKTOP_SHELL_QUERY).matches ? 'desktop' : 'narrow');
  const mode = useRef(layoutMode);
  const beforeChangeRef = useRef(beforeChange);
  useLayoutEffect(() => { beforeChangeRef.current = beforeChange; });
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_SHELL_QUERY);
    const update = (): void => {
      const nextMode: LayoutMode = query.matches ? 'desktop' : 'narrow';
      if (mode.current === nextMode) return;
      // 在 React 改 DOM / 浏览器夹掉 window scroll 前记住旧布局的滚动位置。
      beforeChangeRef.current?.(nextMode);
      mode.current = nextMode;
      setLayoutMode(nextMode);
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return layoutMode;
}

/** Shell 内使用槽位，单栏仍由 document/window 滚动。 */
export function appScrollRoot(element: HTMLElement | null): HTMLElement | null {
  return element?.closest<HTMLElement>('[data-app-scroll-root]') ?? null;
}
