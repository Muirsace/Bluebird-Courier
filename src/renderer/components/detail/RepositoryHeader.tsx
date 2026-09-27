import type { Glance } from '../../../shared/types';
import { formatCount } from '../../lib/format';
import { formatRelativeTime, isWithinDays } from '../../lib/time';
import { ExternalLinkButton } from '../ExternalLinkButton';
import { GlanceFact } from '../GlanceFact';
import { Spinner } from '../Spinner';

interface RepositoryHeaderProps {
  /** 仓库全名：接口数据回来前的保底标题。 */
  fullName: string;
  repository: Glance | undefined;
  fetching: boolean;
  onBack: () => void;
  onRefetch: () => void;
}

/** 仓库详情表头：返回监控清单、仓库名、抓取时间、在 GitHub 打开、重新抓取、四条核心指标。 */
export function RepositoryHeader({
  fullName,
  repository,
  fetching,
  onBack,
  onRefetch,
}: RepositoryHeaderProps) {
  // 详情数据回来前用清单里的全名兜底，外链按钮不会缺席也不会跳错页（主进程还会再校验一次）
  const [owner = '', name = ''] = (repository?.fullName ?? fullName).split('/');

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex h-9 items-center rounded-md border border-default px-3 text-sm text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active"
      >
        ← 返回监控清单
      </button>

      <div className="rounded-lg border border-subtle bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="break-all font-mono text-lg font-semibold text-primary">
              {repository?.fullName ?? fullName}
            </h1>
            <div className="mt-1 text-xs text-muted">
              抓取于 {repository?.fetchedAt ? formatRelativeTime(repository.fetchedAt) : '尚未抓取'}
              {fetching ? <span className="text-secondary"> · 正在更新…</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
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
              className="flex h-9 min-w-26 shrink-0 items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-3 text-sm text-accent transition-colors duration-150 ease-out hover:border-accent/70 hover:bg-accent-soft/70 active:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60"
            >
              {fetching ? <Spinner className="h-3.5 w-3.5" /> : null}
              {fetching ? '抓取中…' : '重新抓取'}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <GlanceFact label="Stars" value={formatCount(repository?.stars)} />
          <GlanceFact label="Forks" value={formatCount(repository?.forks)} />
          <GlanceFact
            label="最近活动"
            value={repository?.pushedAt ? formatRelativeTime(repository.pushedAt) : '—'}
            accent={isWithinDays(repository?.pushedAt ?? null, 7)}
          />
          <GlanceFact
            label="最新版本"
            value={repository ? repository.latestReleaseTag ?? '无发版' : '—'}
            mono
            muted={!repository?.latestReleaseTag}
          />
        </div>
      </div>
    </div>
  );
}
