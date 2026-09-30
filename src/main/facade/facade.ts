import type { FetchingFeature } from '../features/fetching/contract';
import type { SettingsFeature } from '../features/settings/contract';
import type { WatchlistFeature } from '../features/watchlist/contract';
import type { Logger } from '../../domain/ports';
import type { Detail as DomainDetail, NormalizedError } from '../../domain/types';
import type {
  AccessTokenResult,
  AccessTokenState,
  AddRepositoryResult,
  BluebirdCourierFacade,
  DetailResult,
  RefreshGlanceResult,
  SettingsView,
} from '../../shared/types';
import { normalizeError } from './errors';

export interface FacadeDeps {
  settings: SettingsFeature;
  watchlist: WatchlistFeature;
  fetching: FetchingFeature;
  logger?: Logger;
}

const GLANCE_CONCURRENCY = 5;
const silentLogger: Logger = { info() {}, error() {} };

function toWireDetail(detail: DomainDetail): import('../../shared/types').Detail {
  return {
    ...detail,
    build: {
      status: detail.build.status,
      conclusion: detail.build.resultDescription,
      workflowName: detail.build.workflowName,
      url: detail.build.url,
      finishedAt: detail.build.finishedAt,
    },
  };
}

export function createFacade(deps: FacadeDeps): BluebirdCourierFacade {
  const logger = deps.logger ?? silentLogger;
  const { settings, watchlist, fetching } = deps;

  function tokenOrFail(fullName?: string): { token: string; error?: undefined } | { token?: undefined; error: NormalizedError } {
    const token = settings.readAccessToken();
    if (token) return { token };
    return { error: { kind: 'access_token_invalid', message: '请先在设置页配置访问令牌', ...(fullName ? { fullName } : {}) } };
  }

  async function validateAccessToken(accessToken: string): Promise<AccessTokenResult> {
    try {
      await fetching.validateAccessToken(accessToken);
      return { ok: true, error: null };
    } catch (error) {
      logger.error('访问令牌校验失败', error);
      return { ok: false, error: normalizeError(error) };
    }
  }

  return {
    accessTokenState: async (): Promise<AccessTokenState> => ({ configured: settings.readAccessToken() !== null }),
    validateAccessToken,
    async saveAccessToken(accessToken: string): Promise<AccessTokenResult> {
      const result = await validateAccessToken(accessToken);
      if (!result.ok) return result;
      try {
        settings.saveAccessToken(accessToken);
        return { ok: true, error: null };
      } catch (error) {
        logger.error('访问令牌保存失败', error);
        return { ok: false, error: normalizeError(error) };
      }
    },
    getSettings: async (): Promise<SettingsView> => settings.getSettings(),
    updateSettings: async (patch): Promise<SettingsView> => settings.updateSettings(patch),
    listRepositories: async () => watchlist.list(),
    inspectRepositoryInput: async (input) => watchlist.inspectInput(input),
    async addRepository(input: unknown): Promise<AddRepositoryResult> {
      const raw = typeof input === 'string' ? input : '';
      const parsed = watchlist.inspectInput(raw);
      if (!parsed.ok) return { ok: false, repository: null, error: { kind: 'not_found', message: parsed.message, fullName: raw.trim() } };
      const fullName = `${parsed.owner}/${parsed.name}`;
      if (watchlist.findByFullName(fullName)) return { ok: false, repository: null, error: { kind: 'unknown', message: '该仓库已在监控清单中', fullName } };
      const auth = tokenOrFail(fullName);
      if (auth.error) return { ok: false, repository: null, error: auth.error };
      try {
        const values = await fetching.fetchGlance(auth.token, fullName);
        return { ok: true, repository: watchlist.add(values), error: null };
      } catch (error) {
        logger.error(`加入监控清单失败：${fullName}`, error);
        return { ok: false, repository: null, error: normalizeError(error, fullName) };
      }
    },
    removeRepository: async (repositoryId: unknown): Promise<void> => watchlist.remove(repositoryId),
    async refreshGlance(): Promise<RefreshGlanceResult> {
      const repositories = watchlist.list();
      const auth = tokenOrFail();
      if (auth.error) return { repositories, errors: [auth.error] };
      const errors: NormalizedError[] = [];
      let aborted = false;
      for (let start = 0; start < repositories.length && !aborted; start += GLANCE_CONCURRENCY) {
        const wave = repositories.slice(start, start + GLANCE_CONCURRENCY);
        const waveErrors = await Promise.all(wave.map(async (repository): Promise<NormalizedError | null> => {
          try {
            const values = await fetching.fetchGlance(auth.token, repository.fullName);
            watchlist.applyGlance(repository.id, values);
            return null;
          } catch (error) {
            logger.error(`轻量信息抓取失败：${repository.fullName}`, error);
            return normalizeError(error, repository.fullName);
          }
        }));
        for (const error of waveErrors) {
          if (!error) continue;
          if (error.kind === 'access_token_invalid' || error.kind === 'rate_limited') {
            aborted = true;
            if (errors.some((item) => item.kind === error.kind)) continue;
          }
          errors.push(error);
        }
      }
      return { repositories: watchlist.list(), errors };
    },
    async fetchDetail(repositoryId: unknown): Promise<DetailResult> {
      if (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
      const repository = watchlist.findById(repositoryId);
      if (!repository) return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
      const auth = tokenOrFail(repository.fullName);
      if (auth.error) return { detail: null, error: auth.error };
      try {
        const values = await fetching.fetchDetail(auth.token, repository.fullName);
        return { detail: toWireDetail(watchlist.applyDetail(repositoryId, values)), error: null };
      } catch (error) {
        logger.error(`全量信息抓取失败：${repository.fullName}`, error);
        return { detail: null, error: normalizeError(error, repository.fullName) };
      }
    },
  };
}
