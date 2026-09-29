import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddRepositoryResult, Glance, NormalizedError } from '../../shared/types';
import { getApi } from '../lib/api';
import { dedupeErrors } from '../lib/errors';
import { EmptyState } from '../components/EmptyState';
import { ErrorBar } from '../components/ErrorBar';
import { Loading } from '../components/Loading';
import { RepoRow } from '../components/RepoRow';
import { WatchlistHeader } from '../components/watchlist/WatchlistHeader';
import { prefersReducedMotion } from '../lib/motion';

/** 启动时自动抓取一次轻量信息（整个会话一次；之后走「全部刷新」）。 */
let startupRefreshed = false;
const WATCHLIST_TOP_PROXIMITY_PX = 144;
const ADDED_NOTICE_EXIT_MS = 135;

interface AddedRepository {
  repositoryId: number;
  fullName: string;
}

interface PendingViewportAnchor extends AddedRepository {
  scrollTop: number;
  scrollHeight: number;
}

interface AddedNoticeProps {
  repository: AddedRepository;
  onViewPosition: (repositoryId: number) => void;
  onDismiss: (repositoryId: number) => void;
}

function AddedRepositoryNotice({ repository, onViewPosition, onDismiss }: AddedNoticeProps) {
  const [visible, setVisible] = useState(true);
  const dismissTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    },
    [],
  );

  function dismiss(): void {
    if (dismissTimerRef.current !== null) return;
    setVisible(false);
    dismissTimerRef.current = window.setTimeout(() => {
      onDismiss(repository.repositoryId);
    }, ADDED_NOTICE_EXIT_MS);
  }

  return (
    <div className="watchlist-added-notice" data-visible={visible ? 'true' : 'false'}>
      <p role="status" className="min-w-0 flex-1 text-sm leading-5 text-primary">
        <span aria-hidden="true" className="mr-1 font-medium text-success">✓</span>
        <span className="font-mono [overflow-wrap:anywhere]">{repository.fullName}</span>
        <span> 已加入监控清单 ·</span>
      </p>
      <button
        type="button"
        onClick={() => {
          onViewPosition(repository.repositoryId);
          dismiss();
        }}
        className="shrink-0 rounded px-1 text-sm font-medium text-accent hover:underline focus-visible:outline"
      >
        查看位置
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="关闭新增仓库提示"
        className="shrink-0 rounded px-1 text-sm text-secondary hover:bg-surface-hover"
      >
        ×
      </button>
    </div>
  );
}

interface WatchlistPageProps {
  onOpenDetail: (repo: Glance) => void;
  onGoSettings: () => void;
}

/** 移除已成功、正在播退场的仓库：先留在原位占位，播完才真正从列表消失。 */
interface ExitingRepo {
  repo: Glance;
  /** 移除前在清单里的位置。 */
  index: number;
  /** 移除前排在前面的仓库 id：清单刷新后据此把它放回原位，不让它跳到队尾。 */
  beforeIds: number[];
}

/** 把正在退场的卡片插回原位：刷新后的清单已经不返回它，但动画还没播完。 */
function mergeExiting(repos: Glance[], exiting: ExitingRepo[]): Glance[] {
  if (exiting.length === 0) return repos;
  const result = [...repos];
  for (const item of [...exiting].sort((a, b) => a.index - b.index)) {
    if (result.some((repo) => repo.id === item.repo.id)) continue;
    const at = result.filter((repo) => item.beforeIds.includes(repo.id)).length;
    result.splice(Math.min(at, result.length), 0, item.repo);
  }
  return result;
}

/**
 * 删除完成后的焦点去向：优先下一张卡片，其次上一张，清单空了就回到新增入口。
 * 只有焦点确实悬空（原节点已卸载）或还停在这张退场卡片里时才接管，不抢用户刚移过去的焦点。
 */
function focusAfterRemoval(repositoryId: number): void {
  const active = document.activeElement as HTMLElement | null;
  const detached = !active || active === document.body || !active.isConnected;
  const insideExiting = active?.closest('[data-motion="exiting"]') != null;
  if (!detached && !insideExiting) return;

  const slots = [...document.querySelectorAll<HTMLElement>('ul.repo-list > li')];
  const index = slots.findIndex((slot) => slot.dataset.repositoryId === String(repositoryId));
  const remaining = slots.filter((slot) => slot.dataset.repositoryId !== String(repositoryId));
  const target = remaining[index < 0 ? remaining.length - 1 : Math.min(index, remaining.length - 1)];
  const button =
    target?.querySelector<HTMLButtonElement>('button[aria-label^="查看 "]') ??
    document.querySelector<HTMLButtonElement>('.watchlist-add-trigger');
  button?.focus();
}

export function WatchlistPage({ onOpenDetail, onGoSettings }: WatchlistPageProps) {
  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: ['repositories'],
    queryFn: () => getApi().listRepositories(),
  });

  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErrors, setRefreshErrors] = useState<NormalizedError[]>([]);
  /** 刚加入成功的仓库：只有它会播一次进场动画，播完清掉。 */
  const [newlyAddedId, setNewlyAddedId] = useState<number | null>(null);
  const [addedNotice, setAddedNotice] = useState<AddedRepository | null>(null);
  const [highlightRequest, setHighlightRequest] = useState<{
    repositoryId: number;
    token: number;
  } | null>(null);
  const [exiting, setExiting] = useState<ExitingRepo[]>([]);
  /** 已确认移除的仓库 id：即使清单还没刷新（或刷新失败）也不会让卡片弹回来。id 由 AUTOINCREMENT 分配，不复用。 */
  const [removedIds, setRemovedIds] = useState<number[]>([]);
  const pendingViewportAnchorRef = useRef<PendingViewportAnchor | null>(null);
  const highlightSequenceRef = useRef(0);
  const scrollCompletionRef = useRef<(() => void) | null>(null);

  const repositories: Glance[] = listQuery.data ?? [];
  const removed = new Set(removedIds);
  const exitingIds = new Set(exiting.map((item) => item.repo.id));
  const displayed = mergeExiting(
    repositories.filter((repo) => !removed.has(repo.id)),
    exiting,
  );

  /** 新卡片完整落入 DOM 后、绘制前补偿顶部增加的真实高度，独立于导航返回恢复。 */
  useLayoutEffect(() => {
    const pending = pendingViewportAnchorRef.current;
    if (!pending) return;

    if (!listQuery.data?.some((repository) => repository.id === pending.repositoryId)) {
      if (listQuery.isError) pendingViewportAnchorRef.current = null;
      return;
    }

    pendingViewportAnchorRef.current = null;
    const scrollRoot = document.scrollingElement ?? document.documentElement;
    const heightDelta = scrollRoot.scrollHeight - pending.scrollHeight;
    if (heightDelta !== 0) {
      window.scrollTo({
        top: Math.max(0, pending.scrollTop + heightDelta),
        behavior: 'instant',
      });
    }
    setAddedNotice({ repositoryId: pending.repositoryId, fullName: pending.fullName });
  }, [listQuery.data, listQuery.isError]);

  useEffect(
    () => () => scrollCompletionRef.current?.(),
    [],
  );

  // 刷新全部轻量信息；完成后重读清单查询
  async function runRefresh(): Promise<void> {
    setRefreshing(true);
    try {
      const result = await getApi().refreshGlance();
      setRefreshErrors(dedupeErrors(result.errors));
      await queryClient.invalidateQueries({ queryKey: ['repositories'] });
    } catch {
      setRefreshErrors([{ kind: 'unknown', message: '抓取失败，请稍后重试' }]);
    } finally {
      setRefreshing(false);
    }
  }

  // 启动后自动抓取一次
  useEffect(() => {
    if (startupRefreshed) return;
    startupRefreshed = true;
    void runRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 进场播完：只清理这一张的"刚新增"标记。 */
  const handleEntered = useCallback((repositoryId: number) => {
    setNewlyAddedId((prev) => (prev === repositoryId ? null : prev));
  }, []);

  /** 退场播完：这时才从列表真正移除，并把焦点交给一张还存在的卡片。 */
  const handleExited = useCallback((repositoryId: number) => {
    setExiting((prev) => prev.filter((item) => item.repo.id !== repositoryId));
    setRemovedIds((prev) => (prev.includes(repositoryId) ? prev : [...prev, repositoryId]));
    // 刚新增就被移除时，进场标记还挂着这张卡：一并清掉，不留指向已消失节点的状态
    setNewlyAddedId((prev) => (prev === repositoryId ? null : prev));
    focusAfterRemoval(repositoryId);
  }, []);

  /** 新增失败由表单局部展示；重复响应刷新本地清单以提供对应仓库的详情入口。 */
  async function handleAdd(fullName: string): Promise<AddRepositoryResult> {
    setAddedNotice(null);
    setAdding(true);
    try {
      const result = await getApi().addRepository(fullName);
      if (!result.ok) {
        if (result.error?.message === '该仓库已在监控清单中') {
          await queryClient.invalidateQueries({ queryKey: ['repositories'] });
        }
        return result;
      }
      if (result.repository) {
        const scrollRoot = document.scrollingElement ?? document.documentElement;
        const scrollTop = scrollRoot.scrollTop;
        const nearTop = scrollTop <= WATCHLIST_TOP_PROXIMITY_PX;
        pendingViewportAnchorRef.current = null;
        setNewlyAddedId(nearTop ? result.repository.id : null);

        if (!nearTop) {
          pendingViewportAnchorRef.current = {
            repositoryId: result.repository.id,
            fullName: result.repository.fullName,
            scrollTop,
            scrollHeight: scrollRoot.scrollHeight,
          };
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['repositories'] });
      return result;
    } catch {
      return {
        ok: false,
        repository: null,
        error: { kind: 'unknown', message: '加入清单失败，请稍后重试' },
      };
    } finally {
      setAdding(false);
    }
  }

  function viewNewRepositoryPosition(repositoryId: number): void {
    const target = document.querySelector<HTMLElement>(
      `ul.repo-list > li[data-repository-id="${repositoryId}"]`,
    );
    if (!target) return;

    scrollCompletionRef.current?.();
    const reducedMotion = prefersReducedMotion();
    const options: ScrollIntoViewOptions = {
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'start',
      inline: 'nearest',
    };
    const requestHighlight = (): void => {
      setHighlightRequest({ repositoryId, token: ++highlightSequenceRef.current });
    };

    if (reducedMotion) {
      target.scrollIntoView(options);
      requestHighlight();
      return;
    }

    let finished = false;
    let timer: number | null = null;
    const cleanup = (): void => {
      document.removeEventListener('scrollend', finish);
      if (timer !== null) window.clearTimeout(timer);
      if (scrollCompletionRef.current === cancel) scrollCompletionRef.current = null;
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
      requestHighlight();
    };
    const cancel = (): void => {
      finished = true;
      cleanup();
    };

    scrollCompletionRef.current = cancel;
    document.addEventListener('scrollend', finish, { once: true });
    timer = window.setTimeout(finish, 1800);
    target.scrollIntoView(options);
  }

  function dismissAddedNotice(repositoryId: number): void {
    setAddedNotice((current) =>
      current?.repositoryId === repositoryId ? null : current,
    );
  }

  /**
   * 移除失败必须抛出：确认 Popover 保持打开并就地提示，用户可重试。
   * 成功后卡片先留在 DOM 里播退场，播完由 handleExited 真正移除。
   */
  async function handleRemove(repositoryId: number): Promise<void> {
    dismissAddedNotice(repositoryId);
    const index = displayed.findIndex((repo) => repo.id === repositoryId);
    const repo = index >= 0 ? displayed[index] : undefined;
    await getApi().removeRepository(repositoryId);
    if (repo) {
      const beforeIds = displayed.slice(0, index).map((item) => item.id);
      setExiting((prev) =>
        prev.some((item) => item.repo.id === repositoryId)
          ? prev
          : [...prev, { repo, index, beforeIds }],
      );
    }
    await queryClient.invalidateQueries({ queryKey: ['repositories'] });
  }

  /** 加载失败且没有任何缓存数据：只显示错误条，不能再显示空态（否则被误读成清单被清空）。 */
  const listUnavailable = listQuery.isError && !listQuery.data;

  return (
    <div className="watchlist-page min-w-0">
      <WatchlistHeader
        repositoryCount={listQuery.data ? repositories.length : null}
        repositories={repositories}
        adding={adding}
        onAdd={handleAdd}
        onOpenRepository={onOpenDetail}
        refreshing={refreshing}
        onRefresh={() => void runRefresh()}
      />

      {refreshErrors.map((error, index) => (
        <ErrorBar
          key={`${error.kind}|${error.message}|${index}`}
          error={error}
          onGoSettings={onGoSettings}
        />
      ))}
      {listQuery.isError ? (
        <ErrorBar
          error={{ kind: 'unknown', message: '监控清单加载失败，请稍后重试' }}
          onGoSettings={onGoSettings}
          action={{ label: '重试', onClick: () => void listQuery.refetch() }}
        />
      ) : null}

      {listQuery.isPending && !listQuery.data ? (
        <Loading label="正在加载监控清单…" />
      ) : listUnavailable ? null : repositories.length === 0 && displayed.length === 0 ? (
        <EmptyState
          title="还没有监控仓库"
          hint="添加一个 GitHub 仓库，青鸟信使会帮你跟踪发版、提交、Issue、构建和趋势。"
        />
      ) : (
        <ul className="repo-list">
          {displayed.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              onOpen={onOpenDetail}
              onRemove={handleRemove}
              refreshing={refreshing}
              justAdded={repo.id === newlyAddedId}
              highlightRequest={
                repo.id === highlightRequest?.repositoryId ? highlightRequest.token : undefined
              }
              onEntered={handleEntered}
              exiting={exitingIds.has(repo.id)}
              onExited={handleExited}
            />
          ))}
        </ul>
      )}
      {addedNotice ? (
        <AddedRepositoryNotice
          repository={addedNotice}
          onViewPosition={viewNewRepositoryPosition}
          onDismiss={dismissAddedNotice}
        />
      ) : null}
    </div>
  );
}
