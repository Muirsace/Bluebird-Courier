import type { Glance } from '../../../../domain/types';
import type { DetailCache, DetailResult } from '../contract';

export function openCachedDetail(repository: Glance, cached: DetailCache): DetailResult {
  return { repository, values: cached.values, columns: cached.columns, cached: true, stale: false, error: null };
}

export function openStaleDetail(repository: Glance, cached: DetailCache, message: string): DetailResult {
  return { repository, values: cached.values, columns: cached.columns, cached: true, stale: true, error: { kind: 'unknown', message, fullName: repository.fullName } };
}
