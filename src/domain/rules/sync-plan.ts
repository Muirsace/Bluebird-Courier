import type { CacheStatus, DetailScope, RepoChangeSet } from '../types';
import { hasContentChanges } from './change-detection';
import { scopesAffectedByChange } from './detail-scope';

export type SyncIntent = 'open' | 'check' | 'force';

export type SyncDecision =
  | 'reuse-cache'
  | 'update-summary-only'
  | 'mark-scopes-stale'
  | 'revalidate-scopes'
  | 'background-scope-fetch'
  | 'background-full-fetch'
  | 'force-full-fetch';

export interface SyncPlanInput {
  intent: SyncIntent;
  cacheStatus: CacheStatus;
  changeSet: RepoChangeSet | null;
  /** 尚未同步的已知变化范围（旧 dirty）。 */
  dirtyScopes: readonly DetailScope[];
  /** 各范围未确认的变化原因；overview 缺少来源时不能假定仅由构建变化引起。 */
  dirtyReasonsByScope?: Partial<Record<DetailScope, readonly string[]>>;
  /** 验证已到期但没有成功同步基线的范围；需实际重建，不把初采观察冒充旧缓存基线。 */
  baselineMissingScopes?: readonly DetailScope[];
  /** 验证有效期已过的范围；由 isVerificationExpired 预先算好传入（规则不读时钟）。 */
  expiredScopes: readonly DetailScope[];
}

/** 仅构建变化：第一阶段对构建做独立范围更新，不触发完整抓取。 */
export function hasOnlyBuildChanges(change: RepoChangeSet | null): boolean {
  if (!change || !change.buildsChanged) return false;
  return !change.headChanged && !change.releaseChanged && !change.tagChanged && !change.issuesChanged && !change.defaultBranchChanged;
}

/**
 * 构建独立更新覆盖的范围组：构建本身，以及使用构建字段的 overview。
 * 与 scopesAffectedByChange 的映射保持一致（构建变化映射 overview、builds）。
 */
export const BUILD_SCOPE_GROUP: readonly DetailScope[] = ['overview', 'builds'];

/**
 * 未同步工作是否全部落在构建范围组内。
 * 必须包含 builds 且不含组外范围；单独的 overview 不构成构建组（可能来自其他变化原因），保守走完整同步。
 * 不变量：范围映射中构建变化必然产生 overview + builds，因此该组判定与映射天然一致。
 */
export function isBuildScopeSet(scopes: readonly DetailScope[]): boolean {
  return scopes.includes('builds') && scopes.every((scope) => BUILD_SCOPE_GROUP.includes(scope));
}

/** 只有构建范围组且 overview 的未确认原因全部为 build，才允许随构建局部修补。 */
function canSyncBuildDirtyScopes(input: SyncPlanInput): boolean {
  if (!isBuildScopeSet(input.dirtyScopes)) return false;
  if (!input.dirtyScopes.includes('overview')) return true;
  const reasons = input.dirtyReasonsByScope?.overview;
  return reasons !== undefined && reasons.length > 0 && reasons.every((reason) => reason === 'build');
}

/**
 * 同步计划：综合新变化、旧 dirty 与过期范围，只返回应当发生的动作，不执行 I/O。
 *
 * 不变式：`check` 意图从不触发完整抓取（最多留下待同步标记或做范围验证）；
 * 完整抓取只在打开 / 强制意图下、缓存不可用、缺少过期验证基线或存在非构建范围的未同步工作时出现。
 * 当所有未同步工作都明确属于构建变化时，走 `background-scope-fetch` 独立更新。
 */
export function planSync(input: SyncPlanInput): SyncDecision {
  if (input.intent === 'open' && (input.baselineMissingScopes?.length ?? 0) > 0) return 'background-full-fetch';
  if (input.intent === 'force') return 'force-full-fetch';

  const contentChanged = input.changeSet ? hasContentChanges(input.changeSet) : false;
  const buildsOnly = hasOnlyBuildChanges(input.changeSet);

  if (input.intent === 'check') {
    // 用户手动检查：未查看仓库只留待同步标记，绝不整抓。
    if (contentChanged) return 'mark-scopes-stale';
    if (input.expiredScopes.length > 0) return 'revalidate-scopes';
    if (input.changeSet && (input.changeSet.starsChanged || input.changeSet.forksChanged)) return 'update-summary-only';
    return 'reuse-cache';
  }

  // open 意图
  if (input.cacheStatus !== 'valid') return 'background-full-fetch';
  if (contentChanged && buildsOnly && (input.dirtyScopes.length === 0 || canSyncBuildDirtyScopes(input))) {
    return 'background-scope-fetch';
  }
  if (contentChanged) return 'background-full-fetch';
  if (input.dirtyScopes.length > 0) {
    return canSyncBuildDirtyScopes(input) ? 'background-scope-fetch' : 'background-full-fetch';
  }
  if (input.expiredScopes.length > 0) return 'revalidate-scopes';
  if (input.changeSet && (input.changeSet.starsChanged || input.changeSet.forksChanged)) return 'update-summary-only';
  return 'reuse-cache';
}

/** 变化集里需要标记为待同步的范围；供计划执行方读取。 */
export function staleScopesOf(changeSet: RepoChangeSet): DetailScope[] {
  return scopesAffectedByChange(changeSet);
}
