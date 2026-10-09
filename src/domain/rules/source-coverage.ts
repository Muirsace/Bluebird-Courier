import type { ContentVersion, DetailScope } from '../types';

const SOURCE_FIELDS: Partial<Record<DetailScope, readonly (keyof ContentVersion)[]>> = {
  overview: ['defaultBranch', 'headRevision', 'releaseRevision', 'tagRevision'],
  commits: ['defaultBranch', 'headRevision'],
  readme: ['defaultBranch', 'headRevision'],
  releases: ['releaseRevision', 'tagRevision'],
};

/** 源版本只按相等核验；SHA与供应商版本不具有可推断的先后顺序。 */
export function coversSourceTarget(scope: DetailScope, target: Partial<ContentVersion> | undefined,
  actual: Partial<ContentVersion> | undefined, knownDirty: boolean, fields = SOURCE_FIELDS[scope] ?? []): boolean {
  if (fields.length === 0) return true;
  // 仅在没有已知变化或源目标时兼容旧端口；首次同步的可信目标也不能缺少实际证据。
  if (actual === undefined) return !knownDirty && fields.every(field => target?.[field] === undefined);
  return (!knownDirty || fields.every(field => actual[field] !== undefined)) && fields.every(field => target?.[field] === undefined ||
    (actual[field] !== undefined && actual[field] === target[field]));
}
