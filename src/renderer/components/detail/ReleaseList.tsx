import type { ReleaseItem } from '../../../shared/types';
import { PRERELEASE_LABELS, classifyReleaseTag, dedupeReleaseTitle } from '../../lib/release';
import type { PrereleaseKind } from '../../lib/release';
import { formatDate } from '../../lib/time';
import { ExternalLinkButton } from '../ExternalLinkButton';

/**
 * 预发布类型徽章：只在 tag 里明确写了 alpha / beta / rc 时出现。
 * 没有 prerelease 字段可用，所以不对"普通版本号"推断 Stable——不显示比标错更诚实。
 */
const KIND_TONES: Record<PrereleaseKind, string> = {
  rc: 'border-subtle bg-surface-raised text-muted',
  beta: 'border-subtle bg-surface-raised text-muted',
  alpha: 'border-subtle bg-surface-raised text-muted',
};

export function ReleaseKindBadge({ tagName }: { tagName: string }) {
  const kind = classifyReleaseTag(tagName);
  if (kind === null) return null;
  return (
    <span className={`inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-[11px] ${KIND_TONES[kind]}`}>
      {PRERELEASE_LABELS[kind]}
    </span>
  );
}

interface ReleaseListProps {
  releases: ReleaseItem[];
  owner: string;
  name: string;
}

/** 发版行：Tag（可点开 GitHub 发版页）→ 类型 → 发布日期，标题只在它与 Tag 不同时另起一行。 */
export function ReleaseList({ releases, owner, name }: ReleaseListProps) {
  if (releases.length === 0) {
    return <p className="text-sm text-muted">无发版</p>;
  }
  return (
    <ul className="divide-y divide-subtle">
      {releases.map((release, index) => {
        const title = dedupeReleaseTitle(release.title, release.tagName);
        return (
          <li key={`${release.tagName}|${index}`} className="py-2 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <ExternalLinkButton
                target={{ kind: 'release', owner, name, tagName: release.tagName }}
                label={`在 GitHub 打开发版 ${release.tagName}`}
                className="break-all font-mono text-[13px] text-accent transition-colors duration-150 ease-out hover:underline active:text-accent-hover"
              >
                {release.tagName}
              </ExternalLinkButton>
              <ReleaseKindBadge tagName={release.tagName} />
              <span className="ml-auto shrink-0 text-xs text-muted">{formatDate(release.publishedAt)}</span>
            </div>
            {title ? <div className="mt-1 text-sm font-medium text-primary">{title}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}
