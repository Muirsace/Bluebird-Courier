import type { GitHubPort } from '../../../../domain/ports';
import type { SettingsState } from '../../../../domain/types';
import type { Clock } from '../../../core/infra/clock';
import type { CipherBox } from '../../../core/infra/encryption';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Logger } from '../../../core/infra/logger';
import type { TokenChangeState, TokenCleanupState, TokenOperationResult, TokenSettingsService } from '../contract';
import { createReplaceTokenController } from './replace-token';
import { advanceAccessContextRevision, clearCleanupIntent, readAccessContextRevision, readCleanupIntent, readPreferences, readToken, writePreferences, writeTokenAndAdvanceAccessContext } from './token-store';
import { createTokenVerifier } from './verify-token';

export interface TokenSettingsDependencies { db: LocalDatabase; cipher: CipherBox; github: GitHubPort; logger?: Logger; clock: Clock }

export function createTokenSettingsService({ db, cipher, github, logger, clock }: TokenSettingsDependencies): TokenSettingsService {
  let state: TokenChangeState = 'idle';
  const verifier = createTokenVerifier({ db, cipher, github, logger });
  const replacement = createReplaceTokenController({
    verify: verifier.verify,
    // 更换确认的落库是同步原子提交：加密令牌与访问上下文版本同一事务生效。
    commit: (token) => { writeTokenAndAdvanceAccessContext(db, cipher, token, clock.now().toISOString()); },
  });
  const result = (ok: boolean, error: TokenOperationResult['error'] = null): TokenOperationResult => ({ ok, state, error });
  const verify = async (token: string): Promise<TokenOperationResult> => {
    const checked = await verifier.verify(token);
    state = checked.ok && state === 'awaiting_confirmation' ? 'awaiting_confirmation' : checked.ok ? 'completed' : 'failed';
    return result(checked.ok, checked.error);
  };
  const save = async (token: string): Promise<TokenOperationResult> => {
    // 首次配置专用：已有令牌必须走 begin / confirm / cancel，不能直接保存绕过确认。
    if (readToken(db, cipher) !== null) {
      state = 'idle';
      return result(false, { kind: 'unknown', message: '访问令牌已配置，请通过确认更换流程更新令牌' });
    }
    const checked = await verifier.save(token);
    state = checked.ok ? 'completed' : 'failed';
    return result(checked.ok, checked.error);
  };
  const beginReplace = (): TokenOperationResult => {
    const started = replacement.begin();
    state = started.state;
    return started;
  };
  const confirmReplace = async (token: string): Promise<TokenOperationResult> => {
    const checked = await replacement.confirm(token);
    state = checked.state;
    return checked;
  };
  const cancelReplace = (): TokenOperationResult => {
    const cancelled = replacement.cancel();
    state = cancelled.state;
    return cancelled;
  };
  const updateSettings = (patch: unknown): SettingsState => {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return { preferences: readPreferences(db), accessTokenConfigured: readToken(db, cipher) !== null };
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value !== 'string') return { preferences: readPreferences(db), accessTokenConfigured: readToken(db, cipher) !== null };
      cleaned[key] = value;
    }
    writePreferences(db, cleaned);
    return { preferences: readPreferences(db), accessTokenConfigured: readToken(db, cipher) !== null };
  };
  return {
    readAccessToken: () => readToken(db, cipher),
    accessTokenConfigured: () => readToken(db, cipher) !== null,
    verify,
    save,
    beginReplace,
    confirmReplace,
    cancelReplace,
    getSettings: () => ({ preferences: readPreferences(db), accessTokenConfigured: readToken(db, cipher) !== null }),
    updateSettings,
    accessContextRevision: () => readAccessContextRevision(db),
    advanceAccessContext: (updatedAt: string) => advanceAccessContextRevision(db, updatedAt),
    cleanupState: (): TokenCleanupState => {
      const revision = readCleanupIntent(db);
      return { pending: revision !== null, accessContextRevision: revision ?? readAccessContextRevision(db) };
    },
    completeCleanup: (accessContextRevision: number) => clearCleanupIntent(db, accessContextRevision),
  };
}
