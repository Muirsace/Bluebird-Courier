import { AddRepositoryForm } from './AddRepositoryForm';
import { Spinner } from '../Spinner';

interface WatchlistHeaderProps {
  /** 当前清单里的仓库数量；读取中为 null（此时不显示数量，避免先显示 0 再跳数）。 */
  repositoryCount: number | null;
  adding: boolean;
  onAdd: (fullName: string) => Promise<boolean>;
  refreshing: boolean;
  onRefresh: () => void;
}

/** 清单页头与工具栏：标题 + 数量、添加仓库操作组、全部刷新。 */
export function WatchlistHeader({
  repositoryCount,
  adding,
  onAdd,
  refreshing,
  onRefresh,
}: WatchlistHeaderProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold text-primary">监控清单</h1>
        {repositoryCount !== null ? (
          <span className="text-sm text-secondary">{repositoryCount} 个仓库</span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <AddRepositoryForm adding={adding} onSubmit={onAdd} />
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
          className="ml-auto flex h-9 min-w-26 shrink-0 items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-3 text-sm text-accent transition-colors duration-150 ease-out hover:border-accent/70 hover:bg-accent-soft/70 active:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing ? <Spinner className="h-3.5 w-3.5" /> : null}
          {refreshing ? '刷新中…' : '全部刷新'}
        </button>
      </div>
    </div>
  );
}
