// 时间格式化纯函数：参数化 now、30/31 完整日边界、非法/显著未来时间不可用、活动悬停说明。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatActivityTooltip,
  formatDate,
  formatDateTime,
  formatRelativeTime,
} from '../../src/renderer/lib/time';

const NOW = new Date('2026-10-07T04:00:00.000Z').getTime();
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

afterEach(() => {
  vi.useRealTimers();
});

describe('formatRelativeTime · 相对时间档位', () => {
  it('不足 1 分钟显示刚刚，整分钟起逐档切换', () => {
    expect(formatRelativeTime(iso(-59_000), NOW)).toBe('刚刚');
    expect(formatRelativeTime(iso(-60_000), NOW)).toBe('1 分钟前');
    expect(formatRelativeTime(iso(-59 * 60_000), NOW)).toBe('59 分钟前');
    expect(formatRelativeTime(iso(-60 * 60_000), NOW)).toBe('1 小时前');
    expect(formatRelativeTime(iso(-23 * 3_600_000), NOW)).toBe('23 小时前');
    expect(formatRelativeTime(iso(-24 * 3_600_000), NOW)).toBe('1 天前');
  });

  it('30 个完整日仍显示相对时间，31 个完整日起显示绝对日期', () => {
    expect(formatRelativeTime(iso(-30 * 86_400_000), NOW)).toBe('30 天前');
    const old = iso(-31 * 86_400_000);
    expect(formatRelativeTime(old, NOW)).toBe(formatDate(old));
    expect(formatRelativeTime(old, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatRelativeTime(old, NOW)).not.toContain('天前');
  });

  it('参数化 now 兼容无参调用：同一时间戳按传入的 now 取值，缺省用当前时间', () => {
    const at = iso(0);
    expect(formatRelativeTime(at, NOW + 3_600_000)).toBe('1 小时前');
    expect(formatRelativeTime(at, NOW)).toBe('刚刚');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW + 2 * 86_400_000);
    expect(formatRelativeTime(at)).toBe('2 天前');
  });

  it('缺失或非法时间返回不可用', () => {
    expect(formatRelativeTime(null, NOW)).toBe('—');
    expect(formatRelativeTime(undefined, NOW)).toBe('—');
    expect(formatRelativeTime('', NOW)).toBe('—');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('—');
  });

  it('显著未来时间不显示刚刚；容忍窗口内仍按刚刚展示', () => {
    expect(formatRelativeTime(iso(30_000), NOW)).toBe('刚刚');
    expect(formatRelativeTime(iso(4 * 60_000), NOW)).toBe('刚刚');
    expect(formatRelativeTime(iso(6 * 60_000), NOW)).toBe('—');
    expect(formatRelativeTime(iso(86_400_000), NOW)).toBe('—');
  });
});

describe('formatActivityTooltip · 活动来源与检查时间', () => {
  it('按 activityKind 提供中文来源与准确本地时间', () => {
    const at = iso(-3_600_000);
    const stamp = formatDateTime(at);
    expect(formatActivityTooltip(at, 'code', null, NOW)).toBe(`最近代码更新：${stamp}`);
    expect(formatActivityTooltip(at, 'release', null, NOW)).toBe(`最近发版：${stamp}`);
    expect(formatActivityTooltip(at, 'pull-request', null, NOW)).toBe(`最近 PR 活动：${stamp}`);
    expect(formatActivityTooltip(at, 'issue', null, NOW)).toBe(`最近 Issue 活动：${stamp}`);
  });

  it('摘要检查时间另行标注，与活动时间分两行', () => {
    const at = iso(-3_600_000);
    const fetchedAt = iso(-120_000);
    const tooltip = formatActivityTooltip(at, 'code', fetchedAt, NOW);
    expect(tooltip?.split('\n')).toEqual([
      `最近代码更新：${formatDateTime(at)}`,
      `上次检查摘要：${formatDateTime(fetchedAt)}`,
    ]);
  });

  it('活动时间不可用时只保留检查时间，两者都不可用则无说明', () => {
    const fetchedAt = iso(-60_000);
    expect(formatActivityTooltip(null, null, fetchedAt, NOW)).toBe(`上次检查摘要：${formatDateTime(fetchedAt)}`);
    expect(formatActivityTooltip('broken', 'code', fetchedAt, NOW)).toBe(`上次检查摘要：${formatDateTime(fetchedAt)}`);
    expect(formatActivityTooltip(iso(86_400_000), 'code', fetchedAt, NOW)).toBe(`上次检查摘要：${formatDateTime(fetchedAt)}`);
    expect(formatActivityTooltip(null, null, null, NOW)).toBeUndefined();
  });

  it('有活动时间但缺少类型时退回通用说明，不猜测来源', () => {
    const at = iso(-60_000);
    expect(formatActivityTooltip(at, null, null, NOW)).toBe(`最近活动：${formatDateTime(at)}`);
  });
});
