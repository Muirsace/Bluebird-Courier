export type EligibilityReason = 'private' | 'duplicate' | 'limit_reached';
export interface RepositoryEligibilityInput { isPublic: boolean; isDuplicate: boolean; currentCount: number; maxCount?: number; }
export type RepositoryEligibility = { eligible: true } | { eligible: false; reason: EligibilityReason };

/** 判断仓库是否符合公开、唯一和数量上限要求。 */
export function isRepositoryEligible(input: RepositoryEligibilityInput): RepositoryEligibility {
  if (!input.isPublic) return { eligible: false, reason: 'private' };
  if (input.isDuplicate) return { eligible: false, reason: 'duplicate' };
  if (input.currentCount >= (input.maxCount ?? 50)) return { eligible: false, reason: 'limit_reached' };
  return { eligible: true };
}
export const canAddRepository = isRepositoryEligible;
