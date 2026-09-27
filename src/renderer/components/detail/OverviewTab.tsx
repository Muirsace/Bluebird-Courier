import type { Detail, IssueItem, PullRequestItem } from '../../../shared/types';
import { GlanceFact } from '../GlanceFact';
import { Section } from '../Section';
import { BuildStatusPanel } from './BuildStatus';
import { CommitList } from './CommitList';
import { IssueEmptyState, NumberedItemRow } from './IssuesAndPulls';
import { ReleaseList } from './ReleaseList';
import { TrendPanel } from './TrendPanel';

/** 概览每条摘要最多显示几条；完整内容仍在各自 Tab。 */
const SUMMARY_LIMIT = 5;
/** 概览里最近更新列表的条数。 */
const RECENT_LIMIT = 3;

interface OverviewTabProps {
  detail: Detail;
}

function byUpdatedDesc(a: IssueItem | PullRequestItem, b: IssueItem | PullRequestItem): number {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

function RecentList({
  title,
  kind,
  items,
  owner,
  name,
}: {
  title: string;
  kind: 'issue' | 'pull';
  items: (IssueItem | PullRequestItem)[];
  owner: string;
  name: string;
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-secondary">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted">无</p>
      ) : (
        <ul className="divide-y divide-subtle">
          {items.map((item, index) => (
            <NumberedItemRow
              key={`${item.number}|${index}`}
              item={item}
              kind={kind}
              owner={owner}
              name={name}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** 概览：第一屏回答"这个仓库最近怎么样"——构建是否正常、最近发了什么、最近在改什么。 */
export function OverviewTab({ detail }: OverviewTabProps) {
  const { repository, build, releases, commits, issues, pullRequests, trend } = detail;
  const { owner, name } = repository;
  const openIssues = issues.filter((issue) => issue.state === 'open').length;
  const openPulls = pullRequests.filter((pull) => pull.state === 'open').length;
  const noIssuesAtAll = issues.length === 0 && pullRequests.length === 0;

  return (
    <div className="space-y-4">
      <Section title="构建状态">
        <BuildStatusPanel build={build} />
      </Section>

      {/* min-w-0：提交消息是 truncate（nowrap）的，网格项默认 min-width:auto 会被它撑宽整列 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <Section title="最新发版">
            <ReleaseList releases={releases.slice(0, SUMMARY_LIMIT)} owner={owner} name={name} />
            {releases.length > SUMMARY_LIMIT ? (
              <p className="mt-2 text-xs text-muted">
                仅显示最近 {SUMMARY_LIMIT} 条，已抓取 {releases.length} 条
              </p>
            ) : null}
          </Section>
        </div>

        <div className="min-w-0">
          <Section title="最近提交">
            <CommitList commits={commits.slice(0, SUMMARY_LIMIT)} owner={owner} name={name} />
            {commits.length > SUMMARY_LIMIT ? (
              <p className="mt-2 text-xs text-muted">
                仅显示最近 {SUMMARY_LIMIT} 条，已抓取 {commits.length} 条
              </p>
            ) : null}
          </Section>
        </div>
      </div>

      <Section title="Issue & PR">
        {noIssuesAtAll ? (
          <IssueEmptyState />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <GlanceFact
                label="议题"
                value={`开启 ${openIssues} · 已关闭 ${issues.length - openIssues}`}
              />
              <GlanceFact
                label="合并请求"
                value={`开启 ${openPulls} · 已关闭 ${pullRequests.length - openPulls}`}
              />
            </div>
            <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
              <RecentList
                title="最近更新的议题"
                kind="issue"
                items={[...issues].sort(byUpdatedDesc).slice(0, RECENT_LIMIT)}
                owner={owner}
                name={name}
              />
              <RecentList
                title="最近更新的合并请求"
                kind="pull"
                items={[...pullRequests].sort(byUpdatedDesc).slice(0, RECENT_LIMIT)}
                owner={owner}
                name={name}
              />
            </div>
          </div>
        )}
      </Section>

      <Section title="趋势摘要">
        <TrendPanel trend={trend} scope="all" compact />
      </Section>
    </div>
  );
}
