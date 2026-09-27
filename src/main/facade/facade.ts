import type Database from 'better-sqlite3';
import type { Clock } from '../core/clock';
import type { GitHubPort } from '../core/github/port';
import type { CipherBox } from '../core/cipher/cipher-box';
import { silentLogger, type Logger } from '../core/logging/logger';
import type {
  AddRepositoryResult,
  DetailResult,
  Glance,
  NormalizedError,
  OctoFacade,
  RefreshGlanceResult,
  SettingsView,
  AccessTokenResult,
  AccessTokenState,
} from '../../shared/types';
import { normalizeError } from './errors';
import { normalizeThemePreference, THEME_PREFERENCE_KEY } from '../../shared/theme';
import { parseRepoInput } from '../features/repo-input';
import {
  readAccessToken,
  readPreferences,
  writeAccessToken,
  writePreferences,
} from '../features/settings';
import {
  deleteRepositoryRow,
  findRepositoryByFullName,
  findRepositoryRow,
  insertRepositoryRow,
  listRepositoryRows,
  rowToGlance,
} from '../features/watchlist';
import { applyDetailValues, applyGlanceValues, fetchDetailValues, fetchGlanceValues } from '../features/fetching';

export interface FacadeDeps {
  db: Database.Database;
  github: GitHubPort;
  cipher: CipherBox;
  clock: Clock;
  logger?: Logger;
}

/** 轻量抓取的并发波次大小（冷启动就绪时间预算见 M3 验收）。 */
const GLANCE_CONCURRENCY = 5;

/**
 * 监控仓库标识：IPC 入参在运行期不可信（类型擦除后什么都可能传进来），
 * 非正整数一律按"没有这个仓库"处理，绝不让它落到 SQLite 的绑定参数上。
 */
function isRepositoryId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** 偏好项补丁：值必须是字符串；有任何一个不合法就整批拒绝，不做部分写入。 */
function requirePreferences(patch: unknown): Record<string, string> | null {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return null;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'string') return null;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * 用例门面：渲染层唯一入口。清单增删与列举、轻量/全量抓取、访问令牌校验保存、设置读写。
 * 一切行为都在这里对外可见，测试只测这个边界。
 */
export function createFacade(deps: FacadeDeps): OctoFacade {
  const logger = deps.logger ?? silentLogger;
  const { db, github, cipher, clock } = deps;

  async function validateAccessToken(accessToken: string): Promise<AccessTokenResult> {
    try {
      await github.validateAccessToken(accessToken);
      return { ok: true, error: null };
    } catch (error) {
      logger.error('访问令牌校验失败', error);
      return { ok: false, error: normalizeError(error) };
    }
  }

  function settingsView(): SettingsView {
    const preferences = readPreferences(db);
    // 主题值只可能是三档之一：库里若有脏值，读出来也按 system 呈现
    if (THEME_PREFERENCE_KEY in preferences) {
      preferences[THEME_PREFERENCE_KEY] = normalizeThemePreference(preferences[THEME_PREFERENCE_KEY]);
    }
    return {
      preferences,
      accessTokenConfigured: readAccessToken(db, cipher) !== null,
    };
  }

  /** 抓取前置条件：读出访问令牌，未配置则给出统一错误。 */
  function accessTokenOrFail(fullName?: string): { accessToken: string; error: null } | { accessToken: null; error: NormalizedError } {
    const accessToken = readAccessToken(db, cipher);
    if (accessToken === null) {
      return {
        accessToken: null,
        error: {
          kind: 'access_token_invalid',
          message: '请先在设置页配置访问令牌',
          ...(fullName === undefined ? {} : { fullName }),
        },
      };
    }
    return { accessToken, error: null };
  }

  return {
    accessTokenState(): Promise<AccessTokenState> {
      return Promise.resolve({ configured: readAccessToken(db, cipher) !== null });
    },
    validateAccessToken,
    async saveAccessToken(accessToken: string): Promise<AccessTokenResult> {
      const result = await validateAccessToken(accessToken);
      if (!result.ok) return result;
      try {
        // 校验通过才落库（密文），重复保存即覆盖旧令牌
        writeAccessToken(db, cipher, accessToken);
      } catch (error) {
        // 系统钥匙串不可用等落库失败：必须报错，不能让用户以为已保存
        logger.error('访问令牌保存失败', error);
        return { ok: false, error: normalizeError(error) };
      }
      return { ok: true, error: null };
    },
    getSettings(): Promise<SettingsView> {
      return Promise.resolve(settingsView());
    },
    updateSettings(patch: unknown): Promise<SettingsView> {
      const cleaned = requirePreferences(patch);
      if (cleaned === null) {
        logger.error('忽略格式非法的偏好项补丁（值必须是字符串）', patch);
        return Promise.resolve(settingsView());
      }
      // 主题值限定为 system/light/dark，非法值回退 system，不让脏值落库
      if (THEME_PREFERENCE_KEY in cleaned) {
        cleaned[THEME_PREFERENCE_KEY] = normalizeThemePreference(cleaned[THEME_PREFERENCE_KEY]);
      }
      writePreferences(db, cleaned);
      return Promise.resolve(settingsView());
    },
    listRepositories(): Promise<Glance[]> {
      return Promise.resolve(listRepositoryRows(db).map(rowToGlance));
    },
    async addRepository(input: unknown): Promise<AddRepositoryResult> {
      const fail = (
        kind: 'access_token_invalid' | 'not_found' | 'unknown',
        message: string,
        fullName: string,
      ): AddRepositoryResult => ({
        ok: false,
        repository: null,
        error: { kind, message, fullName },
      });

      // 非字符串入参按格式错误拒绝（否则 input.trim() 会抛原始 TypeError）
      const raw = typeof input === 'string' ? input : '';
      const parsed = parseRepoInput(raw);
      if (!parsed.ok) return fail('not_found', parsed.message, raw.trim());
      const fullName = `${parsed.owner}/${parsed.name}`;
      if (findRepositoryByFullName(db, fullName)) {
        return fail('unknown', '该仓库已在监控清单中', fullName);
      }
      const auth = accessTokenOrFail(fullName);
      if (auth.error) return { ok: false, repository: null, error: auth.error };

      try {
        // 先抓取验证（不存在/无权限/断网都不入列），成功才落库
        const values = await fetchGlanceValues(github, auth.accessToken, fullName);
        // 落库用 GitHub 返回的规范 full_name（用户输入的大小写不作数）
        const [owner = '', name = ''] = values.fullName.split('/');
        const row = insertRepositoryRow(db, owner, name, clock.now().toISOString());
        const glance = applyGlanceValues(db, clock, row.id, values);
        return { ok: true, repository: glance, error: null };
      } catch (error) {
        logger.error(`加入监控清单失败：${fullName}`, error);
        return { ok: false, repository: null, error: normalizeError(error, fullName) };
      }
    },
    removeRepository(repositoryId: unknown): Promise<void> {
      // 非法标识不触碰数据库：删除不存在的仓库本就是空操作，但要让日志留下痕迹
      if (isRepositoryId(repositoryId)) deleteRepositoryRow(db, repositoryId);
      else logger.error('忽略非法的监控仓库标识，未删除任何行', repositoryId);
      return Promise.resolve();
    },
    async refreshGlance(): Promise<RefreshGlanceResult> {
      const rows = listRepositoryRows(db);
      const errors: NormalizedError[] = [];
      const auth = accessTokenOrFail();
      if (auth.error) {
        return { repositories: rows.map(rowToGlance), errors: [auth.error] };
      }

      let aborted = false;
      // 分波并发抓取（每仓库两次调用），兼顾冷启动就绪时间与限流中止语义
      for (let start = 0; start < rows.length && !aborted; start += GLANCE_CONCURRENCY) {
        const wave = rows.slice(start, start + GLANCE_CONCURRENCY);
        const waveErrors = await Promise.all(
          wave.map(async (row): Promise<NormalizedError | null> => {
            try {
              const values = await fetchGlanceValues(github, auth.accessToken, row.full_name);
              applyGlanceValues(db, clock, row.id, values);
              return null;
            } catch (error) {
              logger.error(`轻量信息抓取失败：${row.full_name}`, error);
              return normalizeError(error, row.full_name);
            }
          }),
        );
        for (const error of waveErrors) {
          if (!error) continue;
          // 令牌失效与限流影响整个批次：只报一次并停止发起余下抓取
          const batchWide = error.kind === 'access_token_invalid' || error.kind === 'rate_limited';
          if (batchWide) {
            aborted = true;
            if (errors.some((e) => e.kind === error.kind)) continue;
          }
          errors.push(error);
        }
      }
      return { repositories: listRepositoryRows(db).map(rowToGlance), errors };
    },
    async fetchDetail(repositoryId: unknown): Promise<DetailResult> {
      // 非法标识按"没有这个仓库"处理，不落到 SQLite 绑定参数上
      if (!isRepositoryId(repositoryId)) {
        return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
      }
      const row = findRepositoryRow(db, repositoryId);
      if (!row) {
        return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
      }
      const auth = accessTokenOrFail(row.full_name);
      if (auth.error) return { detail: null, error: auth.error };
      try {
        // 抓取失败时 detail 为 null：全量信息不落库（spec 数据表只存轻量展示字段与快照），
        // "显示上次数据"由渲染层在会话内保留，错误条照常展示
        const values = await fetchDetailValues(github, auth.accessToken, row.full_name);
        return { detail: applyDetailValues(db, clock, repositoryId, values), error: null };
      } catch (error) {
        logger.error(`全量信息抓取失败：${row.full_name}`, error);
        return { detail: null, error: normalizeError(error, row.full_name) };
      }
    },
  };
}
