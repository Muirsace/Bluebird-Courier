import { useLayoutEffect } from 'react';

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

/** Read-only Chromium geometry; no Electron bridge or window operations. */
export function useWindowControlsOverlay(): void {
  useLayoutEffect(() => {
    const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;
    if (!overlay) return;
    const root = document.documentElement;
    const update = (): void => {
      const area = overlay.getTitlebarAreaRect();
      root.toggleAttribute('data-window-controls-overlay', overlay.visible && area.width > 0 && area.height > 0);
    };
    update();
    overlay.addEventListener('geometrychange', update);
    return () => {
      overlay.removeEventListener('geometrychange', update);
      root.removeAttribute('data-window-controls-overlay');
    };
  }, []);
}
