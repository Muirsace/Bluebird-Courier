import { writeRepositoryGlance } from './repository-status';
import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Logger } from '../../../core/infra/logger';
import type { AccessContextPort, SummaryObservationPort } from '../../../../domain/ports';
import type { ContentVersion, Glance } from '../../../../domain/types';
import type { ObservedSummaryRecord, RepositoryListService } from '../contract';
import { inspectRepositoryInput, createPendingRepository, addFetchedRepository } from './add-repository';
import { listRepositories, findRepositoryById, findRepositoryByFullName } from './list-repositories';
import { applyRepositoryGlance, createObservationCheck } from './refresh-batch';
import { markRepositoryFailure } from './retry-repository';
import { deleteRepository, clearRepositories } from './delete-repository';
import { confirmObservationHandoff, nextObservationReplayPage, quarantineInvalidObservations, readPendingObservations, readRow, readStoredObservation, rowToGlance } from './repository-list-store';

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
  let observationListener: ((observation: ObservedSummaryRecord) => void) | undefined;
  const check = createObservationCheck({ db, clock, github, logger, accessContext, nextObservationId, onObserved: observation => observationListener?.(observation) });
  return {
    newObservationId: nextObservationId,
    onObservation: listener => { observationListener = listener; },
    nextObservationReplayPage: (limit, revision, repositoryId) => nextObservationReplayPage(db, Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 100, revision, repositoryId, clock.now().toISOString()),
    inspectInput: inspectRepositoryInput,
    list: (): Glance[] => listRepositories(db),
    findById: (id: number): Glance | null => findRepositoryById(db, id),
    findByFullName: (fullName: string): Glance | null => findRepositoryByFullName(db, fullName),
    createPending: (fullName: string): Glance => createPendingRepository(db, clock, fullName),
    applyGlance: (id, values) => applyRepositoryGlance(db, clock, id, values),
    applyObservedSummary: (id, values, observedAt, revision) => {
      if (accessContext.currentRevision() !== revision) return null;
      const row = readRow(db, id);
      if (!row || !Number.isFinite(Date.parse(observedAt)) || (row.fetched_at && Date.parse(row.fetched_at) > Date.parse(observedAt))) return null;
      writeRepositoryGlance(db, id, { ...values, collaborationAt: values.collaborationAt ?? row.collaboration_activity_at ?? null }, observedAt);
      return rowToGlance(readRow(db, id)!);
    },
    markFailure: (id, error) => markRepositoryFailure(db, clock, id, error),
    add: (values) => addFetchedRepository(db, clock, values),
    remove: (id) => deleteRepository(db, id),
    clear: () => db.transaction(() => { clearRepositories(db); db.prepare('DELETE FROM observation_replay_cursor').run(); })(),
    checkRepositories: (accessToken, accessContextRevision, origin) => check.checkRepositories(accessToken, accessContextRevision, origin),
    checkRepository: (repositoryId, accessToken, accessContextRevision) => check.checkRepository(repositoryId, accessToken, accessContextRevision),
    pendingObservations: (limit = 100, filter) => readPendingObservations(db, Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 100, filter ?? {}),
    quarantineInvalidObservations: (limit = 100, filter) => quarantineInvalidObservations(db, Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 100, filter ?? {}, clock.now().toISOString()),
    confirmObservationHandoff: (observationId) => confirmObservationHandoff(db, observationId, clock.now().toISOString()),
    findReference: (repositoryId) => {
      const row = readRow(db, repositoryId);
      if (!row) return null;
      const observation = readStoredObservation(row);
      const contentVersion: Partial<ContentVersion> = {};
      if (observation?.accessContextRevision === accessContext.currentRevision()) {
        for (const field of ['defaultBranch', 'headRevision', 'releaseRevision', 'tagRevision'] as const) {
          const signal = observation.signals[field];
          if (signal.state === 'known' && (signal.value === null || typeof signal.value === 'string')) contentVersion[field] = signal.value;
        }
      }
      return { id: row.id, fullName: row.full_name, defaultBranch: contentVersion.defaultBranch ?? null, contentVersion };
    },
  };
}
