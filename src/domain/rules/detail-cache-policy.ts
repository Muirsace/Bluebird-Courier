import type { CacheStatus, Freshness } from '../types';
import { isVerificationExpired } from './refresh-window';

export type DetailCachePolicy = 'full' | 'reuse';
export interface DetailCacheSnapshot { hasDetail: boolean; }
export interface DetailChangeSet { releaseChanged: boolean; tagChanged: boolean; codeChanged: boolean; collaborationChanged: boolean; summaryChanged: boolean; force: boolean; }
/** 根据缓存存在、实质变化和强制按钮决定完整抓取或复用。 */
export function decideDetailCachePolicy(cache: DetailCacheSnapshot | null, changes: DetailChangeSet): DetailCachePolicy {
  if (changes.force || !cache?.hasDetail) return 'full';
  return changes.releaseChanged || changes.tagChanged || changes.codeChanged || changes.collaborationChanged ? 'full' : 'reuse';
}
export const detailCachePolicy = decideDetailCachePolicy;
export const getDetailCachePolicy = decideDetailCachePolicy;

/** 缓存可展示性：有效旧缓存即使 stale 仍可展示；缺失或损坏不冒充有效内容。 */
export type CacheDisplayDecision = 'show-cached' | 'show-empty';
export function decideCacheDisplay(cache: { hasDetail: boolean; cacheStatus: CacheStatus }): CacheDisplayDecision {
  return cache.hasDetail && cache.cacheStatus === 'valid' ? 'show-cached' : 'show-empty';
}

export type VerificationDecision = 'skip' | 'verify' | 'rebuild';
export interface VerificationInput {
  cacheStatus: CacheStatus;
  freshness: Freshness;
  lastCheckedAt: string | null;
  /** 调用方传入的时间；规则不读时钟。 */
  now: string;
  ttlMs: number;
  defaultBranchChanged: boolean;
  contextChanged: boolean;
}

/**
 * 验证决策与展示决策分离：
 * 重建原因（无缓存、上下文或默认分支变化）优先；
 * 已知未同步变化（stale）跳过重复验证，由同步确认清账；
 * fresh 且未过期跳过；过期或 unknown 需要验证。
 */
export function decideVerification(input: VerificationInput): VerificationDecision {
  if (input.cacheStatus !== 'valid' || input.contextChanged || input.defaultBranchChanged) return 'rebuild';
  if (input.freshness === 'stale') return 'skip';
  if (input.freshness === 'unknown') return 'verify';
  return isVerificationExpired(input.lastCheckedAt, input.now, input.ttlMs) ? 'verify' : 'skip';
}
