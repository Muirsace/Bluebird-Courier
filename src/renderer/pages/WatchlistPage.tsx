import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Glance, NormalizedError } from '../../shared/types';
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

export function WatchlistPage({ onOpenDetail, onGoSettings }: WatchlistPageProps) {
  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: ['repositories'],
    queryFn: () => getApi().listRepositories(),
  });

  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<NormalizedError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErrors, setRefreshErrors] = useState<NormalizedError[]>([]);

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

  /** 加入成功返回 true（表单据此清空输入框）；失败沿用页头错误条。 */
  async function handleAdd(fullName: string): Promise<boolean> {
    setAdding(true);
    setActionError(null);
    try {
      const result = await getApi().addRepository(fullName);
      if (!result.ok) {
        setActionError(result.error ?? { kind: 'unknown', message: '加入清单失败，请稍后重试' });
        return false;
      }
      await queryClient.invalidateQueries({ queryKey: ['repositories'] });
      return true;
    } catch {
      setActionError({ kind: 'unknown', message: '加入清单失败，请稍后重试' });
      return false;
    } finally {
      setAdding(false);
    }
  }

  /** 移除失败必须抛出：确认 Popover 保持打开并就地提示，用户可重试。 */
  async function handleRemove(repositoryId: number): Promise<void> {
    await getApi().removeRepository(repositoryId);
    await queryClient.invalidateQueries({ queryKey: ['repositories'] });
  }

  const repositories: Glance[] = listQuery.data ?? [];
  /** 加载失败且没有任何缓存数据：只显示错误条，不能再显示空态（否则被误读成清单被清空）。 */
  const listUnavailable = listQuery.isError && !listQuery.data;

  return (
    <div className="space-y-4">
      <WatchlistHeader
        repositoryCount={listQuery.data ? repositories.length : null}
        adding={adding}
        onAdd={handleAdd}
        refreshing={refreshing}
        onRefresh={() => void runRefresh()}
      />

      {actionError ? <ErrorBar error={actionError} onGoSettings={onGoSettings} /> : null}
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
      ) : listUnavailable ? null : repositories.length === 0 ? (
        <EmptyState
          title="还没有监控仓库"
          hint="添加一个 GitHub 仓库，青鸟信使会帮你跟踪发版、提交、Issue、构建和趋势。"
        />
      ) : (
        <ul className="space-y-2">
          {repositories.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              onOpen={onOpenDetail}
              onRemove={handleRemove}
              refreshing={refreshing}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
