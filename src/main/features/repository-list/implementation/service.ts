import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Logger } from '../../../core/infra/logger';
import type { AccessContextPort, SummaryObservationPort } from '../../../../domain/ports';
import type { Glance } from '../../../../domain/types';
import type { RepositoryListService } from '../contract';
import { inspectRepositoryInput, createPendingRepository, addFetchedRepository } from './add-repository';
import { listRepositories, findRepositoryById, findRepositoryByFullName } from './list-repositories';
import { applyRepositoryGlance, createObservationCheck } from './refresh-batch';
import { markRepositoryFailure } from './retry-repository';
import { deleteRepository, clearRepositories } from './delete-repository';
import { confirmObservationHandoff, readPendingObservations } from './repository-list-store';

export interface RepositoryListDependencies {
  db: LocalDatabase;
  clock: Clock;
  /** 归一化观察端口；由组合根注入（清单检查不直接抓取详情）。 */
  github: SummaryObservationPort;
  logger?: Logger;
  accessContext: AccessContextPort;
  nextObservationId: () => string;
}

export function createRepositoryListService({ db, clock, github, logger, accessContext, nextObservationId }: RepositoryListDependencies): RepositoryListService {
  logger?.info('仓库清单服务已创建');
  const check = createObservationCheck({ db, clock, github, logger, accessContext, nextObservationId });
  return {
    inspectInput: inspectRepositoryInput,
    list: (): Glance[] => listRepositories(db),
    findById: (id: number): Glance | null => findRepositoryById(db, id),
    findByFullName: (fullName: string): Glance | null => findRepositoryByFullName(db, fullName),
    createPending: (fullName: string): Glance => createPendingRepository(db, clock, fullName),
    applyGlance: (id, values) => applyRepositoryGlance(db, clock, id, values),
    markFailure: (id, error) => markRepositoryFailure(db, clock, id, error),
    add: (values) => addFetchedRepository(db, clock, values),
    remove: (id) => deleteRepository(db, id),
    clear: () => clearRepositories(db),
    checkRepositories: (accessToken, accessContextRevision, origin) => check.checkRepositories(accessToken, accessContextRevision, origin),
    checkRepository: (repositoryId, accessToken, accessContextRevision) => check.checkRepository(repositoryId, accessToken, accessContextRevision),
    pendingObservations: (limit = 100, filter) => readPendingObservations(db, Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 100, filter),
    confirmObservationHandoff: (observationId) => confirmObservationHandoff(db, observationId, clock.now().toISOString()),
  };
}
