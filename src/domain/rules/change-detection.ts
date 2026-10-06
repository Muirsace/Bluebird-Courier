import type { CheckedSignal, RepoChangeSet, RepositoryObservation } from '../types';
import { scopesAffectedByChange } from './detail-scope';

/** 已确认信号的值；unknown 返回 undefined，与 known-null（确认没有）区分。 */
export function signalValue<T>(signal: CheckedSignal<T>): T | null | undefined {
  return signal.state === 'known' ? signal.value : undefined;
}

/** 两个信号之间是否确认发生变化；任一未知都不宣称变化。 */
function changed<T>(previous: CheckedSignal<T> | undefined, next: CheckedSignal<T>): boolean {
  if (!previous || previous.state !== 'known' || next.state !== 'known') return false;
  return previous.value !== next.value;
}

function knownOrNull<T>(signal: CheckedSignal<T> | undefined): T | null {
  return signal && signal.state === 'known' ? signal.value : null;
}

/**
 * 观察是否可比较：必须是同一仓库、同一访问上下文的两次观察。
 * 跨仓库或跨上下文的前一份观察一律不参与比较，避免旧 Token 或别的仓库结论串入。
 */
export function isComparableObservation(previous: RepositoryObservation | null, next: RepositoryObservation): boolean {
  return previous !== null
    && previous.repoId === next.repoId
    && previous.accessContextRevision === next.accessContextRevision;
}

/**
 * 比较上一次与本次归一化观察，生成变化集。
 * 只比较同一仓库、同一访问上下文内已知的信号；
 * 首次观察或跨仓库 / 跨上下文观察不宣称任何变化。
 */
export function detectChanges(previous: RepositoryObservation | null, next: RepositoryObservation): RepoChangeSet {
  const comparable = isComparableObservation(previous, next);
  const prev = comparable && previous ? previous.signals : undefined;
  const changeSet: RepoChangeSet = {
    repoId: next.repoId,
    starsChanged: comparable && previous !== null && previous.values.stars !== next.values.stars,
    forksChanged: comparable && previous !== null && previous.values.forks !== next.values.forks,
    headChanged: changed(prev?.headRevision, next.signals.headRevision),
    releaseChanged: changed(prev?.releaseRevision, next.signals.releaseRevision),
    tagChanged: changed(prev?.tagRevision, next.signals.tagRevision),
    issuesChanged: false,
    buildsChanged: false,
    defaultBranchChanged: changed(prev?.defaultBranch, next.signals.defaultBranch),
    previousHeadRevision: knownOrNull(prev?.headRevision),
    currentHeadRevision: knownOrNull(next.signals.headRevision),
    affectedScopes: [],
    detectedAt: next.observedAt,
  };
  changeSet.affectedScopes = scopesAffectedByChange(changeSet);
  return changeSet;
}

type ChangeFlags = Pick<RepoChangeSet, 'headChanged' | 'releaseChanged' | 'tagChanged' | 'issuesChanged' | 'buildsChanged' | 'defaultBranchChanged'>;

/** 是否存在内容变化（非仅指标）。 */
export function hasContentChanges(change: ChangeFlags): boolean {
  return change.headChanged || change.releaseChanged || change.tagChanged || change.issuesChanged || change.buildsChanged || change.defaultBranchChanged;
}

/** 仅指标变化：只更新摘要与 Header，不产生详情范围 dirty。 */
export function isCosmeticOnly(change: ChangeFlags & Pick<RepoChangeSet, 'starsChanged' | 'forksChanged'>): boolean {
  return (change.starsChanged || change.forksChanged) && !hasContentChanges(change);
}
