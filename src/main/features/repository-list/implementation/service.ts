import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Logger } from '../../../core/infra/logger';
import type { Glance } from '../../../../domain/types';
import type { RepositoryListService } from '../contract';
import { inspectRepositoryInput, createPendingRepository, addFetchedRepository } from './add-repository';
import { listRepositories, findRepositoryById, findRepositoryByFullName } from './list-repositories';
import { applyRepositoryGlance } from './refresh-batch';
import { markRepositoryFailure } from './retry-repository';
import { deleteRepository, clearRepositories } from './delete-repository';

export interface RepositoryListDependencies {
  db: LocalDatabase;
  clock: Clock;
  logger?: Logger;
}

export function createRepositoryListService({ db, clock, logger }: RepositoryListDependencies): RepositoryListService {
  logger?.info('仓库清单服务已创建');
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
  };
}
