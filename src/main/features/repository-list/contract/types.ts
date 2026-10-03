import type { Glance, GlanceValues, RepoInputResult, NormalizedError, FetchedGlance } from '../../../../domain/types';

export interface AddRepositoryInput {
  fullName: string;
  token: string;
}

export interface AddRepositoryResult {
  ok: boolean;
  repository: Glance | null;
  error: NormalizedError | null;
}

export interface RefreshRepositoryResult {
  repository: Glance;
  error: NormalizedError | null;
}

export interface RefreshBatchResult {
  repositories: Glance[];
  errors: NormalizedError[];
  stopped: boolean;
  nextCursor: number | null;
}

export type RepositoryListFailureSource = 'input' | 'fetch' | 'persistence' | 'batch';

export interface RepositoryListService {
  inspectInput(input: unknown): RepoInputResult;
  list(): Glance[];
  findById(id: number): Glance | null;
  findByFullName(fullName: string): Glance | null;
  createPending(fullName: string): Glance;
  applyGlance(id: number, values: GlanceValues): Glance;
  markFailure(id: number, error: NormalizedError): Glance;
  add(values: FetchedGlance): Glance;
  remove(id: unknown): { removed: boolean; fullName?: string };
  clear(): void;
}
