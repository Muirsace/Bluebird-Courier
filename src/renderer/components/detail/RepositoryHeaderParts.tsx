import type { ReactNode } from 'react';
import type { Glance } from '../../../shared/types';
import { formatCount } from '../../lib/format';
import { formatRelativeTime } from '../../lib/time';
import { ExternalLinkButton } from '../ExternalLinkButton';
import { GlanceFact } from '../GlanceFact';
import { Spinner } from '../Spinner';

export interface RepositoryHeaderSlots {
  identity: ReactNode;
  actions: ReactNode;
  metrics: ReactNode;
}

interface RepositoryIdentityProps {
  displayName: string;
  owner: string;
  name: string;
  headingLevel: 'h1' | 'h2';
  fetchedAt: Glance['fetchedAt'] | undefined;
  fetching: boolean;
}

export function RepositoryIdentity({ displayName, owner, name, headingLevel: Heading, fetchedAt, fetching }: RepositoryIdentityProps) {
  return (
    <div className="repository-header-identity min-w-0">
      <Heading className="repository-header-name break-all font-mono text-lg font-semibold text-primary" title={displayName} aria-label={displayName}>
        {name}
      </Heading>
      <div className="repository-header-owner mt-1 truncate text-sm text-secondary" title={owner}>{owner}</div>
      <div className="repository-header-fetched mt-1 text-xs text-muted">
        抓取于 {fetchedAt ? formatRelativeTime(fetchedAt) : '尚未抓取'}
        {fetching ? <span className="text-secondary"> · 正在更新…</span> : null}
      </div>
    </div>
  );
}

interface RepositoryActionsProps {
  displayName: string;
  owner: string;
  name: string;
  fetching: boolean;
  onRefetch: () => void;
}

export function RepositoryActions({ displayName, owner, name, fetching, onRefetch }: RepositoryActionsProps) {
  return (
    <div className="repository-header-actions flex shrink-0 flex-wrap items-center gap-2">
      <ExternalLinkButton
        target={{ kind: 'repository', owner, name }}
        label={`在 GitHub 打开 ${displayName}`}
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
        {/* min-width 保持按钮宽度，沿用抓取状态文案与原有 Motion。 */}
        <span key={fetching ? 'busy' : 'idle'} className="detail-refetch-label flex items-center gap-2">
          {fetching ? <Spinner className="h-3.5 w-3.5" /> : null}
          {fetching ? '抓取中…' : '重新抓取'}
        </span>
      </button>
    </div>
  );
}

export function RepositoryMetrics({ repository, revealing }: { repository: Glance | undefined; revealing: boolean }) {
  const placeholder = revealing ? '—' : undefined;
  return (
    <div className="repository-header-metrics mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2">
      <GlanceFact label="Stars" value={formatCount(repository?.stars)} crossfadeFrom={placeholder} />
      <GlanceFact label="Forks" value={formatCount(repository?.forks)} crossfadeFrom={placeholder} />
      <GlanceFact label="最近活动" value={repository?.pushedAt ? formatRelativeTime(repository.pushedAt) : '—'} crossfadeFrom={placeholder} />
      <div className="repository-header-release min-w-0" title={repository?.latestReleaseTag ?? undefined}>
        <GlanceFact label="最新版本" value={repository ? repository.latestReleaseTag ?? '无发版' : '—'}
          mono muted={!repository?.latestReleaseTag} crossfadeFrom={placeholder} />
      </div>
    </div>
  );
}
