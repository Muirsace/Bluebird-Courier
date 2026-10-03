import type { GitHubPort, Logger } from '../../domain/ports';
import type { FetchedGlance, Glance, GlanceValues, NormalizedError, RepoInputResult } from '../../domain/types';
import type { AccessTokenResult, AccessTokenState, AddRepositoryResult, BluebirdCourierFacade, DetailResult, RefreshGlanceResult, SettingsView } from '../../shared/types';
import type { RepositoryDetailService } from '../features/repository-detail/contract';
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

export function createFacade(deps: FacadeDeps): BluebirdCourierFacade {
  const logger = deps.logger ?? silentLogger;
  const token = (): string | null => deps.tokenSettings.readAccessToken();
  const tokenError = (fullName?: string): NormalizedError => ({ kind: 'access_token_invalid', message: '请先在设置页配置访问令牌', ...(fullName ? { fullName } : {}) });
  const list = (): Glance[] => deps.repositoryList.list();
  const find = (id: number): Glance | null => deps.repositoryList.findById(id);
  const findByName = (fullName: string): Glance | null => deps.repositoryList.findByFullName(fullName);

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
    async refreshGlance(): Promise<RefreshGlanceResult> {
      const repositories = list(); if (repositories.length === 0) return { repositories: [], errors: [] };
      const accessToken = token(); if (!accessToken) return { repositories, errors: [tokenError()] };
      const errors: NormalizedError[] = []; let stopped = false;
      for (const repository of repositories) {
        if (stopped) break;
        try {
          const values = await fetchGlance(accessToken, repository.fullName, deps.github);
          deps.snapshotTrend.record(repository.id, values);
          deps.repositoryList.applyGlance(repository.id, values);
        } catch (error) {
          const normalized = normalizeError(error, repository.fullName); logger.error(`轻量信息抓取失败：${repository.fullName}`, error);
          if (normalized.kind === 'access_token_invalid' || normalized.kind === 'rate_limited') stopped = true;
          if (!errors.some((item) => item.kind === normalized.kind)) errors.push(normalized);
        }
      }
      return { repositories: list(), errors };
    },
    async fetchDetail(repositoryId: unknown): Promise<DetailResult> {
      if (!validId(repositoryId)) return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
      const repository = find(repositoryId); if (!repository) return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
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
