import { describe, expect, it } from 'vitest';
import { isRepositoryEligible } from '../../src/domain/rules/repository-eligibility';
import { isRefreshDue, isVerificationExpired, isWithinRefreshWindow } from '../../src/domain/rules/refresh-window';
import { compareActivity, compareResolvedActivity, latestActivity, resolveActivity } from '../../src/domain/rules/activity-sort';
import { decideCacheDisplay, decideDetailCachePolicy, decideVerification } from '../../src/domain/rules/detail-cache-policy';
import { classifyColumnResponse } from '../../src/domain/rules/column-state';
import { resolveFailureState } from '../../src/domain/rules/failure-state';
import { retainRecentSnapshots } from '../../src/domain/rules/snapshot-retention';
import { detectChanges, hasContentChanges, isComparableObservation, isCosmeticOnly } from '../../src/domain/rules/change-detection';
import { COLUMN_SCOPE, scopesAffectedByChange, scopeOfColumn } from '../../src/domain/rules/detail-scope';
import { canCommitTaskResult, confirmSynced, deriveFreshness, deriveUnseen, hasUnsyncedChanges, recordObservation } from '../../src/domain/rules/scope-ledger';
import { BUILD_SCOPE_GROUP, hasOnlyBuildChanges, isBuildScopeSet, planSync } from '../../src/domain/rules/sync-plan';
import type { CheckedSignal, DetailScope, RepoChangeSet, RepositoryObservation, TaskContext } from '../../src/domain/types';

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

// —— 步骤 1 仓库同步规则 ——

function known<T>(value: T | null, checkedAt = '2026-10-06T08:00:00Z'): CheckedSignal<T> {
  return { state: 'known', value, checkedAt };
}

function makeObservation(options: {
  stars?: number;
  forks?: number;
  head?: string | null;
  release?: string | null;
  tag?: string | null;
  defaultBranch?: string | null;
  headState?: 'known' | 'unknown';
  releaseState?: 'known' | 'unknown';
  tagState?: 'known' | 'unknown';
  observedAt?: string;
} = {}): RepositoryObservation {
  return {
    repoId: 1,
    fullName: 'octo/demo',
    observedAt: options.observedAt ?? '2026-10-06T08:00:00Z',
    accessContextRevision: 1,
    values: { stars: options.stars ?? 100, forks: options.forks ?? 10, openIssues: 1, pushedAt: null, latestReleaseTag: null, latestTag: null, collaborationAt: null, status: 'active' },
    signals: {
      defaultBranch: known(options.defaultBranch === undefined ? 'main' : options.defaultBranch),
      headRevision: options.headState === 'unknown' ? { state: 'unknown' } : known(options.head === undefined ? 'aaa111' : options.head),
      releaseRevision: options.releaseState === 'unknown' ? { state: 'unknown' } : known(options.release === undefined ? 'v1' : options.release),
      tagRevision: options.tagState === 'unknown' ? { state: 'unknown' } : known(options.tag === undefined ? null : options.tag),
    },
    activity: {
      code: { kind: 'code', at: null, important: true },
      release: { kind: 'release', at: null, important: true },
      collaboration: { kind: 'issue', at: null, important: true },
    },
  };
}

function plan(overrides: Partial<Parameters<typeof planSync>[0]> = {}): ReturnType<typeof planSync> {
  return planSync({ intent: 'open', cacheStatus: 'valid', changeSet: null, dirtyScopes: [], expiredScopes: [], ...overrides });
}

function buildsOnlyChange(): RepoChangeSet {
  const change = detectChanges(makeObservation(), makeObservation());
  change.buildsChanged = true;
  change.affectedScopes = scopesAffectedByChange(change);
  return change;
}

describe('仓库同步规则（步骤 1）', () => {
  it('仅指标变化只更新摘要，不影响任何范围', () => {
    const change = detectChanges(makeObservation({ stars: 100, forks: 10 }), makeObservation({ stars: 103, forks: 11 }));
    expect(change).toMatchObject({ starsChanged: true, forksChanged: true, headChanged: false, affectedScopes: [] });
    expect(hasContentChanges(change)).toBe(false);
    expect(isCosmeticOnly(change)).toBe(true);
    expect(plan({ changeSet: change })).toBe('update-summary-only');
  });

  it('重复观察同一状态不递增序号，也不产生新变化', () => {
    const change = detectChanges(makeObservation(), makeObservation());
    expect(change).toMatchObject({ starsChanged: false, headChanged: false, releaseChanged: false, tagChanged: false, affectedScopes: [] });
    const ledger = { detectedRevision: 2, syncedRevision: 2, dirtyReasons: [] };
    expect(recordObservation(ledger, false, 'head')).toEqual(ledger);
    expect(hasUnsyncedChanges(ledger)).toBe(false);
    expect(plan({ changeSet: change })).toBe('reuse-cache');
  });

  it('旧 dirty 保留：本次无新变化也不清掉未同步标记', () => {
    const ledger = { detectedRevision: 3, syncedRevision: 1, dirtyReasons: ['head'] };
    expect(hasUnsyncedChanges(ledger)).toBe(true);
    expect(plan({ intent: 'check', dirtyScopes: ['commits'] })).toBe('reuse-cache');
    expect(deriveFreshness(ledger, true)).toBe('stale');
    expect(plan({ dirtyScopes: ['commits'], expiredScopes: ['commits'] })).toBe('background-full-fetch');
  });

  it('验证 TTL 过期驱动验证，不删除缓存', () => {
    expect(isVerificationExpired(null, '2026-10-06T08:00:00Z', 30 * 60_000)).toBe(true);
    expect(isVerificationExpired('2026-10-06T07:50:00Z', '2026-10-06T08:00:00Z', 30 * 60_000)).toBe(false);
    expect(isVerificationExpired('2026-10-06T07:00:00Z', '2026-10-06T08:00:00Z', 30 * 60_000)).toBe(true);

    const base = { lastCheckedAt: '2026-10-06T07:50:00Z', now: '2026-10-06T08:00:00Z', ttlMs: 30 * 60_000, defaultBranchChanged: false, contextChanged: false };
    expect(decideVerification({ ...base, cacheStatus: 'valid', freshness: 'fresh' })).toBe('skip');
    expect(decideVerification({ ...base, lastCheckedAt: '2026-10-06T07:00:00Z', cacheStatus: 'valid', freshness: 'fresh' })).toBe('verify');
    expect(decideVerification({ ...base, cacheStatus: 'valid', freshness: 'unknown' })).toBe('verify');
    expect(decideVerification({ ...base, cacheStatus: 'valid', freshness: 'stale' })).toBe('skip');
    expect(decideVerification({ ...base, cacheStatus: 'valid', freshness: 'fresh', contextChanged: true })).toBe('rebuild');
    expect(decideVerification({ ...base, cacheStatus: 'missing', freshness: 'unknown' })).toBe('rebuild');

    expect(decideCacheDisplay({ hasDetail: true, cacheStatus: 'valid' })).toBe('show-cached');
    expect(decideCacheDisplay({ hasDetail: true, cacheStatus: 'missing' })).toBe('show-empty');
    expect(plan({ expiredScopes: ['overview'] })).toBe('revalidate-scopes');
  });

  it('部分范围确认只推进覆盖到的序号', () => {
    const ledger = { detectedRevision: 5, syncedRevision: 0, dirtyReasons: ['head', 'release'] };
    const confirmed = confirmSynced(ledger, { targetRevision: 5, covered: true });
    expect(confirmed.syncedRevision).toBe(5);
    expect(confirmed.dirtyReasons).toEqual([]);
    expect(hasUnsyncedChanges(confirmed)).toBe(false);
    expect(confirmSynced(ledger, { targetRevision: 5, covered: false })).toEqual(ledger);
  });

  it('同步中新增变化：只确认目标版本，新变化继续待同步', () => {
    let ledger = { detectedRevision: 5, syncedRevision: 0, dirtyReasons: ['head'] };
    ledger = recordObservation(ledger, true, 'release');
    expect(ledger.detectedRevision).toBe(6);
    const confirmed = confirmSynced(ledger, { targetRevision: 5, covered: true });
    expect(confirmed.syncedRevision).toBe(5);
    expect(hasUnsyncedChanges(confirmed)).toBe(true);
    expect(confirmed.dirtyReasons).toEqual(['head', 'release']);
    expect(deriveFreshness(confirmed, true)).toBe('stale');
  });

  it('写入保护：仓库不存在、上下文变化或更晚任务都不落库', () => {
    const task: TaskContext = {
      taskId: 't1',
      repoId: 1,
      kind: 'open',
      targets: { overview: { targetRevision: 5, baselineFingerprint: 'fp-overview' } },
      accessContextRevision: 2,
      taskVersion: 7,
      startedAt: '2026-10-06T08:00:00Z',
    };
    expect(canCommitTaskResult(task, { repositoryExists: true, accessContextRevision: 2, latestTaskVersion: 7 })).toBe(true);
    expect(canCommitTaskResult(task, { repositoryExists: false, accessContextRevision: 2, latestTaskVersion: 7 })).toBe(false);
    expect(canCommitTaskResult(task, { repositoryExists: true, accessContextRevision: 3, latestTaskVersion: 7 })).toBe(false);
    expect(canCommitTaskResult(task, { repositoryExists: true, accessContextRevision: 2, latestTaskVersion: 8 })).toBe(false);
    expect(deriveUnseen(5, 4)).toBe(true);
    expect(deriveUnseen(5, 5)).toBe(false);
  });

  it('known-null 与 unknown 不混为同一个缺失值', () => {
    const previous = makeObservation({ release: 'v1' });
    expect(detectChanges(previous, makeObservation({ release: null })).releaseChanged).toBe(true);
    expect(detectChanges(previous, makeObservation({ releaseState: 'unknown' })).releaseChanged).toBe(false);
    expect(detectChanges(makeObservation({ headState: 'unknown' }), makeObservation({ head: 'bbb222' })).headChanged).toBe(false);
    expect(previous.signals.releaseRevision).toEqual({ state: 'known', value: 'v1', checkedAt: '2026-10-06T08:00:00Z' });
  });

  it('观察比较隔离仓库与访问上下文', () => {
    const previous = makeObservation({ stars: 100, head: 'aaa111' });
    const otherRepo: RepositoryObservation = { ...makeObservation({ stars: 999, head: 'zzz999' }), repoId: 2 };
    const otherContext: RepositoryObservation = { ...makeObservation({ stars: 999, head: 'zzz999' }), accessContextRevision: 2 };
    expect(isComparableObservation(previous, otherRepo)).toBe(false);
    expect(isComparableObservation(previous, otherContext)).toBe(false);
    expect(detectChanges(previous, otherRepo)).toMatchObject({ starsChanged: false, headChanged: false, affectedScopes: [] });
    expect(detectChanges(previous, otherContext)).toMatchObject({ starsChanged: false, headChanged: false, affectedScopes: [] });
    expect(isComparableObservation(previous, makeObservation({ stars: 999 }))).toBe(true);
    expect(detectChanges(previous, makeObservation({ stars: 999 })).starsChanged).toBe(true);
  });

  it('Tag 信号参与比较并映射到发版范围', () => {
    const change = detectChanges(makeObservation({ tag: 'v1' }), makeObservation({ tag: 'v2' }));
    expect(change.tagChanged).toBe(true);
    expect(change.affectedScopes).toEqual(['releases']);
    expect(detectChanges(makeObservation({ tag: 'v1' }), makeObservation({ tag: null })).tagChanged).toBe(true);
    expect(detectChanges(makeObservation({ tag: 'v1' }), makeObservation({ tagState: 'unknown' })).tagChanged).toBe(false);
    expect(detectChanges(makeObservation({ tag: null }), makeObservation({ tag: null })).tagChanged).toBe(false);
  });

  it('HEAD / Release / Tag / 分支与构建变化映射到对应范围', () => {
    expect(scopeOfColumn('tags')).toBe('releases');
    expect(COLUMN_SCOPE).toEqual({
      overview: 'overview',
      releases: 'releases',
      tags: 'releases',
      commits: 'commits',
      issues: 'issuesAndPr',
      pullRequests: 'issuesAndPr',
      builds: 'builds',
      readme: 'readme',
      tree: 'tree',
    });

    const headChange = detectChanges(makeObservation(), makeObservation({ head: 'bbb222' }));
    expect(headChange.affectedScopes).toEqual(['overview', 'commits', 'builds', 'readme', 'tree']);
    const releaseChange = detectChanges(makeObservation(), makeObservation({ release: 'v2' }));
    expect(releaseChange.affectedScopes).toEqual(['overview', 'releases']);
    const branchChange = detectChanges(makeObservation(), makeObservation({ defaultBranch: 'trunk' }));
    expect(branchChange.affectedScopes).toEqual(['overview', 'releases', 'commits', 'issuesAndPr', 'builds', 'readme', 'tree']);
    expect(scopesAffectedByChange({ headChanged: false, releaseChanged: false, tagChanged: false, issuesChanged: false, buildsChanged: false, defaultBranchChanged: false })).toEqual([]);

    expect(plan({ intent: 'check', changeSet: releaseChange })).toBe('mark-scopes-stale');
    expect(plan({ changeSet: releaseChange })).toBe('background-full-fetch');
    expect(plan({ intent: 'force' })).toBe('force-full-fetch');
    expect(plan({ cacheStatus: 'missing' })).toBe('background-full-fetch');
  });

  it('检查意图从不触发完整抓取', () => {
    const contentChange = detectChanges(makeObservation(), makeObservation({ head: 'bbb222' }));
    expect(plan({ intent: 'check', cacheStatus: 'missing' })).toBe('reuse-cache');
    expect(plan({ intent: 'check', cacheStatus: 'invalid', dirtyScopes: ['releases'] })).toBe('reuse-cache');
    expect(plan({ intent: 'check', changeSet: contentChange })).toBe('mark-scopes-stale');
    expect(plan({ intent: 'check', expiredScopes: ['overview'] })).toBe('revalidate-scopes');

    const forbidden: ReturnType<typeof planSync>[] = ['background-full-fetch', 'background-scope-fetch', 'force-full-fetch'];
    const dirtyVariants: DetailScope[][] = [[], ['commits'], ['builds']];
    const expiredVariants: DetailScope[][] = [[], ['overview']];
    for (const cacheStatus of ['missing', 'invalid', 'valid'] as const) {
      for (const changeSet of [null, contentChange, buildsOnlyChange()]) {
        for (const dirtyScopes of dirtyVariants) {
          for (const expiredScopes of expiredVariants) {
            const decision = plan({ intent: 'check', cacheStatus, changeSet, dirtyScopes, expiredScopes });
            expect(forbidden, `check 不应整抓：${cacheStatus}/${dirtyScopes.join('+')}/${expiredScopes.join('+')}`).not.toContain(decision);
          }
        }
      }
    }
  });

  it('同步计划综合新变化、旧 dirty 与过期范围', () => {
    expect(isBuildScopeSet([])).toBe(false);
    expect(isBuildScopeSet(['builds'])).toBe(true);
    expect(isBuildScopeSet(['overview', 'builds'])).toBe(true);
    expect(isBuildScopeSet(['overview'])).toBe(false);
    expect(isBuildScopeSet(['commits', 'builds'])).toBe(false);
    expect(BUILD_SCOPE_GROUP).toEqual(['overview', 'builds']);

    // 构建新变化 + 提交旧 dirty：非构建的未同步工作仍在，第一阶段走完整同步
    expect(plan({ changeSet: buildsOnlyChange(), dirtyScopes: ['commits'] })).toBe('background-full-fetch');
    expect(plan({ intent: 'check', changeSet: buildsOnlyChange(), dirtyScopes: ['commits'] })).toBe('mark-scopes-stale');
    // 全部未同步工作都落在构建范围组内：独立范围更新
    expect(plan({ changeSet: buildsOnlyChange() })).toBe('background-scope-fetch');
    expect(plan({ changeSet: buildsOnlyChange(), dirtyScopes: ['builds'] })).toBe('background-scope-fetch');
    // 仅构建旧 dirty：同样不整抓
    expect(plan({ dirtyScopes: ['builds'] })).toBe('background-scope-fetch');
    expect(plan({ dirtyScopes: ['commits', 'builds'] })).toBe('background-full-fetch');
    // 指标变化 + 验证过期：过期验证优先于纯指标更新
    const cosmetic = detectChanges(makeObservation({ stars: 100 }), makeObservation({ stars: 130 }));
    expect(plan({ changeSet: cosmetic, expiredScopes: ['issuesAndPr'] })).toBe('revalidate-scopes');
    expect(plan({ changeSet: cosmetic })).toBe('update-summary-only');
  });

  it('构建变化映射与独立更新判定一致：真实映射的 dirty 再次打开仍走范围更新', () => {
    const change = buildsOnlyChange();
    expect(hasOnlyBuildChanges(change)).toBe(true);
    // 真实范围映射：构建变化影响 overview（使用构建字段的展示）与 builds
    expect(change.affectedScopes).toEqual(['overview', 'builds']);

    // 把映射结果原样作为下次打开的 dirty：判定必须与产生它的决策一致
    const dirtyReasonsByScope = { overview: ['build'], builds: ['build'] };
    expect(plan({ dirtyScopes: change.affectedScopes, dirtyReasonsByScope })).toBe('background-scope-fetch');
    expect(plan({ changeSet: change, dirtyScopes: change.affectedScopes, dirtyReasonsByScope })).toBe('background-scope-fetch');
  });

  it('overview 存在其他 dirty 原因时不误判为构建组', () => {
    // overview 不带 builds：可能来自发表/Issue 等变化，保守走完整同步
    expect(plan({ dirtyScopes: ['overview'] })).toBe('background-full-fetch');
    expect(plan({ dirtyScopes: ['overview', 'releases'] })).toBe('background-full-fetch');
    expect(plan({ dirtyScopes: ['overview', 'issuesAndPr'] })).toBe('background-full-fetch');
    // 构建新变化叠加组外的 overview/releases dirty：同样整抓，不被"仅构建"吞掉
    expect(plan({ changeSet: buildsOnlyChange(), dirtyScopes: ['overview', 'releases'] })).toBe('background-full-fetch');
    // 单独的 overview（没有 builds）不属于构建组：可能来自其他变化原因，保守整抓
    expect(plan({ changeSet: buildsOnlyChange(), dirtyScopes: ['overview'] })).toBe('background-full-fetch');
  });

  it('构建范围组保留 overview 的非构建变化，缺少原因时保守完整同步', () => {
    const dirtyScopes: DetailScope[] = ['overview', 'builds'];
    for (const overview of [['build', 'release'], ['issue'], ['head'], []]) {
      const dirtyReasonsByScope = { overview, builds: ['build'] };
      expect(plan({ dirtyScopes, dirtyReasonsByScope })).toBe('background-full-fetch');
      expect(plan({ changeSet: buildsOnlyChange(), dirtyScopes, dirtyReasonsByScope })).toBe('background-full-fetch');
    }
    expect(plan({ dirtyScopes })).toBe('background-full-fetch');
    expect(plan({ changeSet: buildsOnlyChange(), dirtyScopes })).toBe('background-full-fetch');
  });

  it('不同范围序号各自确认，任务按范围记录目标与覆盖基线', () => {
    const overview = { detectedRevision: 5, syncedRevision: 5, dirtyReasons: [] as string[] };
    const commits = { detectedRevision: 6, syncedRevision: 4, dirtyReasons: ['head'] };
    expect(hasUnsyncedChanges(overview)).toBe(false);
    expect(hasUnsyncedChanges(commits)).toBe(true);

    const confirmed = confirmSynced(commits, { targetRevision: 5, covered: true });
    expect(confirmed.syncedRevision).toBe(5);
    expect(hasUnsyncedChanges(confirmed)).toBe(true);
    expect(confirmSynced(confirmed, { targetRevision: 5, covered: true })).toEqual(confirmed);

    const task: TaskContext = {
      taskId: 't2',
      repoId: 1,
      kind: 'scope',
      targets: {
        commits: { targetRevision: 5, baselineFingerprint: 'fp-commits' },
        builds: { targetRevision: 2, baselineFingerprint: null },
      },
      accessContextRevision: 2,
      taskVersion: 3,
      startedAt: '2026-10-06T08:00:00Z',
    };
    expect(task.targets.commits).toEqual({ targetRevision: 5, baselineFingerprint: 'fp-commits' });
    expect(task.targets.builds?.baselineFingerprint).toBeNull();
    expect(canCommitTaskResult(task, { repositoryExists: true, accessContextRevision: 2, latestTaskVersion: 3 })).toBe(true);
    expect(canCommitTaskResult(task, { repositoryExists: true, accessContextRevision: 3, latestTaskVersion: 3 })).toBe(false);
    expect(canCommitTaskResult(task, { repositoryExists: true, accessContextRevision: 2, latestTaskVersion: 4 })).toBe(false);
  });

  it('活动时间由候选聚合，显示与排序使用同一结果', () => {
    const now = '2026-10-06T12:00:00Z';
    const resolved = resolveActivity([
      { kind: 'code', at: '2026-10-06T10:00:00Z', important: true },
      { kind: 'issue', at: '2026-10-06T11:30:00Z', important: true },
      { kind: 'release', at: '2026-10-06T09:00:00Z', important: true },
    ], now);
    expect(resolved).toEqual({ at: '2026-10-06T11:30:00Z', kind: 'issue' });

    const tied = resolveActivity([
      { kind: 'code', at: '2026-10-06T10:00:00Z', important: true },
      { kind: 'release', at: '2026-10-06T10:00:00Z', important: true },
    ], now);
    expect(tied).toEqual({ at: '2026-10-06T10:00:00Z', kind: 'release' });

    expect(resolveActivity([{ kind: 'code', at: '2026-10-06T10:00:00Z', important: false }], now)).toEqual({ at: null, kind: null });
    expect(resolveActivity([{ kind: 'code', at: '不是时间', important: true }], now)).toEqual({ at: null, kind: null });
    expect(resolveActivity([{ kind: 'code', at: '2026-10-07T00:00:00Z', important: true }], now)).toEqual({ at: null, kind: null });
    expect(resolveActivity([], now)).toEqual({ at: null, kind: null });

    const older = resolveActivity([{ kind: 'code', at: '2026-10-06T08:00:00Z', important: true }], now);
    const none = resolveActivity([], now);
    expect(compareResolvedActivity(resolved, older)).toBeLessThan(0);
    expect(compareResolvedActivity(older, none)).toBeLessThan(0);
    expect(compareResolvedActivity(none, older)).toBeGreaterThan(0);
  });
});
