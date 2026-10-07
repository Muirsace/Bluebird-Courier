import type { GitHubPort } from '../../../../domain/ports';
import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { DetailValues, Glance } from '../../../../domain/types';
import type { DetailCache, DetailResult } from '../contract';
import { aggregateColumns } from './column-aggregator';
import { loadDetailColumns } from './column-loader';
import { writeDetail } from './detail-store';

export async function refreshDetail(db: LocalDatabase, github: GitHubPort, clock: Clock, repository: Glance, token: string, accessContextRevision: number): Promise<DetailResult> {
  const loaded = await loadDetailColumns(github, token, repository.fullName);
  const values: DetailValues = loaded;
  const columns = aggregateColumns({ overview: repository, releases: loaded.releases, tags: loaded.tags ?? null, commits: loaded.commits, issues: loaded.issues, pullRequests: loaded.pullRequests, builds: loaded.builds ?? (loaded.build ? [loaded.build] : []), readme: loaded.readmes ?? null, tree: loaded.tree ?? null });
  const nextCache: DetailCache = { repositoryId: repository.id, fullName: repository.fullName, values, columns, fetchedAt: clock.now().toISOString(), source: 'fresh' };
  writeDetail(db, nextCache, accessContextRevision);
  return { repository, values, columns, cached: false, stale: false, error: null };
}
