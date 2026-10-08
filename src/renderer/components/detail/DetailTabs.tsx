import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DetailScope } from '../../../shared/types';

export type DetailTabId = 'overview' | 'releases' | 'commits' | 'issues' | 'build' | 'trend';

/**
 * 每个 Tab 实际展示、且属于远端同步基线的范围（展示确认按它上报）。
 * 趋势是本地快照视图，不参与详情确认；README / 目录树没有任何 Tab 展示，因此不在表内。
 */
export const TAB_DISPLAY_SCOPES: Record<DetailTabId, readonly DetailScope[]> = {
  overview: ['releases', 'commits', 'issuesAndPr', 'builds'],
  releases: ['releases'],
  commits: ['commits'],
  issues: ['issuesAndPr'],
  build: ['builds'],
  trend: [],
};

/**
 * 每个 Tab 需要读取的本地范围：该 Tab 展示的内容，加上表头依赖的仓库概览元数据。
 * 内容版本变化时只重读当前 Tab 的这些范围，其他范围的有效字段 / 状态 / 游标与窗口原样保留。
 */
export const TAB_READ_SCOPES: Record<DetailTabId, readonly DetailScope[]> = {
  overview: ['overview', 'releases', 'commits', 'issuesAndPr', 'builds', 'trends'],
  releases: ['overview', 'releases'],
  commits: ['overview', 'commits'],
  issues: ['overview', 'issuesAndPr'],
  build: ['overview', 'builds'],
  trend: ['overview', 'trends'],
};

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
  /** 已吸附到顶部栏下沿：只把分隔线加深一档，不参与任何几何计算。 */
  stuck?: boolean;
}

/** 仓库详情内部的二级导航；窄窗口下横向滚动，不换行挤压标题。 */
export function DetailTabs({ active, onChange, stuck }: DetailTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  /** 下划线的实测几何。首次量到之前不渲染，避免它从 0 滑到第一个 Tab。 */
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  const measure = useCallback((): void => {
    const list = listRef.current;
    const target = list?.querySelector<HTMLElement>(`#detail-tab-${active}`);
    if (!list || !target) return;
    // 实测高度写成 CSS 变量：切 Tab 时内容起点的 scroll-margin 要靠它让开 Tabs。
    // 吸附容器（Detail 里那一层 RevealItem）只包着这条 tablist，不加 padding / 边框，
    // 所以它的高度就是这里量到的值；挂载 / 换 Tab / 窗口尺寸变化都会重跑，不会留旧值。
    document.documentElement.style.setProperty('--detail-tabs-height', `${list.offsetHeight}px`);
    // offsetLeft/offsetWidth 是布局值，不受滚动位置影响，正好当 tablist 的坐标系用。
    // 顺带把激活 Tab 带进可视区：窄窗口下它可能被裁在外面（最典型的是窗口变窄后仍停在最右侧的
    // Tab）。直接写 scrollLeft——瞬时、不平滑，不会和 indicator 那 180ms 叠成双重运动。
    const left = target.offsetLeft;
    const right = left + target.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
    const next = { left, width: target.offsetWidth };
    setIndicator((prev) =>
      prev && prev.left === next.left && prev.width === next.width ? prev : next,
    );
  }, [active]);

  // 挂载与切 Tab 时量一次：在 paint 前落位，所以首帧就是正确位置，不会播一次位移
  useLayoutEffect(measure, [measure]);

  // 窗口 / 字体变化后重新量；这里的位置变化会走 180ms 过渡，是"追过去"该有的样子
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure]);

  // overflow-x-auto 会让 overflow-y 跟着算成 auto：Tab 按下时那 1px 位移就成了块轴溢出，
  // 条里会冒出一条竖向滚动条并把内容宽度挤掉 9px。块轴显式 hidden 把它关掉（横向滚动照旧）。
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="仓库详情分区"
      aria-orientation="horizontal"
      data-stuck={stuck ? 'true' : undefined}
      className="relative flex gap-2 overflow-x-auto overflow-y-hidden border-b border-subtle"
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
                ? 'border-transparent font-semibold text-accent'
                : 'border-transparent text-secondary hover:border-strong hover:text-primary active:bg-surface-active'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
      {/* accent 下划线只有这一个来源：切换时从旧 Tab 滑到新 Tab，不再各自瞬变 */}
      {indicator ? (
        <span
          aria-hidden="true"
          className="tab-indicator"
          style={{ width: indicator.width, transform: `translateX(${indicator.left}px)` }}
        />
      ) : null}
    </div>
  );
}
