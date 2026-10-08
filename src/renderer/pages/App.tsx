import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Glance, AccessTokenState } from '../../shared/types';
import lightBrandMark from '../assets/bluebird-mark-light.svg';
import darkBrandMark from '../assets/bluebird-mark-dark.svg';
import { getApi } from '../lib/api';
import { useLayoutMode } from '../lib/app-layout';
import { findSidebarScrollRoot } from '../lib/app-scroll-root';
import { useWindowControlsOverlay } from '../lib/window-chrome';
import { DesktopAppShell } from '../components/shell/DesktopAppShell';
import { NarrowAppShell } from '../components/shell/NarrowAppShell';
import { PageSlot, usePageHost } from '../components/shell/PageHost';
import { CompactRepositoryContext } from '../components/CompactRepositoryContext';
import { ErrorBar } from '../components/ErrorBar';
import { PageTransition } from '../components/PageTransition';
import type { PageMotion } from '../components/PageTransition';
import { Loading } from '../components/Loading';
import { WorkspaceMessage } from '../components/StateMessage';
import { DetailPage } from './DetailPage';
import { SettingsPage } from './SettingsPage';
import { WatchlistPage } from './WatchlistPage';

/** 复用轻量导航：桌面 watchlist 对应空工作区，detail + selected 对应仓库，settings 对应设置。 */
type View = 'watchlist' | 'detail' | 'settings';

interface SelectedRepo {
  id: number;
  fullName: string;
}

/**
 * 切换方向由当前应用状态算出，不从 URL 猜（本项目没有 Router，也不会为本轮引入）。
 * 进详情是下钻，从详情回清单是返回父级，其余（清单 ↔ 设置、详情 → 设置）都是同级切换。
 */
function motionFor(from: View, to: View): PageMotion {
  if (to === 'detail') return 'forward';
  if (from === 'detail' && to === 'watchlist') return 'back';
  return 'top';
}

export function App() {
  useWindowControlsOverlay();
  const queryClient = useQueryClient();
  const workspaceScrollRootRef = useRef<HTMLElement>(null);
  const workspaceHost = usePageHost();
  const watchlistHost = usePageHost();
  const sidebarScrollPositionRef = useRef(0);
  const [view, setView] = useState<View>('watchlist');
  const [selected, setSelected] = useState<SelectedRepo | null>(null);
  // Only a running Desktop repo → repo navigation owns this entrance, never layout/theme changes.
  const [workspaceRepoSwitch, setWorkspaceRepoSwitch] = useState(false);
  /** 上一次导航的方向；null 表示还没导航过（首屏不播切换动画）。 */
  const [motion, setMotion] = useState<PageMotion | null>(null);
  /**
   * 滚动位置归属清单：只有清单会被恢复，其余页面一律从头开始。
   *
   * 小窗口共用同一个 window 滚动条，所以离开清单时就得把位置记下来——DOM 一换，
   * 浏览器马上按新页面的高度把 scrollY 夹掉，等到 layout effect 里再读只剩被夹过的值。
   */
  const narrowWatchlistScrollPositionRef = useRef(0);
  /** 上一次真正渲染的视图；null 表示还没渲染过（首屏不是导航，不写滚动位置）。 */
  const previousViewRef = useRef<View | null>(null);
  /** 顶部栏本体：详情里的 Tabs 吸附时要停在它下沿。 */
  const headerRef = useRef<HTMLElement>(null);
  /**
   * 详情里的 Repository Header 是否已经滚出视口（由 DetailPage 的哨兵报告）。
   * 为 true 时顶部栏在品牌右侧接管当前仓库名——只在详情里成立，离开详情即回到 false。
   */
  const [repoContextVisible, setRepoContextVisible] = useState(false);
  const layoutMode = useLayoutMode((nextMode) => {
    if (nextMode === 'desktop') {
      if (activeView === 'watchlist') narrowWatchlistScrollPositionRef.current = window.scrollY;
    } else {
      sidebarScrollPositionRef.current = findSidebarScrollRoot(watchlistHost)?.element.scrollTop ?? sidebarScrollPositionRef.current;
    }
    // resize 不是导航，旧方向和旧 scroll root 的上下文都不传给新布局。
    setMotion(null);
    setWorkspaceRepoSwitch(false);
    setRepoContextVisible(false);
  });
  const previousLayoutModeRef = useRef(layoutMode);

  // 启动即查询访问令牌状态：未配置时先进设置页
  const accessTokenStateQuery = useQuery({
    queryKey: ['accessTokenState'],
    queryFn: () => getApi().accessTokenState(),
    networkMode: 'always',
  });
  const configured = accessTokenStateQuery.data?.configured ?? false;
  /**
   * 无访问令牌不等于没有本地资料：本地清单有内容时仍允许清单 / 详情 / 趋势导航。
   * 这里只读本地清单（无网络副作用，且与清单页共用同一个 Query 缓存）。
   */
  const localListQuery = useQuery({
    queryKey: ['repositories'],
    queryFn: () => getApi().listRepositories(),
    networkMode: 'always',
  });
  const localEntry: 'available' | 'none' | 'unknown' = localListQuery.data !== undefined
    ? localListQuery.data.length > 0 ? 'available' : 'none'
    : localListQuery.isError ? 'none' : 'unknown';
  const localDataAllowed = configured || localEntry === 'available';
  /** 无令牌且本地清单还没读出来：先等本地结论，避免先闪到设置页再跳回清单。 */
  const gatePending = !configured && localEntry === 'unknown';

  /**
   * 用户导航的唯一入口：方向与视图在同一次批处理里落地，新内容才拿得到正确的层级动画。
   * 离开清单前顺手记住滚动位置，等这个视图真的换掉就来不及了。
   */
  function navigate(to: View): void {
    if (to !== 'detail') setWorkspaceRepoSwitch(false);
    if (layoutMode === 'narrow' && activeView === 'watchlist' && to !== 'watchlist') {
      narrowWatchlistScrollPositionRef.current = window.scrollY;
    }
    // 每次导航都从"隐藏"起步：刚进详情时 Repository Header 还在顶部，仓库身份由它自己交代；
    // 离开详情时也不让它留在顶部栏里。
    setRepoContextVisible(false);
    setMotion(layoutMode === 'desktop' ? null : motionFor(view, to));
    setView(to);
  }

  // 令牌保存成功的提示由设置页就地给出，这里只负责跳回清单（同一提示不重复出现）
  function handleAccessTokenSaved(): void {
    const next: AccessTokenState = { configured: true };
    queryClient.setQueryData(['accessTokenState'], next);
    void queryClient.invalidateQueries({ queryKey: ['accessTokenState'] });
    navigate('watchlist');
  }

  function openDetail(repo: Glance): void {
    // 再选当前仓库是 no-op，也不清掉已经接管身份的 Compact Context。
    if (layoutMode === 'desktop' && view === 'detail' && selected?.id === repo.id) return;
    setWorkspaceRepoSwitch(layoutMode === 'desktop' && activeView === 'detail' && selected !== null);
    setSelected({ id: repo.id, fullName: repo.fullName });
    navigate('detail');
  }

  const activeView: View = localDataAllowed ? view : 'settings';
  const destination = activeView === 'settings'
    ? { label: '监控清单', view: 'watchlist' as const, disabled: !localDataAllowed }
    : { label: '设置', view: 'settings' as const, disabled: false };
  // 读不到任何状态才整页阻断；已有缓存时后台刷新失败不应把界面清空
  const tokenStateFailed = accessTokenStateQuery.isError;
  const hasTokenState = accessTokenStateQuery.data !== undefined;
  const tokenRefreshError = tokenStateFailed && hasTokenState ? (
    <div className="mb-4">
      <ErrorBar
        error={{ kind: 'unknown', message: '访问令牌状态刷新失败，正在沿用上次读取的状态' }}
        action={{ label: '重试', onClick: () => void accessTokenStateQuery.refetch() }}
      />
    </div>
  ) : null;

  /**
   * 导航的滚动收尾，必须赶在浏览器 paint 前：晚一帧用户就会先看见详情的中段，
   * 再被拽到顶部——规格里明令禁止的"先错位、再跳到正确位置"。
   * 这里写的是确切的 scrollY，不用 scrollIntoView（那会把目标卡片贴顶或重新居中）。
   */
  useLayoutEffect(() => {
    // 令牌状态或本地清单结论还没到：这一屏只是启动占位，不是用户导航出来的视图，不能当成"从设置页回来"
    if (!hasTokenState || gatePending) return;
    const previous = previousViewRef.current;
    previousViewRef.current = activeView;
    const layoutChanged = previousLayoutModeRef.current !== layoutMode;
    previousLayoutModeRef.current = layoutMode;
    if (layoutChanged) {
      window.scrollTo({ top: layoutMode === 'narrow' && activeView === 'watchlist' ? narrowWatchlistScrollPositionRef.current : 0, behavior: 'auto' });
      if (layoutMode === 'desktop') {
        const root = findSidebarScrollRoot(watchlistHost);
        if (root) root.element.scrollTop = sidebarScrollPositionRef.current;
      }
      return;
    }
    if (layoutMode === 'desktop') return;
    // 首屏（previous 还是 null）不做任何滚动改写；同一个视图重复进入也不该动滚动位置
    if (previous === null || previous === activeView) return;
    window.scrollTo({
      top: activeView === 'watchlist' ? narrowWatchlistScrollPositionRef.current : 0,
      behavior: 'auto',
    });
  }, [activeView, hasTokenState, gatePending, layoutMode, watchlistHost]);

  // 仅导航或换仓库时重置工作区；侧栏节点与其 scrollTop 保持不动。
  useLayoutEffect(() => {
    if (layoutMode === 'desktop' && workspaceScrollRootRef.current) workspaceScrollRootRef.current.scrollTop = 0;
  }, [layoutMode, activeView, selected?.id]);

  /**
   * 顶部栏实测高度写成 CSS 变量：详情里的 Tabs 吸附时停在它下沿，哨兵也靠它定落点。
   *
   * 不能硬编码：顶部栏是 flex-wrap，窄窗口下导航会换行、高度不是常量。
   * 变量缺失时 CSS 里那条 `top: var(--app-header-height)` 整体失效 → 不吸附，
   * 也就是宁可不动，也绝不把 Tabs 塞进顶部栏底下。
   */
  useLayoutEffect(() => {
    const header = headerRef.current;
    const root = document.documentElement;
    let live = true;
    const apply = (): void => {
      if (!live) return;
      const height = header?.getBoundingClientRect().height ?? 0;
      root.style.setProperty('--app-header-height', `${height}px`);
      root.style.setProperty('--app-chrome-height', `${height}px`);
    };
    apply();
    if (!header || typeof ResizeObserver === 'undefined') {
      return () => {
        live = false;
        root.style.removeProperty('--app-header-height');
        root.style.removeProperty('--app-chrome-height');
      };
    }
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => {
      live = false;
      observer.disconnect();
      root.style.removeProperty('--app-header-height');
      root.style.removeProperty('--app-chrome-height');
    };
  }, [layoutMode]);

  let content;
  if (accessTokenStateQuery.isPending || gatePending) {
    content = (
      <Loading label="正在启动…" />
    );
  } else if (tokenStateFailed && !hasTokenState) {
    content = (
      <WorkspaceMessage title="无法读取访问令牌状态" description="请稍后重试" announcement="alert">
        <button type="button" onClick={() => void accessTokenStateQuery.refetch()} className="state-action">重试</button>
      </WorkspaceMessage>
    );
  } else if (activeView === 'settings') {
    // 无访问令牌且没有任何本地资料时才停留在设置页（启动闸门）
    content = <SettingsPage onSaved={handleAccessTokenSaved} />;
  } else if (activeView === 'detail' && selected) {
    content = (
      <DetailPage
        key={selected.id}
        workspace={layoutMode === 'desktop'}
        workspaceRepoSwitch={workspaceRepoSwitch}
        repositoryContextVisible={repoContextVisible}
        repositoryId={selected.id}
        fullName={selected.fullName}
        onRepositoryContextChange={setRepoContextVisible}
        onBack={() => navigate('watchlist')}
        onGoSettings={() => navigate('settings')}
      />
    );
  } else if (layoutMode === 'desktop') {
    content = (
      <WorkspaceMessage className="workspace-empty" title="青鸟信使"
        description={<>从左侧选择一个仓库<br />查看概览、发版、提交、构建和趋势</>}
        leading={<span className="app-brand-mark" aria-hidden="true">
          <img src={lightBrandMark} alt="" className="app-brand-mark-light" />
          <img src={darkBrandMark} alt="" className="app-brand-mark-dark" />
        </span>} />
    );
  } else {
    content = null;
  }

  return (
    <>
    {layoutMode === 'desktop' ? (
      <DesktopAppShell
        settingsActive={activeView === 'settings'}
        onGoSettings={() => navigate('settings')}
        workspaceScrollRootRef={workspaceScrollRootRef}
        sidebar={localDataAllowed ? <PageSlot host={watchlistHost} /> : null}
        workspace={<>{tokenRefreshError}<PageSlot host={workspaceHost} /></>}
      />
    ) : (
      <NarrowAppShell
        headerRef={headerRef}
        repositoryContext={activeView === 'detail' && selected ? (
          <CompactRepositoryContext fullName={selected.fullName} visible={repoContextVisible} />
        ) : null}
        navigation={{ label: destination.label, disabled: destination.disabled, onClick: () => navigate(destination.view) }}
      >
        {tokenRefreshError}
        {/* key follows navigation only; the portals below never belong to a Shell. */}
        <PageTransition key={activeView} motion={motion}>
          <PageSlot host={localDataAllowed && activeView === 'watchlist' ? watchlistHost : workspaceHost} />
        </PageTransition>
      </NarrowAppShell>
    )}
    {localDataAllowed ? createPortal(
      <WatchlistPage
        sidebar={layoutMode === 'desktop'}
        active={layoutMode === 'desktop' || activeView === 'watchlist'}
        selectedRepositoryId={activeView === 'detail' ? selected?.id : null}
        onOpenDetail={openDetail}
        onGoSettings={() => navigate('settings')}
        onRepositoryRemoved={(repositoryId) => {
          if (selected?.id !== repositoryId) return;
          setSelected(null);
          if (activeView === 'detail') navigate('watchlist');
        }}
      />,
      watchlistHost,
    ) : null}
    {createPortal(content, workspaceHost)}
    </>
  );
}
