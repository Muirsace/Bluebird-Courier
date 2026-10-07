import { emptyLocalValues, localReadCursor, localReadLimit, localReadOffset, selectedLocalScopes } from '../../domain/rules/local-read';
import { SCOPE_ORDER } from '../../domain/rules/detail-scope';
import type { Clock, GitHubPort, Logger } from '../../domain/ports';
import type { DetailScope, FetchedGlance, Glance, GlanceValues, NormalizedError, PaginationCursor, RepoInputResult } from '../../domain/types';
import type { AccessTokenResult, AccessTokenState, AddRepositoryResult, BluebirdCourierFacade, DetailResult, LocalReadRequest, LocalReadResult, RefreshGlanceResult, SettingsView } from '../../shared/types';
import type { RepositoryDetailService, LocalReadRequest as DetailLocalReadRequest } from '../features/repository-detail/contract';
import type { RepositoryListService } from '../features/repository-list/contract';
import type { SnapshotTrendService } from '../features/snapshot-trend/contract';
import type { TokenSettingsService } from '../features/token-settings/contract';
import { normalizeError, toWireDetail } from './result-mappers';

export interface FacadeDeps {
  repositoryList: RepositoryListService;
  repositoryDetail: RepositoryDetailService;
  tokenSettings: TokenSettingsService;
  snapshotTrend: SnapshotTrendService;
  github: GitHubPort;
  clock: Clock;
  logger?: Logger;
}

const silentLogger: Logger = { info() {}, error() {} };

function validId(id: unknown): id is number { return typeof id === 'number' && Number.isSafeInteger(id) && id > 0; }

function detailGlanceValues(repository: Glance, latestReleaseTag: string | null): GlanceValues & { fullName: string } {
  return {
    fullName: repository.fullName,
    stars: repository.stars ?? 0,
    forks: repository.forks ?? 0,
    openIssues: repository.openIssues ?? 0,
    pushedAt: repository.pushedAt,
    latestReleaseTag,
    latestTag: repository.latestTag ?? null,
    collaborationAt: repository.collaborationAt ?? null,
    status: repository.status ?? 'active',
  };
}

const DETAIL_SCOPES = new Set<DetailScope>(SCOPE_ORDER);

/** 只接受已知字段、合法范围与游标；未知输入不产生额外行为。 */
function localReadRequestFrom(input: unknown): DetailLocalReadRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const value = input as { mode?: unknown; scopes?: unknown; itemLimit?: unknown; cursors?: unknown };
  const request: DetailLocalReadRequest = {};
  if (value.mode === 'status' || value.mode === 'view') request.mode = value.mode;
  if (Array.isArray(value.scopes)) {
    request.scopes = value.scopes.filter((scope): scope is DetailScope => typeof scope === 'string' && DETAIL_SCOPES.has(scope as DetailScope));
  }
  if (typeof value.itemLimit === 'number' && Number.isFinite(value.itemLimit)) request.itemLimit = value.itemLimit;
  if (typeof value.cursors === 'object' && value.cursors !== null && !Array.isArray(value.cursors)) {
    const cursors: Partial<Record<DetailScope, PaginationCursor>> = {};
    for (const [scope, cursor] of Object.entries(value.cursors)) {
      if (DETAIL_SCOPES.has(scope as DetailScope) && (typeof cursor === 'string' || cursor === null)) cursors[scope as DetailScope] = cursor;
    }
    request.cursors = cursors;
  }
  return request;
}

export function createFacade(deps: FacadeDeps): BluebirdCourierFacade {
  const logger = deps.logger ?? silentLogger;
  const token = (): string | null => deps.tokenSettings.readAccessToken();
  const tokenError = (fullName?: string): NormalizedError => ({ kind: 'access_token_invalid', message: '请先在设置页配置访问令牌', ...(fullName ? { fullName } : {}) });
  const list = (): Glance[] => deps.repositoryList.list();
  const find = (id: number): Glance | null => deps.repositoryList.findById(id);
  const findByName = (fullName: string): Glance | null => deps.repositoryList.findByFullName(fullName);

  /**
   * 本地打开前消费该仓库的待交接观察：应用成功或已应用（重启重放）才确认交接。
   * 失败（损坏、事务回滚、跨上下文无进展）保持待交接，供后续重放；不影响打开路径。
   */
  function drainPendingObservations(repositoryId: number): void {
    const current = deps.tokenSettings.accessContextRevision();
    let afterObservationId: string | undefined;
    while (true) {
      const pending = deps.repositoryList.pendingObservations(100, { repositoryId, accessContextRevision: current, afterObservationId });
      if (pending.length === 0) break;
      for (const handoff of pending) {
        try {
          const outcome = deps.repositoryDetail.applyObservation(handoff, deps.clock.now().toISOString());
          if (outcome.applied || outcome.duplicate) deps.repositoryList.confirmObservationHandoff(handoff.observationId);
        } catch (error) { logger.error('待交接观察应用失败：' + repositoryId, error); }
      }
      afterObservationId = pending[pending.length - 1]!.observationId;
    }
  }

  async function validateAccessToken(accessToken: string): Promise<AccessTokenResult> {
    try {
      const result = await deps.tokenSettings.verify(accessToken);
      return { ok: result.ok, error: result.error };
    } catch (error) { logger.error('访问令牌校验失败', error); return { ok: false, error: normalizeError(error) }; }
  }

  const facade: Record<string, unknown> = {
    accessTokenState: async (): Promise<AccessTokenState> => ({ configured: deps.tokenSettings.accessTokenConfigured() }),
    validateAccessToken,
    async saveAccessToken(accessToken: string): Promise<AccessTokenResult> {
      try {
        const result = await deps.tokenSettings.save(accessToken);
        return { ok: result.ok, error: result.error };
      } catch (error) { logger.error('访问令牌保存失败', error); return { ok: false, error: normalizeError(error) }; }
    },
    getSettings: async (): Promise<SettingsView> => deps.tokenSettings.getSettings(),
    updateSettings: async (patch: Record<string, string>): Promise<SettingsView> => deps.tokenSettings.updateSettings(patch),
    inspectRepositoryInput: async (input: string): Promise<RepoInputResult> => deps.repositoryList.inspectInput(input),
    listRepositories: async (): Promise<Glance[]> => list(),
    async addRepository(input: unknown): Promise<AddRepositoryResult> {
      const raw = typeof input === 'string' ? input : '';
      const parsed = deps.repositoryList.inspectInput(raw);
      if (!parsed.ok) return { ok: false, repository: null, error: { kind: 'not_found', message: parsed.message, fullName: raw.trim() } };
      const fullName = `${parsed.owner}/${parsed.name}`;
      if (findByName(fullName)) return { ok: false, repository: null, error: { kind: 'unknown', message: '该仓库已在监控清单中', fullName } };
      if (list().length >= 50) return { ok: false, repository: null, error: { kind: 'unknown', message: '最多只能监控 50 个仓库', fullName } };
      const accessToken = token(); if (!accessToken) return { ok: false, repository: null, error: tokenError(fullName) };
      let pendingId: number | null = null;
      try {
        const pending = deps.repositoryList.createPending(fullName); pendingId = pending.id;
        const values = await fetchGlance(accessToken, fullName, deps.github);
        deps.snapshotTrend.record(pending.id, values);
        const repository = deps.repositoryList.applyGlance(pending.id, values);
        return { ok: true, repository, error: null };
      } catch (error) { const normalized = normalizeError(error, fullName); if (pendingId !== null) deps.repositoryList.markFailure(pendingId, normalized); logger.error(`加入监控清单失败：${fullName}`, error); return { ok: false, repository: null, error: normalized }; }
    },
    async removeRepository(repositoryId: unknown): Promise<void> {
      if (!validId(repositoryId)) return;
      const removed = deps.repositoryList.remove(repositoryId);
      if (removed.removed) { deps.repositoryDetail.remove(repositoryId); deps.snapshotTrend.remove(repositoryId); }
    },
    async refreshGlance(origin: 'startup' | 'manual' = 'manual'): Promise<RefreshGlanceResult> {
      if (origin !== 'startup' && origin !== 'manual') return { repositories: list(), errors: [{ kind: 'unknown', message: '检查意图无效' }] };
      const repositories = list(); if (repositories.length === 0) return { repositories: [], errors: [] };
      const accessToken = token(); if (!accessToken) return { repositories, errors: [tokenError()] };
      // 轻量检查由清单 feature 组织（观察 / 比较 / 原子保存 / 待交接）；facade 只编排趋势采样。
      const outcome = await deps.repositoryList.checkRepositories(accessToken, deps.tokenSettings.accessContextRevision(), origin);
      for (const observed of outcome.observed) {
        if (observed.accessContextRevision !== deps.tokenSettings.accessContextRevision() || !find(observed.repositoryId)) continue;
        try {
          // 真实观察时间采样；快照失败记录后继续，不回滚已成功保存的摘要（设计 14.2）。
          deps.snapshotTrend.recordObserved(observed.repositoryId, observed.values, observed.observedAt);
        } catch (error) {
          logger.error(`趋势快照写入失败：${observed.repositoryId}`, error);
        }
      }
      return {
        repositories: outcome.repositories,
        errors: outcome.errors,
        ...(outcome.skipped ? { skipped: true } : {}),
        ...(outcome.stopped ? { stopped: true, stopReason: outcome.stopReason } : {}),
      };
    },
    async fetchDetail(repositoryId: unknown): Promise<DetailResult> {
      if (!validId(repositoryId)) return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
      const repository = find(repositoryId); if (!repository) return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
      // 本地打开前先消费待交接观察（幂等应用 → 确认）；失败保持待交接供重放。
      drainPendingObservations(repositoryId);
      const accessToken = token(); if (!accessToken) return { detail: null, error: tokenError(repository.fullName) };
      try {
        const loaded = await deps.repositoryDetail.open(repositoryId, accessToken);
        const trend = deps.snapshotTrend.trend(repositoryId).map((point) => ({ capturedAt: point.capturedAt, stars: point.stars, forks: point.forks, openIssues: null, latestReleaseTag: null, pushedAt: null }));
        const latestReleaseTag = loaded.values.releases[0]?.tagName ?? repository.latestReleaseTag ?? null;
        const summary = detailGlanceValues(loaded.repository, latestReleaseTag);
        deps.snapshotTrend.record(repositoryId, summary);
        deps.repositoryList.applyGlance(repositoryId, summary);
        const detail = toWireDetail({ repository: loaded.repository, ...loaded.values, trend });
        return { detail, error: loaded.error, cached: loaded.cached, stale: loaded.stale, columns: loaded.columns };
      } catch (error) { logger.error(`全量信息抓取失败：${repository.fullName}`, error); return { detail: null, error: normalizeError(error, repository.fullName) }; }
    },
    async readLocalDetail(repositoryId: unknown, request?: unknown): Promise<LocalReadResult> {
      const current = deps.tokenSettings.accessContextRevision();
      const notFound: LocalReadResult = {
        repositoryId: validId(repositoryId) ? repositoryId : 0,
        viewVersion: 0,
        accessContextRevision: current,
        detail: null,
        syncState: {},
        task: null,
        truncated: false,
        error: { kind: 'not_found', message: '监控仓库不存在' },
      };
      if (!validId(repositoryId)) return notFound;
      // 只读本地：不需要访问令牌，不写摘要、不采样、不刷新任何抓取时间。
      const query = localReadRequestFrom(request);
      const view = deps.repositoryDetail.readLocal(repositoryId, query);
      if (!view) return notFound;
      const trendState = deps.snapshotTrend.localCacheState(repositoryId);
      const trendVersion = trendState.viewVersion;
      view.scopes.trends = { ...view.scopes.trends!, cacheStatus: trendState.cacheStatus };
      const cursors = { ...view.cursors };
      let truncated = view.truncated;
      let error = view.error;
      let values = view.values;
      let trend: Parameters<typeof toWireDetail>[0]['trend'] = [];
      if (query.mode !== 'status' && selectedLocalScopes(query.scopes).includes('trends')) {
        if (trendState.cacheStatus === 'invalid') error ??= { kind: 'unknown', message: '趋势缓存属于其他访问上下文，暂不可展示' };
        else {
          const identity = { repositoryId, accessContextRevision: current, viewVersion: trendVersion, fetchedAt: null };
          const offset = localReadOffset(query.cursors?.trends, 'trends', identity);
          if (offset === null) error ??= { kind: 'unknown', message: 'trends 本地续读游标已失效，请重新读取该范围' };
          else {
            values ??= emptyLocalValues();
            const page = deps.snapshotTrend.readLocalPage(repositoryId, offset, localReadLimit(query.itemLimit));
            trend = page.points.map(point => ({ ...point, openIssues: null, latestReleaseTag: null, pushedAt: null }));
            if (page.hasMore) { truncated = true; cursors.trends = localReadCursor('trends', offset + page.points.length, identity); }
          }
        }
      }
      const detail = values === null ? null : toWireDetail({ repository: view.repository, ...values, trend });
      return {
        repositoryId,
        viewVersion: view.viewVersion + trendVersion,
        accessContextRevision: view.accessContextRevision,
        detail,
        syncState: view.scopes,
        task: view.task, // 步骤 7B 才有后台任务；不返回虚假的 running / queued 状态
        ...(Object.keys(cursors).length > 0 ? { cursors } : {}),
        truncated,
        error,
      };
    },
    async refreshRepository(repositoryId: number, force = true): Promise<DetailResult> {
      const repository = find(repositoryId); const accessToken = token();
      if (!repository || !accessToken) return { detail: null, error: !repository ? { kind: 'not_found', message: '监控仓库不存在' } : tokenError(repository.fullName) };
      try {
        const loaded = force ? await deps.repositoryDetail.refresh(repositoryId, accessToken) : await deps.repositoryDetail.open(repositoryId, accessToken);
        const trend = deps.snapshotTrend.trend(repositoryId).map((point) => ({ capturedAt: point.capturedAt, stars: point.stars, forks: point.forks, openIssues: null, latestReleaseTag: null, pushedAt: null }));
        const latestReleaseTag = loaded.values.releases[0]?.tagName ?? repository.latestReleaseTag ?? null;
        const summary = detailGlanceValues(loaded.repository, latestReleaseTag);
        deps.snapshotTrend.record(repositoryId, summary);
        deps.repositoryList.applyGlance(repositoryId, summary);
        return { detail: toWireDetail({ repository: loaded.repository, ...loaded.values, trend }), error: loaded.error, cached: loaded.cached, stale: loaded.stale, columns: loaded.columns };
      } catch (error) { return { detail: null, error: normalizeError(error, repository.fullName) }; }
    },
    async loadHistory(repositoryId: number, kind: 'commits' | 'issues' | 'pullRequests', cursor?: string) {
      const repository = find(repositoryId); const accessToken = token();
      if (!repository || !accessToken) return { items: [], nextCursor: null, hasMore: false };
      return deps.repositoryDetail.loadHistory(repositoryId, accessToken, kind, cursor);
    },
    async trend(repositoryId: number) {
      return { repositoryId, points: deps.snapshotTrend.trend(repositoryId) };
    },
    beginTokenReplacement: async () => deps.tokenSettings.beginReplace(),
    cancelTokenReplacement: async () => deps.tokenSettings.cancelReplace(),
    confirmTokenReplacement: async (accessToken: string) => {
      const result = await deps.tokenSettings.confirmReplace(accessToken);
      if (result.ok) { deps.repositoryList.clear(); deps.repositoryDetail.clear(); deps.snapshotTrend.clear(); }
      return result;
    },
  };
  return facade as unknown as BluebirdCourierFacade;
}

async function fetchGlance(token: string, fullName: string, github: GitHubPort): Promise<FetchedGlance> {
  const [meta, release] = await Promise.all([github.getRepositoryMeta(token, fullName), github.getLatestRelease(token, fullName)]);
  const collaborationAt = github.getCollaborationActivity ? await github.getCollaborationActivity(token, fullName) : null;
  return { fullName: meta.fullName, stars: meta.stars, forks: meta.forks, openIssues: meta.openIssues, pushedAt: meta.pushedAt, latestReleaseTag: release?.tagName ?? meta.latestReleaseTag ?? null, latestTag: meta.latestTag ?? null, collaborationAt, status: meta.status ?? 'active' };
}
