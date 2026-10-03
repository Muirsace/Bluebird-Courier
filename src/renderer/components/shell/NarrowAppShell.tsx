import type { ReactNode, RefObject } from 'react';
import lightBrandMark from '../../assets/bluebird-mark-light.svg';
import darkBrandMark from '../../assets/bluebird-mark-dark.svg';

interface NarrowAppShellProps {
  headerRef: RefObject<HTMLElement>;
  repositoryContext: ReactNode;
  navigation: { label: string; disabled: boolean; onClick: () => void };
  children: ReactNode;
}

function navButtonClass(disabled: boolean): string {
  const base = 'inline-flex h-9 items-center rounded-md px-3 text-sm transition-colors duration-150 ease-out';
  if (disabled) return `${base} cursor-not-allowed text-muted`;
  return `${base} text-secondary hover:bg-surface-hover hover:text-primary active:bg-surface-active`;
}

/** Narrow header and content host; page state and transitions stay with App. */
export function NarrowAppShell({ headerRef, repositoryContext, navigation, children }: NarrowAppShellProps) {
  return (
    <div className="narrow-app-shell app-frame mx-auto flex min-h-full w-full max-w-6xl flex-col" data-desktop={false}>
      <header ref={headerRef} className="app-global-header sticky top-0 z-10 border-b border-subtle bg-app px-4 py-3 window-drag-region">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="app-brand-mark" aria-hidden="true">
              <img src={lightBrandMark} alt="" className="app-brand-mark-light" />
              <img src={darkBrandMark} alt="" className="app-brand-mark-dark" />
            </span>
            <h1 className="shrink-0 text-base font-semibold tracking-wide text-primary">青鸟信使</h1>
            {/* Context keeps its existing placeholder width when hidden. */}
            {repositoryContext}
          </div>
          <nav aria-label="页面导航" className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={navigation.onClick}
              disabled={navigation.disabled}
              className={navButtonClass(navigation.disabled)}
            >
              {navigation.label}
            </button>
          </nav>
        </div>
      </header>
      <main className="flex-1 px-4 py-5">{children}</main>
    </div>
  );
}
