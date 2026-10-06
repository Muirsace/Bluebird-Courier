import type { ActivityCandidate, ActivityKind, RepoActivity } from '../types';

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

/** 同一时间多个来源时的固定类型优先级（悬停说明取其一，结果稳定）。 */
export const ACTIVITY_KIND_PRIORITY: readonly ActivityKind[] = ['release', 'code', 'pull-request', 'issue'];
/** 时间显著超越 now 判为异常的上限；相对现在的容忍窗口由调用方按需覆盖。 */
export const ACTIVITY_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function time(value: string | Date): number { return value instanceof Date ? value.getTime() : Date.parse(value); }
function kindRank(kind: ActivityKind): number {
  const index = ACTIVITY_KIND_PRIORITY.indexOf(kind);
  return index < 0 ? ACTIVITY_KIND_PRIORITY.length : index;
}

/**
 * 从归一化候选计算统一活动结果：
 * 只看重要候选；无效或显著未来时间被拒绝；同时间按固定类型优先级选择。
 * 结果同时供卡片显示、悬停说明与清单排序使用。
 */
export function resolveActivity(
  candidates: readonly ActivityCandidate[],
  now: string | Date,
  futureToleranceMs = ACTIVITY_FUTURE_TOLERANCE_MS,
): RepoActivity {
  const ceiling = time(now) + futureToleranceMs;
  let best: { at: string; atMs: number; kind: ActivityKind } | null = null;
  for (const candidate of candidates) {
    if (!candidate.important || !candidate.at) continue;
    const atMs = Date.parse(candidate.at);
    if (!Number.isFinite(atMs) || atMs > ceiling) continue;
    if (!best || atMs > best.atMs || (atMs === best.atMs && kindRank(candidate.kind) < kindRank(best.kind))) {
      best = { at: candidate.at, atMs, kind: candidate.kind };
    }
  }
  return best ? { at: best.at, kind: best.kind } : { at: null, kind: null };
}

function resolvedValue(activity: RepoActivity): number {
  if (!activity.at) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(activity.at);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** 用统一活动结果排序：降序，无有效活动的数据排在最后。 */
export function compareResolvedActivity(left: RepoActivity, right: RepoActivity): number {
  return resolvedValue(right) - resolvedValue(left);
}
