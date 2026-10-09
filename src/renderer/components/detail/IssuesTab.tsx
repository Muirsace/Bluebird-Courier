import type { Detail } from '../../../shared/types';
import { Section } from '../Section';
import { IssuesAndPulls } from './IssuesAndPulls';

/** 「Issue & PR」Tab：完整议题与合并请求列表。 */
export function IssuesTab({
  issues,
  pullRequests,
  owner,
  name,
  incomplete = false,
  issuesDisabled = false,
  pullsDisabled = false,
}: {
  issues: Detail['issues'];
  pullRequests: Detail['pullRequests'];
  owner: string;
  name: string;
  /** 本地读取被截断：空的一侧不显示成"确认没有"。 */
  incomplete?: boolean;
  issuesDisabled?: boolean;
  pullsDisabled?: boolean;
}) {
  return (
    <Section title="Issue & PR">
      <IssuesAndPulls issues={issues} pullRequests={pullRequests} owner={owner} name={name} incomplete={incomplete}
        issuesDisabled={issuesDisabled} pullsDisabled={pullsDisabled} />
    </Section>
  );
}
