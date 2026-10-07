import type { DetailScope, RepoChangeSet, ScopeSyncState } from '../types';
import { scopesAffectedByChange } from './detail-scope';
import { deriveFreshness, ledgerOf, recordObservation } from './scope-ledger';

export function initialScopeState(cacheStatus: ScopeSyncState['cacheStatus'] = 'missing'): ScopeSyncState {
  return { cacheStatus, freshness: 'unknown', checkStatus: 'idle', syncStatus: 'idle',
    detectedRevision: 0, syncedRevision: 0, importantRevision: 0, viewedRevision: 0, dirtyReasons: [] };
}

/** 与唯一范围映射同源收集原因，避免 Tag 等映射在消费端漂移。 */
export function observationReasons(scope: DetailScope, change: RepoChangeSet): string[] {
  const flags = [
    ['default-branch', 'defaultBranchChanged'], ['head', 'headChanged'], ['release', 'releaseChanged'],
    ['tag', 'tagChanged'], ['issues', 'issuesChanged'], ['build', 'buildsChanged'],
  ] as const;
  return flags.filter(([, flag]) => change[flag] &&
    scopesAffectedByChange({ headChanged: false, releaseChanged: false, tagChanged: false,
      issuesChanged: false, buildsChanged: false, defaultBranchChanged: false, [flag]: true }).includes(scope))
    .map(([reason]) => reason);
}

/** 应用一次内容观察：保留旧 dirty 和同步基线，每范围只递增一次，并记录重要版本。 */
export function applyScopeObservation(base: ScopeSyncState, reasons: readonly string[]): ScopeSyncState {
  const ledger = recordObservation(ledgerOf(base), true);
  return { ...base, detectedRevision: ledger.detectedRevision, importantRevision: ledger.detectedRevision,
    dirtyReasons: [...new Set([...ledger.dirtyReasons, ...reasons])], freshness: deriveFreshness(ledger, false) };
}
