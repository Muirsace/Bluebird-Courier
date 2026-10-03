import type { DetailValues } from '../../../../domain/types';
import type { HistoryPage } from '../contract';

export function paginateHistory(values: DetailValues, kind: 'commits' | 'issues' | 'pullRequests', cursor?: string): HistoryPage<unknown> {
  const items = values[kind];
  const start = cursor ? Number(cursor) : 0;
  const next = start + 30;
  return { items: items.slice(start, next), nextCursor: next < items.length ? String(next) : null, hasMore: next < items.length };
}
