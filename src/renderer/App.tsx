import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Glance, AccessTokenState } from '../shared/types';
import lightBrandMark from './assets/bluebird-mark-light.svg';
import darkBrandMark from './assets/bluebird-mark-dark.svg';
import { getApi } from './lib/api';
import { ErrorBar } from './components/ErrorBar';
import { PageTransition } from './components/PageTransition';
import type { PageMotion } from './components/PageTransition';
import { Spinner } from './components/Spinner';
import { DetailPage } from './pages/DetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { WatchlistPage } from './pages/WatchlistPage';

/** 顶级页面只有两个：监控清单（含仓库详情这一层）与设置。 */
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

function navButtonClass(active: boolean, disabled: boolean): string {
  const base = 'inline-flex h-9 items-center rounded-md px-3 text-sm transition-colors duration-150 ease-out';
  if (disabled) return `${base} cursor-not-allowed text-muted`;
  if (active) return `${base} bg-accent-soft text-accent active:bg-accent-soft`;
  return `${base} text-secondary hover:bg-surface-hover hover:text-primary active:bg-surface-active`;
}

export function App() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('watchlist');
  const [selected, setSelected] = useState<SelectedRepo | null>(null);
  /** 上一次导航的方向；null 表示还没导航过（首屏不播切换动画）。 */
  const [motion, setMotion] = useState<PageMotion | null>(null);

  // 启动即查询访问令牌状态：未配置时先进设置页
  const accessTokenStateQuery = useQuery({
    queryKey: ['accessTokenState'],
    queryFn: () => getApi().accessTokenState(),
  });
  const configured = accessTokenStateQuery.data?.configured ?? false;

  useEffect(() => {
    const state = accessTokenStateQuery.data;
    // 启动闸门不是用户导航：只改视图，不设置方向，避免首屏解析出令牌时播一次切换动画
    if (state && !state.configured) setView('settings');
  }, [accessTokenStateQuery.data]);

  /** 用户导航的唯一入口：方向与视图在同一次批处理里落地，新内容才拿得到正确的层级动画。 */
  function navigate(to: View): void {
    setMotion(motionFor(view, to));
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
    setSelected({ id: repo.id, fullName: repo.fullName });
    navigate('detail');
  }

  const activeView: View = configured ? view : 'settings';
  // 读不到任何状态才整页阻断；已有缓存时后台刷新失败不应把界面清空
  const tokenStateFailed = accessTokenStateQuery.isError;
  const hasTokenState = accessTokenStateQuery.data !== undefined;

  let content;
  if (accessTokenStateQuery.isPending) {
    content = (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-secondary">
        <Spinner />
        正在启动…
      </div>
    );
  } else if (tokenStateFailed && !hasTokenState) {
    content = (
      <div className="mx-auto max-w-xl space-y-3 py-10">
        <ErrorBar
          error={{ kind: 'unknown', message: '无法读取访问令牌状态，请稍后重试' }}
          action={{ label: '重试', onClick: () => void accessTokenStateQuery.refetch() }}
        />
      </div>
    );
  } else if (activeView === 'settings') {
    // 未配置访问令牌时 activeView 恒为设置页（启动闸门）
    content = <SettingsPage onSaved={handleAccessTokenSaved} />;
  } else if (activeView === 'detail' && selected) {
    content = (
      <DetailPage
        repositoryId={selected.id}
        fullName={selected.fullName}
        onBack={() => navigate('watchlist')}
        onGoSettings={() => navigate('settings')}
      />
    );
  } else {
    content = (
      <WatchlistPage onOpenDetail={openDetail} onGoSettings={() => navigate('settings')} />
    );
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col">
      <header className="sticky top-0 z-10 border-b border-subtle bg-app px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="app-brand-mark" aria-hidden="true">
              <img src={lightBrandMark} alt="" className="app-brand-mark-light" />
              <img src={darkBrandMark} alt="" className="app-brand-mark-dark" />
            </span>
            <h1 className="text-base font-semibold tracking-wide text-primary">青鸟信使</h1>
          </div>
          <nav className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => navigate('watchlist')}
              disabled={!configured}
              aria-current={activeView === 'watchlist' || activeView === 'detail' ? 'page' : undefined}
              className={navButtonClass(
                activeView === 'watchlist' || activeView === 'detail',
                !configured,
              )}
            >
              监控清单
            </button>
            <button
              type="button"
              onClick={() => navigate('settings')}
              aria-current={activeView === 'settings' ? 'page' : undefined}
              className={navButtonClass(activeView === 'settings', false)}
            >
              设置
            </button>
          </nav>
        </div>
      </header>

      <main className="flex-1 px-4 py-5">
        {tokenStateFailed && hasTokenState ? (
          <div className="mb-4">
            <ErrorBar
              error={{ kind: 'unknown', message: '访问令牌状态刷新失败，正在沿用上次读取的状态' }}
              action={{ label: '重试', onClick: () => void accessTokenStateQuery.refetch() }}
            />
          </div>
        ) : null}
        {/* key 只跟导航状态走：刷新 / Query 更新 / 主题 / resize 都不会换节点，也就不会重播 */}
        <PageTransition key={activeView} motion={motion}>
          {content}
        </PageTransition>
      </main>
    </div>
  );
}
