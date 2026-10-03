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
