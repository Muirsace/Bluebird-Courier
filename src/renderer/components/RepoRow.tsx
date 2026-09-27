import type { Glance } from '../../shared/types';
import { formatCount } from '../lib/format';
import { formatRelativeTime, isWithinDays } from '../lib/time';
import { GlanceFact } from './GlanceFact';
import { RepositoryActions } from './watchlist/RepositoryActions';

interface RepoRowProps {
  repo: Glance;
  onOpen: (repo: Glance) => void;
  /** 移除失败时必须 reject（Popover 就地提示并允许重试）。 */
  onRemove: (repositoryId: number) => Promise<void>;
  /** 全局「全部刷新」进行中：在抓取时间后加一句轻量提示，卡片本身保持可读。 */
  refreshing: boolean;
}

/**
 * 监控清单里的一张仓库卡片：仓库名 → 核心指标 → 抓取时间，三层视觉权重。
 * 主区域是真正的 button（鼠标点击与 Enter / Space 都进详情），`···` 与它平级而非嵌套。
 */
export function RepoRow({ repo, onOpen, onRemove, refreshing }: RepoRowProps) {
  return (
    <li className="repo-row rounded-lg border border-subtle bg-surface transition-colors duration-150 ease-out hover:border-strong hover:bg-surface-hover">
      <div className="flex items-start gap-2 p-4">
        <button
          type="button"
          onClick={() => onOpen(repo)}
          aria-label={`查看 ${repo.fullName} 详情`}
          title={repo.fullName}
          className="min-w-0 flex-1 rounded-md text-left transition-colors duration-150 ease-out focus-visible:bg-surface-hover active:bg-surface-active"
        >
          <span className="block min-w-0 truncate font-mono text-lg font-semibold leading-8 text-primary">
            {repo.fullName}
          </span>
          <span className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-2">
            <GlanceFact label="Stars" value={formatCount(repo.stars)} />
            <GlanceFact
              label="最近活动"
              value={repo.pushedAt ? formatRelativeTime(repo.pushedAt) : '—'}
              accent={isWithinDays(repo.pushedAt, 7)}
            />
            <GlanceFact
              label="最新版本"
              value={repo.latestReleaseTag ?? '无发版'}
              mono
              muted={repo.latestReleaseTag === null}
            />
          </span>
          <span className="mt-1 block text-xs text-muted">
            抓取于 {repo.fetchedAt ? formatRelativeTime(repo.fetchedAt) : '尚未抓取'}
            {refreshing ? <span className="text-secondary"> · 正在更新…</span> : null}
          </span>
        </button>

        <RepositoryActions repo={repo} onRemove={onRemove} />
      </div>
    </li>
  );
}
