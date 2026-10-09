export const REFRESH_WINDOW_MS = 60_000;
/** 详情范围验证有效期；任务计划与只读视图使用同一规则。 */
export const DETAIL_VERIFICATION_TTL_MS = 30 * 60_000;
function time(value: string | Date): number { return value instanceof Date ? value.getTime() : Date.parse(value); }
/** 判断两个时间点是否仍处于 60 秒普通回访窗口。 */
export function isWithinRefreshWindow(lastRefreshAt: string | Date, now: string | Date, windowMs = REFRESH_WINDOW_MS): boolean {
  const elapsed = time(now) - time(lastRefreshAt);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < windowMs;
}
/** 普通刷新是否应执行；强制刷新始终执行。 */
export function isRefreshDue(lastRefreshAt: string | Date | null | undefined, now: string | Date, force = false, windowMs = REFRESH_WINDOW_MS): boolean {
  return force || lastRefreshAt == null || !isWithinRefreshWindow(lastRefreshAt, now, windowMs);
}
export const shouldRefresh = isRefreshDue;
export const shouldSkipRefresh = (lastRefreshAt: string | Date | null | undefined, now: string | Date): boolean => !isRefreshDue(lastRefreshAt, now);

/**
 * 验证有效期是否已过：null 或无效时间视为需要验证；
 * 时间点晚于 now（时钟回拨等异常）也按需要验证处理。now 由调用方传入。
 */
export function isVerificationExpired(lastCheckedAt: string | Date | null | undefined, now: string | Date, ttlMs: number): boolean {
  if (lastCheckedAt == null) return true;
  const checked = time(lastCheckedAt);
  if (!Number.isFinite(checked)) return true;
  const elapsed = time(now) - checked;
  return elapsed < 0 || elapsed >= ttlMs;
}
