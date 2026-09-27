import type { Detail } from '../../../shared/types';
import { Section } from '../Section';
import { ReleaseList } from './ReleaseList';

/** 「发版」Tab：完整发版列表。 */
export function ReleaseTab({ releases, owner, name }: { releases: Detail['releases']; owner: string; name: string }) {
  return (
    <Section title="发版">
      <ReleaseList releases={releases} owner={owner} name={name} />
      {releases.length > 0 ? (
        <p className="mt-2 text-xs text-muted">已抓取 {releases.length} 条</p>
      ) : null}
    </Section>
  );
}
