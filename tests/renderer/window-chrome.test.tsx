// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWindowControlsOverlay } from '../../src/renderer/lib/window-chrome';
import { AppShell } from '../../src/renderer/components/shell/AppShell';
import { createStub, renderNode } from './helpers';
import type { RenderResult } from './helpers';

function ChromeProbe() {
  useWindowControlsOverlay();
  return null;
}
let view: RenderResult | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  Reflect.deleteProperty(navigator, 'windowControlsOverlay');
});

describe('Read-only Window Controls Overlay geometry', () => {
  it('does not enable window chrome when the API is absent', async () => {
    view = await renderNode(createStub(), <ChromeProbe />);
    expect(document.documentElement.hasAttribute('data-window-controls-overlay')).toBe(false);
  });

  it('tracks visibility and geometry changes without retaining a listener after unmount', async () => {
    const overlay = Object.assign(new EventTarget(), {
      visible: true,
      getTitlebarAreaRect: vi.fn(() => new DOMRect(0, 0, 1043, 52)),
    });
    Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });
    const remove = vi.spyOn(overlay, 'removeEventListener');
    view = await renderNode(createStub(), <ChromeProbe />);
    const root = document.documentElement;
    expect(root.hasAttribute('data-window-controls-overlay')).toBe(true);
    overlay.visible = false;
    overlay.dispatchEvent(new Event('geometrychange'));
    expect(root.hasAttribute('data-window-controls-overlay')).toBe(false);
    overlay.visible = true;
    overlay.getTitlebarAreaRect.mockReturnValue(new DOMRect());
    overlay.dispatchEvent(new Event('geometrychange'));
    expect(root.hasAttribute('data-window-controls-overlay')).toBe(false);
    overlay.getTitlebarAreaRect.mockReturnValue(new DOMRect(0, 0, 343, 52));
    overlay.dispatchEvent(new Event('geometrychange'));
    expect(root.hasAttribute('data-window-controls-overlay')).toBe(true);
    await view.unmount();
    view = null;
    expect(remove).toHaveBeenCalledWith('geometrychange', expect.any(Function));
    expect(root.hasAttribute('data-window-controls-overlay')).toBe(false);
    overlay.dispatchEvent(new Event('geometrychange'));
    expect(root.hasAttribute('data-window-controls-overlay')).toBe(false);
  });
});

describe('Workspace native titlebar drag strip', () => {
  it('keeps an empty drag target ahead of the scroll content in the Workspace', async () => {
    view = await renderNode(createStub(), <AppShell
      rail={null}
      sidebar={<div />}
      sidebarChrome={<div />}
      workspace={<div>workspace</div>}
    />);

    const workspace = document.querySelector<HTMLElement>('.app-shell-workspace')!;
    const strip = workspace.firstElementChild as HTMLElement;
    expect(strip.className).toBe('app-shell-window-drag-strip window-drag-region');
    expect(strip.getAttribute('aria-hidden')).toBe('true');
    expect(strip.nextElementSibling?.className).toBe('app-shell-slot-content');
  });

  it('limits the sticky strip to overlay desktop, spans the full band, and offsets sticky content', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/renderer/styles/shell.css'), 'utf8');
    const stripRule = styles.match(/:root\[data-window-controls-overlay\] \.app-frame\[data-desktop='true'\] \.app-shell-window-drag-strip\s*\{([^}]*)\}/)?.[1] ?? '';
    const headerRule = styles.match(/:root\[data-window-controls-overlay\] \.app-shell-workspace \.repository-header-top\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(stripRule).toMatch(/position:\s*sticky/);
    expect(stripRule).toMatch(/height:\s*var\(--window-controls-height\)/);
    // Full width: the opaque native caption paints the buttons, so the band never depends
    // on the safe width — which the Workspace scrollbar gutter shortens by 9px.
    expect(stripRule).toMatch(/width:\s*100%/);
    expect(stripRule).not.toMatch(/--window-controls-safe-width/);
    expect(styles).toMatch(/\.app-shell-window-drag-strip\s*\{\s*display:\s*none;/);
    expect(headerRule).not.toMatch(/padding-right/);
    expect(styles).toMatch(/:root\[data-window-controls-overlay\] \.app-shell-workspace\s*\{[^}]*--workspace-sticky-offset:\s*calc\(var\(--window-controls-height\) \+ var\(--workspace-context-height\)\)/s);
  });
});
