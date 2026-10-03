import type { SnapshotTrendService } from '../contract';
import { createSnapshotTrendService, type SnapshotTrendDependencies } from './service';

export function createSnapshotTrend(dependencies: SnapshotTrendDependencies): SnapshotTrendService {
  return createSnapshotTrendService(dependencies);
}
