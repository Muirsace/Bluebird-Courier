import type { AccessContextPort, GitHubPort } from '../../../../domain/ports';
import type { DetailScope, Glance, ObservationHandoff, ScopeSyncState } from '../../../../domain/types';
import type { Clock } from '../../../core/infra/clock';
import type { LocalDatabase } from '../../../core/infra/database';
import type {
  ColumnName,
  DetailCache,
  DetailResult,
  LocalDetailView,
  LocalReadRequest,
  ObservationApplyOutcome,
  RepositoryDetailService,
} from '../contract';
import { applyScopeObservation, initialScopeState, observationReasons } from '../../../../domain/rules/observation-application';
import { SCOPE_ORDER } from '../../../../domain/rules/detail-scope';
import { hasReadableDetail, readLocalColumns, readLocalScopePage } from './local-detail-store';
import {
  DETAIL_CACHE_SCHEMA_VERSION,
  bumpViewVersion,
  clearDetails,
  deleteDetail,
  hasObservationApply,
  insertObservationApply,
  readDetail,
  readDetailMeta,
  readScopeState,
  readScopeStates,
  readViewVersion,
  writeScopeState,
} from './detail-store';
import { buildLocalView, openCachedDetail, openStaleDetail } from './open-detail';
import { refreshDetail } from './refresh-detail';
import { paginateHistory } from './history-pagination';

export interface RepositoryDetailDependencies {
  db: LocalDatabase;
  github: GitHubPort;
  clock: Clock;
  repositoryById(id: number): Glance | null;
  /** 当前访问上下文；读取与写入前实时读取，跨上下文观察不改动账本。 */
  accessContext: AccessContextPort;
}

export function createRepositoryDetailService({ db, github, clock, repositoryById, accessContext }: RepositoryDetailDependencies): RepositoryDetailService {
  const getCached = (repositoryId: number): DetailCache | null => readDetail(db, repositoryId);

  async function load(repositoryId: number, token: string, force: boolean): Promise<DetailResult> {
    const repository = repositoryById(repositoryId);
    if (!repository) throw new Error(`监控仓库不存在：${repositoryId}`);
    const cached = getCached(repositoryId);
    if (cached && !force) return openCachedDetail(repository, cached);
    try {
      return await refreshDetail(db, github, clock, repository, token, accessContext.currentRevision());
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

    readLocal(repositoryId: number, request: LocalReadRequest = {}): LocalDetailView | null {
      const repository = repositoryById(repositoryId);
      if (!repository) return null;
      const current = accessContext.currentRevision();
      const cacheMeta = readDetailMeta(db, repositoryId);
      const mode = request.mode === 'status' ? 'status' : 'view';
      const validMeta = cacheMeta?.schemaVersion === DETAIL_CACHE_SCHEMA_VERSION && cacheMeta.accessContextRevision === current;
      const corrupted = mode === 'view' && validMeta && !hasReadableDetail(db, repositoryId);
      return buildLocalView(repository, {
        cacheMeta, corrupted, currentAccessContextRevision: current,
        scopeStates: readScopeStates(db, repositoryId, current),
        viewVersion: readViewVersion(db, repositoryId),
        columns: validMeta ? readLocalColumns(db, repositoryId) : {},
        readScope: (scope, offset, limit) => readLocalScopePage(db, repositoryId, scope, offset, limit),
      }, request);
    },

    applyObservation(handoff: ObservationHandoff, appliedAt: string): ObservationApplyOutcome {
      if (!repositoryById(handoff.repoId)) return { applied: false, duplicate: false, affectedScopes: [] };
      const current = accessContext.currentRevision();
      // 跨访问上下文观察不得修改当前账本。
      if (handoff.accessContextRevision !== current) return { applied: false, duplicate: false, affectedScopes: [] };
      // 幂等：同一 observationId 重放不再重复递增序号。
      if (hasObservationApply(db, handoff.repoId, handoff.observationId)) return { applied: false, duplicate: true, affectedScopes: [] };

      if (handoff.changeSet.repoId !== handoff.repoId) return { applied: false, duplicate: false, affectedScopes: [] };
      const scopes = SCOPE_ORDER.filter(scope => handoff.changeSet.affectedScopes.includes(scope));
      const write = db.transaction(() => {
        const cacheMeta = readDetailMeta(db, handoff.repoId);
        for (const scope of scopes) {
          const existing = readScopeState(db, handoff.repoId, scope, current);
          const status = cacheMeta === null ? 'missing' : cacheMeta.schemaVersion === DETAIL_CACHE_SCHEMA_VERSION && cacheMeta.accessContextRevision === current ? 'valid' : 'invalid';
          const base = existing ?? initialScopeState(status);
          writeScopeState(db, handoff.repoId, scope, applyScopeObservation(base, observationReasons(scope, handoff.changeSet)), current);
        }
        insertObservationApply(db, {
          observationId: handoff.observationId,
          repositoryId: handoff.repoId,
          appliedAt,
          accessContextRevision: current,
          affectedScopes: scopes,
        });
        bumpViewVersion(db, handoff.repoId, appliedAt);
      });
      write();
      return { applied: true, duplicate: false, affectedScopes: [...scopes] };
    },
  };
}

export type DetailColumn = ColumnName;
