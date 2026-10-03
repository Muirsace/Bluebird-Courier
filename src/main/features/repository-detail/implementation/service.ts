import type { GitHubPort } from '../../../../domain/ports';
import type { Glance } from '../../../../domain/types';
import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { RepositoryDetailService, DetailResult, ColumnName, DetailCache } from '../contract';
import { clearDetails, deleteDetail, readDetail } from './detail-store';
import { openCachedDetail, openStaleDetail } from './open-detail';
import { refreshDetail } from './refresh-detail';
import { paginateHistory } from './history-pagination';

export interface RepositoryDetailDependencies {
  db: LocalDatabase;
  github: GitHubPort;
  clock: Clock;
  repositoryById(id: number): Glance | null;
}

export function createRepositoryDetailService({ db, github, clock, repositoryById }: RepositoryDetailDependencies): RepositoryDetailService {
  const getCached = (repositoryId: number): DetailCache | null => readDetail(db, repositoryId);

  async function load(repositoryId: number, token: string, force: boolean): Promise<DetailResult> {
    const repository = repositoryById(repositoryId);
    if (!repository) throw new Error(`监控仓库不存在：${repositoryId}`);
    const cached = getCached(repositoryId);
    if (cached && !force) return openCachedDetail(repository, cached);
    try {
      return await refreshDetail(db, github, clock, repository, token);
    } catch (error) {
      if (cached) return openStaleDetail(repository, cached, error instanceof Error ? error.message : '详情抓取失败');
      throw error;
    }
  }

  return {
    getCached,
    open: (repositoryId, token, force = false) => load(repositoryId, token, force),
    refresh: (repositoryId, token) => load(repositoryId, token, true),
    async loadHistory(repositoryId, token, kind, cursor) {
      const repository = repositoryById(repositoryId);
      if (!repository) throw new Error(`监控仓库不存在：${repositoryId}`);
      const result = await load(repositoryId, token, false);
      return paginateHistory(result.values, kind, cursor);
    },
    remove: (repositoryId) => deleteDetail(db, repositoryId),
    clear: () => clearDetails(db),
  };
}

export type DetailColumn = ColumnName;
