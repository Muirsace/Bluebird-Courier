import type { BuildInfo, DetailValues, Glance, NormalizedError, Snapshot } from '../../../../domain/types';

export type ColumnName = 'overview' | 'releases' | 'tags' | 'commits' | 'issues' | 'pullRequests' | 'builds' | 'readme' | 'tree';
export type ColumnStatus = 'loading' | 'success' | 'empty' | 'forbidden' | 'failed' | 'unsupported';

export interface ColumnResult<T = unknown> {
  status: ColumnStatus;
  value: T | null;
  error: NormalizedError | null;
  hasMore?: boolean;
  cursor?: string | null;
}

export interface DetailCache {
  repositoryId: number;
  fullName: string;
  values: DetailValues;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  fetchedAt: string;
  source: 'fresh' | 'cache';
}

export interface DetailResult {
  repository: Glance;
  values: DetailValues;
  columns: Partial<Record<ColumnName, ColumnResult>>;
  cached: boolean;
  stale: boolean;
  error: NormalizedError | null;
}

export interface HistoryPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface RepositoryDetailService {
  getCached(repositoryId: number): DetailCache | null;
  open(repositoryId: number, token: string, force?: boolean): Promise<DetailResult>;
  refresh(repositoryId: number, token: string): Promise<DetailResult>;
  loadHistory(repositoryId: number, token: string, kind: 'commits' | 'issues' | 'pullRequests', cursor?: string): Promise<HistoryPage<unknown>>;
  remove(repositoryId: number): void;
  clear(): void;
}

export type { BuildInfo, DetailValues, Glance, Snapshot };
