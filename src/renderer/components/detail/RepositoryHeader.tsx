import type { Glance } from '../../../shared/types';
import { formatCount } from '../../lib/format';
import { formatRelativeTime } from '../../lib/time';
import { ExternalLinkButton } from '../ExternalLinkButton';
import { GlanceFact } from '../GlanceFact';
import { Spinner } from '../Spinner';

interface RepositoryHeaderProps {
  workspace?: boolean;
  /** 仓库全名：接口数据回来前的保底标题。 */
  fullName: string;
  repository: Glance | undefined;
  fetching: boolean;
  /** 首次抓取完成后的揭示窗口：指标值从 `—` 交叉淡化到真实值。 */
  revealing: boolean;
  onBack: () => void;
  onRefetch: () => void;
}

/** 仓库详情表头：返回监控清单、仓库名、抓取时间、在 GitHub 打开、重新抓取、四条核心指标。 */
export function RepositoryHeader({
  workspace = false,
  fullName,
  repository,
  fetching,
  revealing,
  onBack,
  onRefetch,
}: RepositoryHeaderProps) {
  // 详情数据回来前用清单里的全名兜底，外链按钮不会缺席也不会跳错页（主进程还会再校验一次）
  const [owner = '', name = ''] = (repository?.fullName ?? fullName).split('/');
  // 抓取中这四条都是 `—`；揭示窗口里让它们原地淡换，而不是瞬间替换（也不做数字滚动）
  const placeholder = revealing ? '—' : undefined;
  const displayName = repository?.fullName ?? fullName;
  const Heading = workspace ? 'h2' : 'h1';

  return (
    <div className={workspace ? undefined : 'space-y-3'}>
      {!workspace ? (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-9 items-center rounded-md border border-default px-3 text-sm text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active"
        >
          ← 返回监控清单
        </button>
      ) : null}

      <header className="repository-header rounded-lg border border-subtle bg-surface p-4">
        <div className="repository-header-top flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="repository-header-identity min-w-0">
            <Heading className="repository-header-name break-all font-mono text-lg font-semibold text-primary" title={displayName} aria-label={displayName}>
              {name}
            </Heading>
            <div className="repository-header-owner mt-1 truncate text-sm text-secondary" title={owner}>{owner}</div>
            <div className="repository-header-fetched mt-1 text-xs text-muted">
              抓取于 {repository?.fetchedAt ? formatRelativeTime(repository.fetchedAt) : '尚未抓取'}
              {fetching ? <span className="text-secondary"> · 正在更新…</span> : null}
            </div>
          </div>
          <div className="repository-header-actions flex shrink-0 flex-wrap items-center gap-2">
            <ExternalLinkButton
              target={{ kind: 'repository', owner, name }}
              label={`在 GitHub 打开 ${repository?.fullName ?? fullName}`}
              className="inline-flex h-9 items-center rounded-md border border-default px-3 text-sm text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active"
            >
              在 GitHub 打开 ↗
            </ExternalLinkButton>
            <button
              type="button"
              onClick={onRefetch}
              disabled={fetching}
              aria-busy={fetching}
              className="flex h-9 min-w-[6.5rem] shrink-0 items-center justify-center gap-2 rounded-md border border-accent-border bg-accent-soft px-3 text-sm text-accent transition-colors duration-150 ease-out hover:border-accent hover:bg-accent-soft/70 active:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60"
            >
              {/* 宽度由上面的 min-w 定住，这里只换文案：抓取中… → 重新抓取 时右侧不会跳 */}
              <span
                key={fetching ? 'busy' : 'idle'}
                className="detail-refetch-label flex items-center gap-2"
              >
                {fetching ? <Spinner className="h-3.5 w-3.5" /> : null}
                {fetching ? '抓取中…' : '重新抓取'}
              </span>
            </button>
          </div>
        </div>

        <div className="repository-header-metrics mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <GlanceFact label="Stars" value={formatCount(repository?.stars)} crossfadeFrom={placeholder} />
          <GlanceFact label="Forks" value={formatCount(repository?.forks)} crossfadeFrom={placeholder} />
          <GlanceFact
            label="最近活动"
            value={repository?.pushedAt ? formatRelativeTime(repository.pushedAt) : '—'}
            crossfadeFrom={placeholder}
          />
          <div className="repository-header-release min-w-0" title={repository?.latestReleaseTag ?? undefined}>
            <GlanceFact
              label="最新版本"
              value={repository ? repository.latestReleaseTag ?? '无发版' : '—'}
              mono
              muted={!repository?.latestReleaseTag}
              crossfadeFrom={placeholder}
            />
          </div>
        </div>
      </header>
    </div>
  );
}
