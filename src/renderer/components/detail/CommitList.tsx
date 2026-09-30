import type { CommitItem } from '../../../shared/types';
import { formatRelativeTime } from '../../lib/time';
import { ExternalLinkButton } from '../ExternalLinkButton';

interface CommitListProps {
  commits: CommitItem[];
  owner: string;
  name: string;
}

/**
 * 提交行：消息（第一视觉层，超长一行截断、title 露出全文）→ 作者 · 相对时间 → SHA。
 * SHA 用等宽弱色放在行末，只作定位用，不抢注意力，点它可打开 GitHub 上的该次提交。
 */
export function CommitList({ commits, owner, name }: CommitListProps) {
  if (commits.length === 0) {
    return <p className="text-sm text-muted">无提交</p>;
  }
  return (
    <ul className="divide-y divide-subtle">
      {commits.map((commit, index) => (
        <li key={`${commit.sha}|${index}`} className="py-2 first:pt-0 last:pb-0">
          <div className="truncate text-sm font-medium text-primary" title={commit.message}>
            {commit.message}
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
            <span className="text-secondary">{commit.authorName ?? '—'}</span>
            <span aria-hidden="true" className="text-muted">
              ·
            </span>
            <span className="text-muted">{formatRelativeTime(commit.committedAt)}</span>
            <span aria-hidden="true" className="text-muted">
              ·
            </span>
            <ExternalLinkButton
              target={{ kind: 'commit', owner, name, sha: commit.sha }}
              label={`在 GitHub 打开提交 ${commit.sha.slice(0, 7)}`}
              linkStyle
              className="font-mono text-muted transition-colors duration-150 ease-out hover:text-secondary hover:underline active:text-primary"
            >
              {commit.sha.slice(0, 7)}
            </ExternalLinkButton>
          </div>
        </li>
      ))}
    </ul>
  );
}
