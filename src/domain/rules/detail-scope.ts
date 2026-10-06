import type { ColumnName, DetailScope, RepoChangeSet } from '../types';

/** 栏目到同步范围的唯一映射；每个栏目恰好属于一个范围。 */
export const COLUMN_SCOPE: Readonly<Record<ColumnName, DetailScope>> = {
  overview: 'overview',
  releases: 'releases',
  tags: 'releases',
  commits: 'commits',
  issues: 'issuesAndPr',
  pullRequests: 'issuesAndPr',
  builds: 'builds',
  readme: 'readme',
  tree: 'tree',
};

/** 范围到栏目的反向映射（trends 无对应栏目）。 */
export const SCOPE_COLUMNS: Readonly<Partial<Record<DetailScope, readonly ColumnName[]>>> = {
  overview: ['overview'],
  releases: ['releases', 'tags'],
  commits: ['commits'],
  issuesAndPr: ['issues', 'pullRequests'],
  builds: ['builds'],
  readme: ['readme'],
  tree: ['tree'],
};

/** 范围展示顺序固定，比较与持久化结果不随插入顺序漂移。 */
export const SCOPE_ORDER: readonly DetailScope[] = ['overview', 'releases', 'commits', 'issuesAndPr', 'builds', 'readme', 'tree', 'trends'];

const REMOTE_SCOPES: readonly DetailScope[] = ['overview', 'releases', 'commits', 'issuesAndPr', 'builds', 'readme', 'tree'];

export function scopeOfColumn(column: ColumnName): DetailScope {
  return COLUMN_SCOPE[column];
}

type ChangeFlags = Pick<RepoChangeSet, 'headChanged' | 'releaseChanged' | 'tagChanged' | 'issuesChanged' | 'buildsChanged' | 'defaultBranchChanged'>;

/**
 * 变化影响的范围（固定顺序去重）。
 * 仅指标变化（Stars / Forks）不影响任何范围，返回空数组。
 * Tag 与发版共用 releases 范围（决策：发版与标签共用发版信号）。
 */
export function scopesAffectedByChange(change: ChangeFlags): DetailScope[] {
  if (change.defaultBranchChanged) return [...REMOTE_SCOPES];
  const affected = new Set<DetailScope>();
  if (change.headChanged) for (const scope of ['overview', 'commits', 'builds', 'readme', 'tree'] as const) affected.add(scope);
  if (change.releaseChanged) { affected.add('overview'); affected.add('releases'); }
  if (change.tagChanged) affected.add('releases');
  if (change.issuesChanged) { affected.add('issuesAndPr'); affected.add('overview'); }
  if (change.buildsChanged) { affected.add('builds'); affected.add('overview'); }
  return SCOPE_ORDER.filter((scope) => affected.has(scope));
}
