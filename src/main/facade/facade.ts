import { emptyLocalValues, localReadCursor, localReadLimit, localReadOffset, selectedLocalScopes } from '../../domain/rules/local-read';
import { SCOPE_ORDER } from '../../domain/rules/detail-scope';
import type { Clock, GitHubPort, Logger } from '../../domain/ports';
import type { DetailScope, FetchedGlance, Glance, GlanceValues, NormalizedError, PaginationCursor, RepoInputResult } from '../../domain/types';
import type { AccessTokenResult, AccessTokenState, AcknowledgeResult, AddRepositoryResult, BluebirdCourierFacade, DetailResult, LocalReadRequest, LocalReadResult, RefreshGlanceResult, SettingsView, TokenChangeState, TokenOperationResult } from '../../shared/types';
import type { DetailAccessResult, LocalDetailView, RepositoryDetailService, LocalReadRequest as DetailLocalReadRequest, ViewAcknowledgment } from '../features/repository-detail/contract';
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

/**
 * 门面之外的主进程生命周期入口：由唯一组合根在启动时调用一次。
 * 不是 renderer 用例，不新增公共 IPC，也不参与 preload 桥接。
 */
export interface FacadeLifecycle {
  /**
   * 启动维护（无网络、无 Token 要求）：
   * 1. 若存在持久清理意图，先完成令牌更换后的本地资料清理（重启恢复清理义务）；
   * 2. 有界重放尚未交接的清单观察（幂等应用成功才确认）；
   * 3. 有界补偿先前未写成功的真实采样。
   * 必须在 UI 依赖 freshness 之前调用；清理仍未完成时不再展示旧上下文资料。
   */
  startupMaintenance(): void;
}

const silentLogger: Logger = { info() {}, error() {} };

/** 待交接观察单批上限与单次重放的最大批数：有界，避免一条不合法观察拖垮整个恢复。 */
const OBSERVATION_REPLAY_BATCH = 100;
const OBSERVATION_REPLAY_MAX_BATCHES = 50;

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

/** 展示确认入参守卫：只接受非负整数版本与合法范围；无效输入保守忽略（返回 null 不产生行为）。 */
function acknowledgmentFrom(input: unknown): ViewAcknowledgment | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input as { detailViewVersion?: unknown; accessContextRevision?: unknown; scopes?: unknown };
  if (typeof value.detailViewVersion !== 'number' || !Number.isSafeInteger(value.detailViewVersion) || value.detailViewVersion < 0) return null;
  if (typeof value.accessContextRevision !== 'number' || !Number.isSafeInteger(value.accessContextRevision) || value.accessContextRevision < 0) return null;
  if (!Array.isArray(value.scopes)) return null;
  const scopes = value.scopes.filter((scope): scope is DetailScope => typeof scope === 'string' && DETAIL_SCOPES.has(scope as DetailScope));
  if (scopes.length === 0) return null;
  return { detailViewVersion: value.detailViewVersion, accessContextRevision: value.accessContextRevision, scopes };
}

export function createFacade(deps: FacadeDeps): BluebirdCourierFacade & FacadeLifecycle {
  const logger = deps.logger ?? silentLogger;
  const token = (): string | null => deps.tokenSettings.readAccessToken();
  const tokenError = (fullName?: string): NormalizedError => ({ kind: 'access_token_invalid', message: '请先在设置页配置访问令牌', ...(fullName ? { fullName } : {}) });
  /**
   * 持久清理意图属于权威事实：令牌与上下文已提交、跨 feature 清理未完成。
   * 期间不得把旧上下文的清单 / 详情 / 趋势当当前内容展示，也不得启动新的网络写入。
   */
  const cleanupPending = (): boolean => deps.tokenSettings.cleanupState().pending;
  const pendingError = (fullName?: string): NormalizedError => ({ kind: 'unknown', message: '访问令牌已更换，本地资料清理尚未完成；请重试清理后再查看或同步', ...(fullName ? { fullName } : {}) });
  const list = (): Glance[] => (cleanupPending() ? [] : deps.repositoryList.list());
  const find = (id: number): Glance | null => (cleanupPending() ? null : deps.repositoryList.findById(id));
  const findByName = (fullName: string): Glance | null => (cleanupPending() ? null : deps.repositoryList.findByFullName(fullName));

  /** 有界恢复进度属于清单 feature；事务失败保留交接，到尾后下次调用重试。 */
  function replayPendingObservations(repositoryId?: number): void {
    const current = deps.tokenSettings.accessContextRevision();
    for (let batch = 0; batch < OBSERVATION_REPLAY_MAX_BATCHES; batch += 1) {
      let page: ReturnType<RepositoryListService['nextObservationReplayPage']>;
      try { page = deps.repositoryList.nextObservationReplayPage(OBSERVATION_REPLAY_BATCH, current, repositoryId); }
      catch (error) { logger.error('待交接观察读取失败', error); return; }
      for (const handoff of page.observations) {
        try {
          const outcome = deps.repositoryDetail.applyObservation(handoff, deps.clock.now().toISOString());
          if (outcome.applied || outcome.duplicate) deps.repositoryList.confirmObservationHandoff(handoff.observationId);
        } catch (error) { logger.error(`待交接观察应用失败：${handoff.repoId}`, error); }
      }
      if (page.reachedEnd) return;
    }
  }

  /** 有界补偿先前未写成功的真实采样；失败只记录，不影响启动与刷新结果。 */
  function recoverPendingSampling(): void {
    try { deps.snapshotTrend.recoverPendingSampling(); } catch (error) { logger.error('趋势采样补偿失败', error); }
  }

  /**
   * 组装对外令牌结果：tokenCommitted 来自本次操作事实，cleanupPending 与 revision 取组装时的
   * 权威持久状态，不用内存标志代替。ok=true / state=completed 只在清理也完成时返回。
   */
  function tokenResult(base: { ok: boolean; state: TokenChangeState; error: NormalizedError | null }, tokenCommitted: boolean): TokenOperationResult {
    const cleanup = deps.tokenSettings.cleanupState();
    return {
      ok: base.ok,
      state: base.state,
      error: base.error,
      tokenCommitted,
      cleanupPending: cleanup.pending,
      accessContextRevision: deps.tokenSettings.accessContextRevision(),
    };
  }

  /**
   * 成功更换令牌后的本地资料清理：按自有 contract 逐一清理清单、详情、趋势，
   * 覆盖未交接观察、范围账本、暂存与应用记账（多数由仓库外键级联承载），随后条件性完成持久意图。
   * 失败或意图已被更新的更换取代时不报告 completed：保持待清理状态，重试只重做清理，
   * 绝不再次推进访问上下文，也不清除新一次更换写下的意图。
   */
  function attemptTokenCleanup(tokenCommitted: boolean): TokenOperationResult {
    const state = deps.tokenSettings.cleanupState();
    if (state.pending) {
      try {
        deps.repositoryList.clear();
        deps.repositoryDetail.clear();
        deps.snapshotTrend.clear();
        // 条件性完成仅清除对应版本；完成标志落库失败也须返回已提交且待恢复的事实。
        deps.tokenSettings.completeCleanup(state.accessContextRevision);
      } catch (error) {
        logger.error('访问令牌已更换，但本地资料清理失败', error);
        return tokenResult({ ok: false, state: 'failed', error: { kind: 'unknown', message: '访问令牌已更换，但本地资料清理未完成，请重试更换确认以完成清理' } }, tokenCommitted);
      }
    }
    if (deps.tokenSettings.cleanupState().pending) {
      // 更新的更换已写下新意图：旧清理回包不得宣告整体完成。
      return tokenResult({ ok: false, state: 'failed', error: { kind: 'unknown', message: '访问令牌已更换，但本地资料清理未完成，请重试更换确认以完成清理' } }, tokenCommitted);
    }
    return tokenResult({ ok: true, state: 'completed', error: null }, tokenCommitted);
  }

  /**
   * 启动维护：先恢复令牌更换后的清理义务，再本地重放待交接观察与补偿未完成的真实采样。
   * 清理仍未完成时不再处理其他维护：此时旧上下文资料不构成可展示的当前事实。
   * 无网络、无 Token 要求。
   */
  function startupMaintenance(): void {
    if (cleanupPending()) {
      attemptTokenCleanup(true);
      if (cleanupPending()) {
        logger.error('启动时未能完成访问令牌更换后的本地清理，等待重试');
        return;
      }
    }
    replayPendingObservations();
    recoverPendingSampling();
  }

  async function validateAccessToken(accessToken: string): Promise<AccessTokenResult> {
    try {
      const result = await deps.tokenSettings.verify(accessToken);
      return { ok: result.ok, error: result.error };
    } catch (error) { logger.error('访问令牌校验失败', error); return { ok: false, error: normalizeError(error) }; }
  }

  // 真实网络摘要经上下文和观察时间保护后更新清单，并按源观察时间采样；后台完成也走同一路径。
  deps.repositoryList.onObservation(observation => {
    if (observation.accessContextRevision !== deps.tokenSettings.accessContextRevision() || !find(observation.repositoryId)) return;
    try { deps.snapshotTrend.stageObserved(observation.repositoryId, observation.values, observation.observedAt, observation.observationId); }
    catch (error) { logger.error('真实清单观察采样失败：' + observation.repositoryId, error); }
  });
  deps.repositoryDetail.onObservation(observation => {
    if (observation.accessContextRevision !== deps.tokenSettings.accessContextRevision() || !find(observation.repositoryId)) return;
    try {
      const applied = deps.repositoryList.applyObservedSummary(observation.repositoryId, observation.values, observation.observedAt, observation.accessContextRevision);
      if (applied) deps.snapshotTrend.recordObserved(observation.repositoryId, observation.values, observation.observedAt, observation.observationId);
    } catch (error) { logger.error('真实摘要观察保存或采样失败：' + observation.repositoryId, error); }
  });

  /** 打开 / 强制同步的失败优先级：等待的获取失败 > 无可展示内容（无令牌或缺失）> 本地视图错误。 */
  function accessError(repository: Glance, access: DetailAccessResult): NormalizedError | null {
    if (access.error !== null) return normalizeError(access.error, repository.fullName);
    if (access.view.values === null) {
      return token() === null
        ? tokenError(repository.fullName)
        : { kind: 'unknown', message: '本地没有可展示的详情缓存', fullName: repository.fullName };
    }
    return access.view.error;
  }

  function detailResultFrom(repository: Glance, access: DetailAccessResult, error: NormalizedError | null): DetailResult {
    let view = access.view;
    const current = deps.repositoryDetail.readLocal(repository.id, { mode: 'status' });
    if (!current?.task && current && current.viewVersion !== view.viewVersion) view = deps.repositoryDetail.readLocal(repository.id) ?? view;
    error = access.error !== null ? error : view.error ?? error;
    const trendState = deps.snapshotTrend.localCacheState(repository.id);
    const trendPage = deps.snapshotTrend.readLocalPage(repository.id, 0, localReadLimit());
    const trend = trendPage.points.map((point) => ({ capturedAt: point.capturedAt, stars: point.stars, forks: point.forks, openIssues: null, latestReleaseTag: null, pushedAt: null }));
    const cursors = { ...view.cursors };
    if (trendPage.hasMore) cursors.trends = localReadCursor('trends', trendPage.points.length, {
      repositoryId: repository.id, accessContextRevision: view.accessContextRevision, viewVersion: trendState.viewVersion, fetchedAt: trendState.windowKey,
    });
    return {
      detail: view.values === null ? null : toWireDetail({ repository: view.repository, ...view.values, trend }),
      error,
      cached: !access.fetched && view.values !== null,
      stale: view.values !== null && (error !== null || Object.values(view.scopes).some((state) => state?.freshness === 'stale')),
      columns: view.columns,
      // 组合展示版本保持既有语义；确认与续读按权威详情版本 detailViewVersion。
      viewVersion: view.viewVersion + trendState.viewVersion,
      detailViewVersion: view.viewVersion,
      trendWindow: trendState.windowKey,
      accessContextRevision: view.accessContextRevision,
      ...(Object.keys(cursors).length > 0 ? { cursors } : {}),
      truncated: view.truncated || trendPage.hasMore,
      summaryFetchedAt: view.repository.fetchedAt ?? null,
      detailFetchedAt: view.detailFetchedAt,
      syncState: { ...view.scopes, trends: { ...view.scopes.trends!, cacheStatus: trendState.cacheStatus } },
      task: deps.repositoryDetail.readLocal(repository.id, { mode: 'status' })?.task ?? null,
    };
  }

  // 直接按契约类型装配：缺少必需方法、参数或结果不符时在编译期暴露，不用类型强转掩盖。
  const facade = {
    accessTokenState: async (): Promise<AccessTokenState> => {
      // 无网络、无令牌读取：只读本地配置状态与持久清理事实，不返回明文。
      const cleanup = deps.tokenSettings.cleanupState();
      return {
        configured: deps.tokenSettings.accessTokenConfigured(),
        accessContextRevision: deps.tokenSettings.accessContextRevision(),
        cleanupPending: cleanup.pending,
      };
    },
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
      if (cleanupPending()) return { ok: false, repository: null, error: pendingError(fullName) };
      if (findByName(fullName)) return { ok: false, repository: null, error: { kind: 'unknown', message: '该仓库已在监控清单中', fullName } };
      if (list().length >= 50) return { ok: false, repository: null, error: { kind: 'unknown', message: '最多只能监控 50 个仓库', fullName } };
      const accessToken = token(); if (!accessToken) return { ok: false, repository: null, error: tokenError(fullName) };
      // 网络等待前捕获本次新增的身份与访问上下文：旧回包不得写入新上下文、复活已删 id 或改同名新仓库。
      const accessContextRevision = deps.tokenSettings.accessContextRevision();
      let pendingId: number | null = null;
      try {
        const pending = deps.repositoryList.createPending(fullName); pendingId = pending.id;
        const observedAt = deps.clock.now().toISOString();
        const values = await fetchGlance(accessToken, fullName, deps.github);
        const observationId = deps.repositoryList.newObservationId();
        const current = find(pendingId);
        if (!current || current.fullName !== fullName || deps.tokenSettings.accessContextRevision() !== accessContextRevision || cleanupPending()) {
          logger.error(`新增仓库观察回包已过期，放弃写入：${fullName}`);
          return { ok: false, repository: null, error: { kind: 'unknown', message: '仓库或访问上下文已变化，放弃本次新增结果', fullName } };
        }
        // 受保护 Summary 写入契约：再次校验仓库存在、上下文与观察时间先后，过期回包不落库。
        const repository = deps.repositoryList.applyObservedSummary(pendingId, values, observedAt, accessContextRevision);
        if (repository === null) return { ok: false, repository: null, error: { kind: 'unknown', message: '新增仓库结果已过期，未写入摘要', fullName } };
        try {
          // 采样只接受真实当前观察：上面已确认身份与上下文，观察时间取自真实观察。
          deps.snapshotTrend.recordObserved(pendingId, values, observedAt, observationId);
        } catch (error) {
          // 采样失败只留待补偿：不回滚摘要，也不把已成功的仓库标成抓取失败或丢失。
          logger.error(`新增仓库趋势采样失败：${fullName}`, error);
        }
        return { ok: true, repository, error: null };
      } catch (error) {
        const normalized = normalizeError(error, fullName);
        const current = pendingId === null ? null : find(pendingId);
        if (current?.fullName === fullName && deps.tokenSettings.accessContextRevision() === accessContextRevision && !cleanupPending()) deps.repositoryList.markFailure(current.id, normalized);
        logger.error(`加入监控清单失败：${fullName}`, error);
        return { ok: false, repository: null, error: normalized };
      }
    },
    async removeRepository(repositoryId: unknown): Promise<void> {
      if (!validId(repositoryId)) return;
      const removed = deps.repositoryList.remove(repositoryId);
      if (removed.removed) { deps.repositoryDetail.remove(repositoryId); deps.snapshotTrend.remove(repositoryId); }
    },
    async refreshGlance(origin: 'startup' | 'manual' = 'manual'): Promise<RefreshGlanceResult> {
      if (origin !== 'startup' && origin !== 'manual') return { repositories: list(), errors: [{ kind: 'unknown', message: '检查意图无效' }] };
      // 清理未完成期间不读旧清单、不发起网络检查，也不把旧上下文当当前。
      if (cleanupPending()) return { repositories: [], errors: [pendingError()], stopped: true };
      // 及时交接：先处理已有待交接观察，离线 / 无 Token 也能把 dirty 落到详情账本。
      replayPendingObservations();
      const repositories = list(); if (repositories.length === 0) return { repositories: [], errors: [] };
      const accessToken = token(); if (!accessToken) return { repositories, errors: [tokenError()] };
      // 轻量检查由清单 feature 组织（观察 / 比较 / 原子保存 / 待交接）；facade 只编排趋势采样。
      const revision = deps.tokenSettings.accessContextRevision();
      const outcome = await deps.repositoryList.checkRepositories(accessToken, revision, origin);
      if (cleanupPending() || deps.tokenSettings.accessContextRevision() !== revision) {
        // 检查在途也可能更换Token；丢弃旧结果，只返回当前上下文可读的清单。
        return {
          repositories: list(),
          errors: cleanupPending() ? [pendingError()] : [],
          stopped: true,
        };
      }
      const samplingErrors: NormalizedError[] = [];
      for (const observed of outcome.observed) {
        if (observed.accessContextRevision !== deps.tokenSettings.accessContextRevision() || !find(observed.repositoryId)) continue;
        try {
          // 真实观察时间采样；快照失败登记待补偿后继续，不回滚已成功保存的摘要（设计 14.2）。
          deps.snapshotTrend.commitStagedObservation(observed.repositoryId, observed.observationId);
        } catch (error) {
          logger.error(`趋势快照写入失败：${observed.repositoryId}`, error);
          samplingErrors.push({ ...normalizeError(error, find(observed.repositoryId)?.fullName), source: 'persistence' });
        }
      }
      // 本次检查新产生的变化交接同样及时落到详情账本（只标记 dirty，不触发批量 Full Fetch）。
      replayPendingObservations();
      recoverPendingSampling();
      return {
        repositories: outcome.repositories,
        errors: [...outcome.errors, ...samplingErrors],
        ...(outcome.skipped ? { skipped: true } : {}),
        ...(outcome.stopped ? { stopped: true, stopReason: outcome.stopReason } : {}),
      };
    },
    async fetchDetail(repositoryId: unknown): Promise<DetailResult> {
      if (!validId(repositoryId)) return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
      if (cleanupPending()) return { detail: null, error: pendingError(), accessContextRevision: deps.tokenSettings.accessContextRevision() };
      const repository = find(repositoryId); if (!repository) return { detail: null, error: { kind: 'not_found', message: '监控仓库不存在' } };
      // 本地打开前先消费该仓库待交接观察（幂等应用 → 确认）；失败保持待交接供重放。
      replayPendingObservations(repositoryId);
      try {
        // 打开分流：有可展示缓存立即返回并按需安排后台任务（不等待网络）；无有效缓存等待首次获取。
        const access = await deps.repositoryDetail.open(repositoryId, token());
        if (!find(repositoryId) || access.view.accessContextRevision !== deps.tokenSettings.accessContextRevision()) return { detail: null, error: { kind: 'unknown', message: '仓库或访问上下文已变化，放弃旧响应' } };
        return detailResultFrom(repository, access, accessError(repository, access));
      } catch (error) { logger.error(`详情本地读取失败：${repository.fullName}`, error); return { detail: null, error: normalizeError(error, repository.fullName) }; }
    },
    async readLocalDetail(repositoryId: unknown, request?: unknown): Promise<LocalReadResult> {
      const current = deps.tokenSettings.accessContextRevision();
      const empty: LocalReadResult = {
        repositoryId: validId(repositoryId) ? repositoryId : 0,
        viewVersion: 0,
        detailViewVersion: 0,
        accessContextRevision: current,
        detail: null,
        columns: {},
        syncState: {},
        task: null,
        truncated: false,
        summaryFetchedAt: null,
        detailFetchedAt: null,
        error: { kind: 'not_found', message: '监控仓库不存在' },
      };
      // 清理未完成期间不展示旧上下文的清单 / 详情 / 趋势；以权威 context 与可恢复错误明示。
      if (cleanupPending()) return { ...empty, error: pendingError() };
      if (!validId(repositoryId)) return empty;
      // 只读本地：不需要访问令牌，不写摘要、不采样、不刷新任何抓取时间。
      const query = localReadRequestFrom(request);
      const view = deps.repositoryDetail.readLocal(repositoryId, query);
      if (!view) return empty;
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
          const identity = { repositoryId, accessContextRevision: current, viewVersion: trendVersion, fetchedAt: trendState.windowKey };
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
        // 组合展示版本保持既有语义；确认按权威详情版本 detailViewVersion，趋势采样不会使确认失效。
        viewVersion: view.viewVersion + trendVersion,
        detailViewVersion: view.viewVersion,
        trendWindow: trendState.windowKey,
        accessContextRevision: view.accessContextRevision,
        detail,
        columns: view.columns,
        syncState: view.scopes,
        task: view.task, // 真实在途任务快照；无任务为 null，不返回虚假的 running / queued 状态
        ...(Object.keys(cursors).length > 0 ? { cursors } : {}),
        truncated,
        summaryFetchedAt: view.repository.fetchedAt ?? null,
        detailFetchedAt: view.detailFetchedAt,
        error,
      };
    },
    async acknowledgeRepositoryViewed(repositoryId: unknown, acknowledgment: unknown): Promise<AcknowledgeResult> {
      // 无效标识或无效输入保守忽略：ok=false，不产生任何写入或网络行为。
      const parsed = acknowledgmentFrom(acknowledgment);
      if (!validId(repositoryId) || !parsed || cleanupPending()) return { ok: false, seenRevision: 0 };
      // 无 Token 也可确认本地实际展示：feature 事务内校验仓库、上下文、权威版本与可展示范围。
      const outcome = deps.repositoryDetail.acknowledgeViewed(repositoryId, parsed);
      return { ok: outcome.accepted, seenRevision: outcome.seenRevision };
    },
    async refreshRepository(repositoryId: number, force = true): Promise<DetailResult> {
      if (cleanupPending()) return { detail: null, error: pendingError(), accessContextRevision: deps.tokenSettings.accessContextRevision() };
      const repository = find(repositoryId); const accessToken = token();
      if (!repository || !accessToken) return { detail: null, error: !repository ? { kind: 'not_found', message: '监控仓库不存在' } : tokenError(repository.fullName) };
      replayPendingObservations(repositoryId);
      try {
        // 强制同步表达执行意图；失败时保留旧内容展示（view.values 为旧缓存）。
        const access = force ? await deps.repositoryDetail.refresh(repositoryId, accessToken) : await deps.repositoryDetail.open(repositoryId, accessToken);
        if (!find(repositoryId) || access.view.accessContextRevision !== deps.tokenSettings.accessContextRevision()) return { detail: null, error: { kind: 'unknown', message: '仓库或访问上下文已变化，放弃旧响应' } };
        return detailResultFrom(repository, access, accessError(repository, access));
      } catch (error) { return { detail: null, error: normalizeError(error, repository.fullName) }; }
    },
    async loadHistory(repositoryId: number, kind: 'commits' | 'issues' | 'pullRequests', cursor?: string) {
      // 清理未完成期间不展示旧上下文的历史分页，也不触发任何网络。
      if (cleanupPending()) return { items: [], nextCursor: null, hasMore: false };
      const repository = find(repositoryId); const accessToken = token();
      if (!repository) return { items: [], nextCursor: null, hasMore: false };
      return deps.repositoryDetail.loadHistory(repositoryId, accessToken ?? '', kind, cursor);
    },
    async trend(repositoryId: number) {
      if (cleanupPending()) return { repositoryId, points: [] };
      return { repositoryId, points: deps.snapshotTrend.trend(repositoryId) };
    },
    beginTokenReplacement: async () => tokenResult(deps.tokenSettings.beginReplace(), false),
    cancelTokenReplacement: async () => tokenResult(deps.tokenSettings.cancelReplace(), false),
    confirmTokenReplacement: async (accessToken: string) => {
      // 清理重试入口：空令牌且确有持久清理意图时只重做清理，
      // 不再验证 / 保存令牌、不推进上下文；没有持久意图则走普通确认（空值不能绕过验证）。
      if (accessToken === '' && cleanupPending()) return attemptTokenCleanup(true);
      const result = await deps.tokenSettings.confirmReplace(accessToken);
      // 取消 / 验证失败 / 被取代 / 提交失败：未提交，保留旧资料，不做任何清理。
      if (!result.ok) return tokenResult(result, result.tokenCommitted === true);
      return attemptTokenCleanup(true);
    },
    startupMaintenance,
  } satisfies BluebirdCourierFacade & FacadeLifecycle;
  return facade;
}

async function fetchGlance(token: string, fullName: string, github: GitHubPort): Promise<FetchedGlance> {
  const [meta, release] = await Promise.all([github.getRepositoryMeta(token, fullName), github.getLatestRelease(token, fullName)]);
  const collaborationAt = github.getCollaborationActivity ? await github.getCollaborationActivity(token, fullName) : null;
  return { fullName: meta.fullName, stars: meta.stars, forks: meta.forks, openIssues: meta.openIssues, pushedAt: meta.pushedAt, latestReleaseTag: release?.tagName ?? meta.latestReleaseTag ?? null, latestTag: meta.latestTag ?? null, collaborationAt, status: meta.status ?? 'active' };
}
