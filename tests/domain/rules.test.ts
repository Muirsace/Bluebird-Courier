import { describe, expect, it } from 'vitest';
import { isRepositoryEligible } from '../../src/domain/rules/repository-eligibility';
import { isRefreshDue, isWithinRefreshWindow } from '../../src/domain/rules/refresh-window';
import { compareActivity, latestActivity } from '../../src/domain/rules/activity-sort';
import { decideDetailCachePolicy } from '../../src/domain/rules/detail-cache-policy';
import { classifyColumnResponse } from '../../src/domain/rules/column-state';
import { resolveFailureState } from '../../src/domain/rules/failure-state';
import { retainRecentSnapshots } from '../../src/domain/rules/snapshot-retention';

describe('领域规则', () => {
  it('按公开、重复和数量限制判断清单资格', () => {
    expect(isRepositoryEligible({ isPublic: true, isDuplicate: false, currentCount: 49 })).toEqual({ eligible: true });
    expect(isRepositoryEligible({ isPublic: true, isDuplicate: false, currentCount: 50 })).toEqual({ eligible: false, reason: 'limit_reached' });
    expect(isRepositoryEligible({ isPublic: false, isDuplicate: false, currentCount: 0 })).toEqual({ eligible: false, reason: 'private' });
  });
  it('判断 60 秒刷新窗口', () => {
    expect(isWithinRefreshWindow('2026-01-01T00:00:00Z', '2026-01-01T00:00:59Z')).toBe(true);
    expect(isRefreshDue(null, '2026-01-01T00:00:00Z')).toBe(true);
    expect(isRefreshDue('2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')).toBe(true);
  });
  it('按代码和协作时间中较新者排序', () => {
    expect(latestActivity('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toBe('2026-01-02T00:00:00Z');
    expect(compareActivity({ code: '2026-01-01T00:00:00Z', collaboration: '2026-01-03T00:00:00Z' }, { code: '2026-01-02T00:00:00Z', collaboration: null })).toBeLessThan(0);
  });
  it('区分详情缓存策略', () => {
    expect(decideDetailCachePolicy(null, { releaseChanged: false, tagChanged: false, codeChanged: false, collaborationChanged: false, summaryChanged: false, force: false })).toBe('full');
    expect(decideDetailCachePolicy({ hasDetail: true }, { releaseChanged: false, tagChanged: false, codeChanged: false, collaborationChanged: false, summaryChanged: true, force: false })).toBe('reuse');
    expect(decideDetailCachePolicy({ hasDetail: true }, { releaseChanged: true, tagChanged: false, codeChanged: false, collaborationChanged: false, summaryChanged: false, force: false })).toBe('full');
  });
  it('将栏目响应归类为明确状态', () => {
    expect(classifyColumnResponse({ status: 200, value: [] })).toMatchObject({ status: 'empty' });
    expect(classifyColumnResponse({ status: 403, value: null })).toMatchObject({ status: 'forbidden' });
    expect(classifyColumnResponse({ status: 200, value: [{ id: 1 }] })).toMatchObject({ status: 'success' });
  });
  it('失败时区分保留旧资料和空状态', () => {
    expect(resolveFailureState(true)).toEqual('preserve_previous');
    expect(resolveFailureState(false)).toEqual('empty');
  });
  it('保留最近 30 个自然日且同日只保留最后一档', () => {
    const values = [
      { capturedAt: '2026-02-01T01:00:00Z', stars: 1, forks: 1 },
      { capturedAt: '2026-02-01T02:00:00Z', stars: 2, forks: 2 },
      { capturedAt: '2025-12-01T01:00:00Z', stars: 0, forks: 0 },
    ];
    expect(retainRecentSnapshots(values, '2026-02-01T03:00:00Z')).toEqual([{ capturedAt: '2026-02-01T02:00:00Z', stars: 2, forks: 2 }]);
  });
});
