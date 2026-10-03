export interface ActivityTimes { code: string | null | undefined; collaboration: string | null | undefined; }
/** 返回两个活动时间中较新的一个。 */
export function latestActivity(code: string | null | undefined, collaboration: string | null | undefined): string | null {
  if (!code) return collaboration ?? null;
  if (!collaboration) return code;
  return Date.parse(code) >= Date.parse(collaboration) ? code : collaboration;
}
function sortValue(value: ActivityTimes): number { const latest = latestActivity(value.code, value.collaboration); return latest ? Date.parse(latest) : Number.NEGATIVE_INFINITY; }
/** 按最新活动时间降序比较，供 Array.sort 使用。 */
export function compareActivity(left: ActivityTimes, right: ActivityTimes): number { return sortValue(right) - sortValue(left); }
export const activitySort = compareActivity;
export const sortByActivity = compareActivity;
