import type { DetailScope, ScopeSyncState } from '../../../../domain/types';
import { SCOPE_ORDER } from '../../../../domain/rules/detail-scope';
import { localReadLimit } from '../../../../domain/rules/local-read';
import type { LocalDatabase } from '../../../core/infra/database';
import type { AcknowledgeOutcome, ViewAcknowledgment } from '../contract';
import { DETAIL_CACHE_SCHEMA_VERSION, readDetailMeta, readScopeState, readScopeStates, writeScopeState } from './detail-store';
import { hasReadableDetail, isLocalScopeDisplayable } from './local-detail-store';

export interface ViewAcknowledgmentInput {
  repositoryId: number;
  repositoryExists: boolean;
  currentAccessContextRevision: number;
  /** 当前权威详情视图版本（detail_view_state）；确认的 detailViewVersion 必须与它一致。 */
  currentDetailViewVersion: number;
  acknowledgment: ViewAcknowledgment;
}

/** 常规详情仍未查看的最高重要版本；历史目录树独立保留，不阻碍当前详情的查看确认。 */
function remainingUnseen(states: Partial<Record<DetailScope, ScopeSyncState>>): number {
  let unseen = 0;
  for (const [scope, state] of Object.entries(states)) {
    if (scope === 'tree') continue;
    if (state && state.importantRevision > state.viewedRevision) unseen = Math.max(unseen, state.importantRevision);
  }
  return unseen;
}

/**
 * 展示确认事务：只推进实际展示范围对应的 already-synced 重要基线。
 *
 * - 旧版本 token、跨访问上下文、仓库不存在、缓存外壳不可用：保守忽略（accepted=false，不写库）。
 * - 每个范围还要按本地内容与栏目状态判定"可展示"：用与内容读取同源的有界首页读取
 *   （结构损坏或无可展示内容即不可确认），不信任持久账本的 cacheStatus、也不整份解析详情。
 *   损坏范围不推进 viewedRevision；同一请求的其他有效范围仍可独立确认；全无可确认范围时明示不接受。
 * - 每个可展示范围只推进 viewedRevision 到 min(syncedRevision, importantRevision)：detected
 *   但未同步的新变化继续满足 importantRevision > viewedRevision，不清掉未查看提示。
 * - 只在该数值实际推进时写库；不递增详情视图版本，避免确认→版本变化→重复确认循环。
 * - 无网络副作用、无 Token 要求。
 */
export function applyViewAcknowledgment(db: LocalDatabase, input: ViewAcknowledgmentInput): AcknowledgeOutcome {
  const { repositoryId, currentAccessContextRevision } = input;
  if (!input.repositoryExists) return { accepted: false, seenRevision: 0 };
  const readRemaining = (): number => remainingUnseen(readScopeStates(db, repositoryId, currentAccessContextRevision));
  if (input.acknowledgment.accessContextRevision !== currentAccessContextRevision) {
    return { accepted: false, seenRevision: readRemaining() };
  }
  if (input.acknowledgment.detailViewVersion !== input.currentDetailViewVersion) {
    return { accepted: false, seenRevision: readRemaining() };
  }
  const scopes = SCOPE_ORDER.filter(scope => input.acknowledgment.scopes.includes(scope));
  if (scopes.length === 0) return { accepted: false, seenRevision: readRemaining() };
  // 缓存外壳（schema / 访问上下文 / 可读性）不可用时，内容读取对每个范围都判 invalid，确认同样全部拒绝。
  const meta = readDetailMeta(db, repositoryId);
  const cacheUsable = meta !== null && meta.schemaVersion === DETAIL_CACHE_SCHEMA_VERSION
    && meta.accessContextRevision === currentAccessContextRevision && hasReadableDetail(db, repositoryId);
  if (!cacheUsable) return { accepted: false, seenRevision: readRemaining() };

  const limit = localReadLimit();
  const confirmable = scopes.filter(scope => {
    const state = readScopeState(db, repositoryId, scope, currentAccessContextRevision);
    return state !== null && state.cacheStatus === 'valid'
      && isLocalScopeDisplayable(db, repositoryId, scope, limit);
  });
  // 全无可确认范围（请求范围全部损坏/缺失）明示不接受，不宣示损坏内容被实际看过。
  if (confirmable.length === 0) return { accepted: false, seenRevision: readRemaining() };

  const write = db.transaction(() => {
    for (const scope of confirmable) {
      const state = readScopeState(db, repositoryId, scope, currentAccessContextRevision)!;
      const target = Math.min(state.syncedRevision, state.importantRevision);
      if (target <= state.viewedRevision) continue;
      writeScopeState(db, repositoryId, scope, { ...state, viewedRevision: target }, currentAccessContextRevision);
    }
  });
  write();
  return { accepted: true, seenRevision: readRemaining() };
}
