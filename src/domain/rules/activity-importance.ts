import type { ActivityCandidate, RepositoryObservation, SummaryObservation } from '../types';

/** 协作更新时间只是探测线索；创建、关闭和同记录的重要展示字段变化才构成重要活动。 */
function classifyCollaboration(previous: ActivityCandidate | undefined, next: ActivityCandidate): ActivityCandidate {
  if (!next.at || !next.verified) return { ...next, important: false, importantAt: null };
  if (previous && previous.sourceId === next.sourceId && next.sourceId &&
      previous.contentRevision !== undefined && next.contentRevision !== undefined &&
      previous.contentRevision !== next.contentRevision) {
    return { ...next, important: true, importantAt: next.at };
  }
  const eventAt = next.state === 'closed' ? next.closedAt ?? next.createdAt : next.createdAt;
  return { ...next, importantAt: eventAt ?? null, important: eventAt != null };
}

/** 纯规则分类；初始推送时间可作线索，已知默认分支未变时其他推送不刷新代码活动。 */
export function classifyObservationActivity(previous: RepositoryObservation | null, next: SummaryObservation): SummaryObservation['activity'] {
  const prev = previous?.accessContextRevision === next.accessContextRevision ? previous : null;
  const head = next.signals.headRevision;
  const oldHead = prev?.signals.headRevision;
  const branch = next.signals.defaultBranch;
  const oldBranch = prev?.signals.defaultBranch;
  const codeChanged = head.state === 'known' && head.value !== null &&
    (!oldHead || oldHead.state !== 'known' || oldHead.value !== head.value ||
      (branch.state === 'known' && oldBranch?.state === 'known' && branch.value !== oldBranch.value));
  const code = { ...next.activity.code, importantAt: next.activity.code.at, important: next.activity.code.at !== null &&
    (next.activity.code.verified || prev === null || codeChanged) };
  return {
    code,
    release: { ...next.activity.release, importantAt: next.activity.release.at, important: next.activity.release.at !== null && next.activity.release.verified },
    collaboration: classifyCollaboration(prev?.activity.collaboration, next.activity.collaboration),
  };
}
