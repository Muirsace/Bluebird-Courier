import type { Detail } from '../../../shared/types';
import { Section } from '../Section';
import { BuildStatusPanel } from './BuildStatus';

/** 「构建」Tab：最近一次构建的完整状态（状态、工作流、完成时间、原始结论），可跳到 GitHub 上的那次构建。 */
export function BuildTab({ build, owner, name }: { build: Detail['build']; owner: string; name: string }) {
  return (
    <Section title="构建">
      <BuildStatusPanel build={build} owner={owner} name={name} showLink />
    </Section>
  );
}
