import type { Freshness, ScopeSyncState, TaskContext } from '../types';

/** 单范围的本地序号账本；只做记账，不涉及持久化与请求。 */
export interface ScopeLedger {
  detectedRevision: number;
  syncedRevision: number;
  dirtyReasons: string[];
}

export function ledgerOf(scope: Pick<ScopeSyncState, 'detectedRevision' | 'syncedRevision' | 'dirtyReasons'>): ScopeLedger {
  return { detectedRevision: scope.detectedRevision, syncedRevision: scope.syncedRevision, dirtyReasons: [...scope.dirtyReasons] };
}

/**
 * 记录一次观察结果：只有确实发生的新变化递增 detectedRevision；
 * 重复观察同一状态不递增，旧 dirty 也不被清除。
 */
export function recordObservation(ledger: ScopeLedger, changed: boolean, reason?: string): ScopeLedger {
  if (!changed) return ledger;
  const dirtyReasons = reason && !ledger.dirtyReasons.includes(reason)
    ? [...ledger.dirtyReasons, reason]
    : [...ledger.dirtyReasons];
  return { detectedRevision: ledger.detectedRevision + 1, syncedRevision: ledger.syncedRevision, dirtyReasons };
}

export function hasUnsyncedChanges(ledger: ScopeLedger): boolean {
  return ledger.detectedRevision > ledger.syncedRevision;
}

/**
 * 成功同步只确认覆盖到的目标版本：
 * 同步期间的新变化（detected 已超过 target）继续待同步，dirty 原因保留。
 */
export function confirmSynced(ledger: ScopeLedger, confirmation: { targetRevision: number; covered: boolean }): ScopeLedger {
  if (!confirmation.covered || confirmation.targetRevision <= ledger.syncedRevision) return ledger;
  const syncedRevision = Math.min(confirmation.targetRevision, ledger.detectedRevision);
  const cleared = syncedRevision >= ledger.detectedRevision;
  return {
    detectedRevision: ledger.detectedRevision,
    syncedRevision,
    dirtyReasons: cleared ? [] : [...ledger.dirtyReasons],
  };
}

/** 三维度派生新鲜度：已知未同步变化优先于验证有效期。 */
export function deriveFreshness(ledger: ScopeLedger, verificationFresh: boolean): Freshness {
  if (hasUnsyncedChanges(ledger)) return 'stale';
  return verificationFresh ? 'fresh' : 'unknown';
}

/** 未查看圆点：重要变化版本高于实际展示版本。 */
export function deriveUnseen(importantRevision: number, viewedRevision: number): boolean {
  return importantRevision > viewedRevision;
}

/**
 * 写入保护：仓库仍存在、访问上下文一致，
 * 且没有更晚启动的任务（版本更高）抢先时，结果才允许落库。
 */
export function canCommitTaskResult(
  task: TaskContext,
  check: { repositoryExists: boolean; accessContextRevision: number; latestTaskVersion: number },
): boolean {
  return check.repositoryExists
    && task.accessContextRevision === check.accessContextRevision
    && task.taskVersion >= check.latestTaskVersion;
}
