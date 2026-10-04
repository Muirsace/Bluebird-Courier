import lightBrandMark from '../../assets/bluebird-mark-light.svg';
import darkBrandMark from '../../assets/bluebird-mark-dark.svg';

interface DesktopSidebarHeaderProps {
  settingsActive: boolean;
  onGoSettings: () => void;
}

/** 应用身份和设置入口；导航状态与业务仍由 App 持有。 */
export function DesktopSidebarHeader({ settingsActive, onGoSettings }: DesktopSidebarHeaderProps) {
  return (
    <header className="desktop-sidebar-brand window-drag-region">
      <div className="flex min-w-0 items-center gap-2">
        <span className="app-brand-mark" aria-hidden="true">
          <img src={lightBrandMark} alt="" className="app-brand-mark-light" />
          <img src={darkBrandMark} alt="" className="app-brand-mark-dark" />
        </span>
        <h1 className="text-base font-semibold tracking-wide text-primary">青鸟信使</h1>
      </div>
      <button
        type="button"
        aria-label="设置"
        title="设置"
        aria-pressed={settingsActive}
        onClick={onGoSettings}
        data-button-motion="icon"
        className={`sidebar-settings inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors ${
          settingsActive ? 'bg-accent-soft text-accent' : 'text-secondary hover:bg-surface-hover hover:text-primary active:bg-surface-active'
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="h-[18px] w-[18px]">
          <path strokeLinecap="round" strokeLinejoin="round" d="m9.5 3-.5 2-1.7 1-2-.6-2.5 4.3 1.5 1.4v2l-1.5 1.4 2.5 4.3 2-.6 1.7 1 .5 2h5l.5-2 1.7-1 2 .6 2.5-4.3-1.5-1.4v-2l1.5-1.4-2.5-4.3-2 .6-1.7-1-.5-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </header>
  );
}
