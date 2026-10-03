import type { GitHubPort } from '../../../../domain/ports';
import type { SettingsState } from '../../../../domain/types';
import type { CipherBox } from '../../../core/infra/encryption';
import type { LocalDatabase } from '../../../core/infra/database';
import type { Logger } from '../../../core/infra/logger';
import type { TokenChangeState, TokenOperationResult, TokenSettingsService } from '../contract';
import { createReplaceTokenController } from './replace-token';
import { readPreferences, readToken, writePreferences } from './token-store';
import { createTokenVerifier } from './verify-token';

export interface TokenSettingsDependencies { db: LocalDatabase; cipher: CipherBox; github: GitHubPort; logger?: Logger }

export function createTokenSettingsService({ db, cipher, github, logger }: TokenSettingsDependencies): TokenSettingsService {
  let state: TokenChangeState = 'idle';
  const verifier = createTokenVerifier({ db, cipher, github, logger });
  const replacement = createReplaceTokenController(verifier.save);
  const result = (ok: boolean, error: TokenOperationResult['error'] = null): TokenOperationResult => ({ ok, state, error });
  const verify = async (token: string): Promise<TokenOperationResult> => {
    const checked = await verifier.verify(token);
    state = checked.ok && state === 'awaiting_confirmation' ? 'awaiting_confirmation' : checked.ok ? 'completed' : 'failed';
    return result(checked.ok, checked.error);
  };
  const save = async (token: string): Promise<TokenOperationResult> => {
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
  };
}
