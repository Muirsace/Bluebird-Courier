export type DetailTabId = 'overview' | 'releases' | 'commits' | 'issues' | 'build' | 'trend';

const TABS: ReadonlyArray<{ id: DetailTabId; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'releases', label: '发版' },
  { id: 'commits', label: '提交' },
  { id: 'issues', label: 'Issue & PR' },
  { id: 'build', label: '构建' },
  { id: 'trend', label: '趋势' },
];

interface DetailTabsProps {
  active: DetailTabId;
  onChange: (id: DetailTabId) => void;
}

/** 仓库详情内部的二级导航；窄窗口下横向滚动，不换行挤压标题。 */
export function DetailTabs({ active, onChange }: DetailTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="仓库详情分区"
      aria-orientation="horizontal"
      className="flex gap-2 overflow-x-auto border-b border-subtle"
    >
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`detail-tab-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            aria-selected={selected}
            aria-controls={`detail-panel-${tab.id}`}
            data-button-motion="compact"
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const currentIndex = TABS.findIndex((item) => item.id === tab.id);
              let nextIndex: number | null = null;
              if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TABS.length;
              if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
              if (event.key === 'Home') nextIndex = 0;
              if (event.key === 'End') nextIndex = TABS.length - 1;
              if (nextIndex !== null) {
                event.preventDefault();
                const nextTab = TABS[nextIndex];
                if (!nextTab) return;
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(`#detail-tab-${nextTab.id}`)
                  ?.focus();
                onChange(nextTab.id);
              }
            }}
            className={`h-10 whitespace-nowrap border-b-2 px-3 text-sm transition-colors duration-150 ease-out focus-visible:outline-offset-[-3px] ${
              selected
                ? 'border-accent font-semibold text-accent'
                : 'border-transparent text-secondary hover:border-strong hover:text-primary active:bg-surface-active'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
