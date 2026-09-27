import type { Detail } from '../../../shared/types';
import { Section } from '../Section';
import { CommitList } from './CommitList';

/** 「提交」Tab：完整提交列表。 */
export function CommitTab({ commits, owner, name }: { commits: Detail['commits']; owner: string; name: string }) {
  return (
    <Section title="提交">
      <CommitList commits={commits} owner={owner} name={name} />
      {commits.length > 0 ? (
        <p className="mt-2 text-xs text-muted">已抓取 {commits.length} 条</p>
      ) : null}
    </Section>
  );
}
