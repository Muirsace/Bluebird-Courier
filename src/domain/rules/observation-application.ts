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

/**
 * 验证发现变化时映射的范围与 dirty 原因：构建变化由范围抓取同时修补使用构建字段的 overview；
 * 其余范围保守使用通用原因（不冒充具体来源，也不参与构建组局部修补）。
 */
export function verificationChangeScopes(scope: DetailScope): { scopes: DetailScope[]; reason: string } {
  if (scope === 'builds') return { scopes: ['overview', 'builds'], reason: 'build' };
  return { scopes: [scope], reason: 'verify' };
}

/**
 * 应用一次范围验证结果：只有完整检查才更新检查时间与观察指纹；
 * 发现变化按范围标记待同步（保留旧 dirty 与同步基线）；
 * 检查未完成时不推进检查基线，但已发现的变化证据保留为 dirty，采集指纹只作为观察记录。
 */
export function applyScopeVerification(base: ScopeSyncState, result: {
  checkComplete: boolean;
  changed: boolean;
  checkedAt: string;
  fingerprint?: string;
  /** 发现变化时使用的 dirty 原因（由 verificationChangeScopes 提供）。 */
  changedReason?: string;
}): ScopeSyncState {
  const newEvidence = result.changed && (result.fingerprint !== undefined
    ? result.fingerprint !== base.observedFingerprint
    : !base.dirtyReasons.includes(result.changedReason ?? 'verify'));
  if (!result.checkComplete) {
    const observed = newEvidence
      ? applyScopeObservation(base, result.changedReason !== undefined ? [result.changedReason] : [])
      : base;
    return result.fingerprint !== undefined && result.fingerprint !== observed.observedFingerprint
      ? { ...observed, observedFingerprint: result.fingerprint }
      : observed;
  }
  const withObservation = result.fingerprint !== undefined ? { observedFingerprint: result.fingerprint } : {};
  if (newEvidence) {
    const observed = applyScopeObservation(base, result.changedReason !== undefined ? [result.changedReason] : []);
    return { ...observed, checkStatus: 'idle', lastCheckError: undefined, lastCheckFailure: undefined, lastCheckedAt: result.checkedAt, ...withObservation };
  }
  return { ...base, checkStatus: 'idle', lastCheckedAt: result.checkedAt, lastCheckError: undefined, lastCheckFailure: undefined,
    freshness: deriveFreshness(ledgerOf(base), true), ...withObservation };
}
