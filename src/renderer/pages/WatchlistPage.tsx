import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddRepositoryResult, Glance, NormalizedError } from '../../shared/types';
import { getApi } from '../lib/api';
import { dedupeErrors } from '../lib/errors';
import { EmptyState } from '../components/EmptyState';
import { ErrorBar } from '../components/ErrorBar';
import { Loading } from '../components/Loading';
import { RepoRow } from '../components/RepoRow';
import { WatchlistHeader } from '../components/watchlist/WatchlistHeader';

/** 启动时自动抓取一次轻量信息（整个会话一次；之后走「全部刷新」）。 */
let startupRefreshed = false;

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
  const [exiting, setExiting] = useState<ExitingRepo[]>([]);
  /** 已确认移除的仓库 id：即使清单还没刷新（或刷新失败）也不会让卡片弹回来。id 由 AUTOINCREMENT 分配，不复用。 */
  const [removedIds, setRemovedIds] = useState<number[]>([]);

  const repositories: Glance[] = listQuery.data ?? [];
  const removed = new Set(removedIds);
  const exitingIds = new Set(exiting.map((item) => item.repo.id));
  const displayed = mergeExiting(
    repositories.filter((repo) => !removed.has(repo.id)),
    exiting,
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

  /** 新增失败由表单局部展示；重复响应刷新本地清单以提供对应仓库的「查看」入口。 */
  async function handleAdd(fullName: string): Promise<AddRepositoryResult> {
    setAdding(true);
    try {
      const result = await getApi().addRepository(fullName);
      if (!result.ok) {
        if (result.error?.message === '该仓库已在监控清单中') {
          await queryClient.invalidateQueries({ queryKey: ['repositories'] });
        }
        return result;
      }
      // 先记下新仓库，再刷新清单：卡片一进 DOM 就带着进场动画（失败时什么都不播）
      if (result.repository) setNewlyAddedId(result.repository.id);
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

  /**
   * 移除失败必须抛出：确认 Popover 保持打开并就地提示，用户可重试。
   * 成功后卡片先留在 DOM 里播退场，播完由 handleExited 真正移除。
   */
  async function handleRemove(repositoryId: number): Promise<void> {
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
    <div className="space-y-4">
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
              onEntered={handleEntered}
              exiting={exitingIds.has(repo.id)}
              onExited={handleExited}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
