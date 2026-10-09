import type { Detail, IssueItem, PullRequestItem } from '../../../shared/types';
import { DETAIL_REVEAL_MOTION } from '../../lib/motion';
import { GlanceFact } from '../GlanceFact';
import { Section } from '../Section';
import { SectionMessage } from '../StateMessage';
import { BuildStatusPanel } from './BuildStatus';
import { CommitList } from './CommitList';
import { IssueEmptyState, NumberedItemRow, UNREAD_GROUP_COPY } from './IssuesAndPulls';
import { ReleaseList } from './ReleaseList';
import { RevealItem } from './RevealItem';
import { TrendPanel } from './TrendPanel';

/** 概览每条摘要最多显示几条；完整内容仍在各自 Tab。 */
const SUMMARY_LIMIT = 5;
/** 概览里最近更新列表的条数。 */
const RECENT_LIMIT = 3;

interface OverviewTabProps {
  detail: Detail;
  /** 议题 / 合并请求范围本地读取被截断：不把"这一段里没有"当成"确认没有"。 */
  incompleteIssueScope?: boolean;
  issuesDisabled?: boolean;
  pullsDisabled?: boolean;
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
  disabled = false,
}: {
  title: string;
  kind: 'issue' | 'pull';
  items: (IssueItem | PullRequestItem)[];
  owner: string;
  name: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-secondary">{title}</h3>
      {disabled ? <SectionMessage>此仓库未启用 {kind === 'issue' ? 'Issue' : 'Pull Request'}</SectionMessage> : items.length === 0 ? (
        <SectionMessage>{kind === 'issue' ? '暂无议题' : '暂无合并请求'}</SectionMessage>
      ) : (
        <ul className="divide-y divide-subtle">
          {items.map((item, index) => (
            <NumberedItemRow
              key={`${item.number}|${index}`}
              item={item}
              kind={kind}
              owner={owner}
              name={name}
              showBody={false}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** 概览：第一屏回答"这个仓库最近怎么样"——构建是否正常、最近发了什么、最近在改什么。 */
export function OverviewTab({ detail, incompleteIssueScope = false, issuesDisabled = false, pullsDisabled = false }: OverviewTabProps) {
  const { repository, build, releases, commits, issues, pullRequests, trend } = detail;
  const { owner, name } = repository;
  const openIssues = issues.filter((issue) => issue.state === 'open').length;
  const openPulls = pullRequests.filter((pull) => pull.state === 'open').length;
  const noIssuesAtAll = issues.length === 0 && pullRequests.length === 0;

  return (
    <div className="space-y-4">
      {/* 首次揭示：只做 Section 级错峰（相邻两层差 30～40ms），任何一层内部都不逐行播放 */}
      <RevealItem
        delayMs={DETAIL_REVEAL_MOTION.buildDelayMs}
        durationMs={DETAIL_REVEAL_MOTION.buildMs}
        shiftPx={DETAIL_REVEAL_MOTION.buildShiftPx}
      >
        <Section title="构建状态">
          <BuildStatusPanel build={build} owner={owner} name={name} compact />
        </Section>
      </RevealItem>

      {/* min-w-0：提交消息是 truncate（nowrap）的，网格项默认 min-width:auto 会被它撑宽整列 */}
      <RevealItem
        delayMs={DETAIL_REVEAL_MOTION.releaseDelayMs}
        durationMs={DETAIL_REVEAL_MOTION.sectionMs}
        shiftPx={DETAIL_REVEAL_MOTION.sectionShiftPx}
      >
        <div className="detail-overview-updates grid gap-4 lg:grid-cols-2">
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
      </RevealItem>

      <RevealItem
        delayMs={DETAIL_REVEAL_MOTION.issueDelayMs}
        durationMs={DETAIL_REVEAL_MOTION.sectionMs}
        shiftPx={DETAIL_REVEAL_MOTION.sectionShiftPx}
      >
        <Section title="Issue & PR">
          {noIssuesAtAll && !issuesDisabled && !pullsDisabled ? (
            incompleteIssueScope ? <SectionMessage>{UNREAD_GROUP_COPY}</SectionMessage> : <IssueEmptyState />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <GlanceFact
                  label="议题"
                  value={issuesDisabled ? '未启用' : `开启 ${openIssues} · 已关闭 ${issues.length - openIssues}`}
                />
                <GlanceFact
                  label="合并请求"
                  value={pullsDisabled ? '未启用' : `开启 ${openPulls} · 已关闭 ${pullRequests.length - openPulls}`}
                />
              </div>
              {incompleteIssueScope ? (
                <p className="text-xs text-muted">本地只读取了前一段，计数与列表都只覆盖这一段。</p>
              ) : null}
              <div className="detail-overview-issues grid gap-x-6 gap-y-3 md:grid-cols-2">
                <RecentList
                  title="最近更新的议题"
                  kind="issue"
                  disabled={issuesDisabled}
                  items={[...issues].sort(byUpdatedDesc).slice(0, RECENT_LIMIT)}
                  owner={owner}
                  name={name}
                />
                <RecentList
                  title="最近更新的合并请求"
                  kind="pull"
                  disabled={pullsDisabled}
                  items={[...pullRequests].sort(byUpdatedDesc).slice(0, RECENT_LIMIT)}
                  owner={owner}
                  name={name}
                />
              </div>
            </div>
          )}
        </Section>
      </RevealItem>

      <RevealItem
        delayMs={DETAIL_REVEAL_MOTION.trendDelayMs}
        durationMs={DETAIL_REVEAL_MOTION.sectionMs}
        shiftPx={DETAIL_REVEAL_MOTION.sectionShiftPx}
      >
        <Section title="趋势摘要">
          <TrendPanel trend={trend} scope="all" compact />
        </Section>
      </RevealItem>
    </div>
  );
}
