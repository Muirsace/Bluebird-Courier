import type { GlanceValues, Snapshot } from '../../../../domain/types';

export interface TrendPoint {
  capturedAt: string;
  stars: number | null;
  forks: number | null;
}

export interface SnapshotTrendService {
  record(repositoryId: number, values: GlanceValues, capturedAt?: Date): void;
  retain(repositoryId?: number, now?: Date): void;
  trend(repositoryId: number): TrendPoint[];
  listSnapshots(repositoryId: number): Snapshot[];
  remove(repositoryId: number): void;
  clear(): void;
}
