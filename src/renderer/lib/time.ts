/**
 * 时间展示：所有时间戳都是 UTC ISO8601 字符串，
 * 展示为本地时区的中文相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前），更早则显示 YYYY-MM-DD。
 */
import type { ActivityKind } from '../../shared/types';

/** 相对时间切换到绝对日期的天数上限；31 个完整日起显示绝对日期。 */
const RELATIVE_DAYS_LIMIT = 30;
/**
 * 显著未来时间的容忍窗口：超过该窗口视为不可用，不显示"刚刚"。
 * 与主进程聚合的接受窗口同值；主进程已拒绝的异常值不会到达这里，此处只做展示兜底。
 */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? null : time;
}

/** 可展示的时间戳：可解析且不显著超前于 now；否则返回 null（不可用）。 */
function usableTime(iso: string | null | undefined, now: number): number | null {
  const time = parseTime(iso);
  if (time === null || time > now + FUTURE_TOLERANCE_MS) return null;
  return time;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 中文相对时间；无法解析或显著未来时返回 "—"。now 缺省为当前时间，页面可用共享时钟传入。 */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const time = usableTime(iso, now);
  if (time === null) return '—';
  const diff = now - time;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(diff / 86_400_000);
  if (days <= RELATIVE_DAYS_LIMIT) return `${days} 天前`;
  return formatDate(iso);
}

/** YYYY-MM-DD（本地时区）；无法解析时返回 "—"。 */
export function formatDate(iso: string | null | undefined): string {
  const time = parseTime(iso);
  if (time === null) return '—';
  const d = new Date(time);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** YYYY-MM-DD HH:mm（本地时区）；无法解析时返回 "—"。 */
export function formatDateTime(iso: string | null | undefined): string {
  const time = parseTime(iso);
  if (time === null) return '—';
  const d = new Date(time);
  return `${formatDate(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 活动来源的中文说明；与主进程提供的 activityKind 一一对应。 */
const ACTIVITY_SOURCE_LABELS: Record<ActivityKind, string> = {
  code: '最近代码更新',
  release: '最近发版',
  'pull-request': '最近 PR 活动',
  issue: '最近 Issue 活动',
};

/**
 * 活动时间的悬停说明：来源 + 准确本地时间，摘要检查时间另行标注。
 * 活动时间不可用时只保留检查时间；两者都不可用则不提供说明。
 */
export function formatActivityTooltip(
  activityAt: string | null | undefined,
  activityKind: ActivityKind | null | undefined,
  summaryFetchedAt: string | null | undefined,
  now: number = Date.now(),
): string | undefined {
  const lines: string[] = [];
  if (usableTime(activityAt, now) !== null) {
    const source = activityKind ? ACTIVITY_SOURCE_LABELS[activityKind] : '最近活动';
    lines.push(`${source}：${formatDateTime(activityAt)}`);
  }
  if (usableTime(summaryFetchedAt, now) !== null) {
    lines.push(`上次检查摘要：${formatDateTime(summaryFetchedAt)}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** HH:mm（本地时区），用于限流恢复时间等时刻展示；无法解析时返回 "—"。 */
export function formatClock(iso: string | null | undefined): string {
  const time = parseTime(iso);
  if (time === null) return '—';
  const d = new Date(time);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** MM-DD（本地时区），用于趋势图横轴标签；无法解析时返回 "—"。 */
export function formatShortDate(iso: string | null | undefined): string {
  const time = parseTime(iso);
  if (time === null) return '—';
  const d = new Date(time);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 时间戳是否在最近 N 天内（用于"最近动态时间"的强调色）。 */
export function isWithinDays(iso: string | null | undefined, days: number): boolean {
  const time = parseTime(iso);
  if (time === null) return false;
  const diff = Date.now() - time;
  return diff >= 0 && diff <= days * 86_400_000;
}
