/**
 * Cross-process contracts. Domain values are re-exported where their shape is
 * already transport-neutral; wire-only types stay here at the process seam.
 */
import type { BuildInfo as DomainBuildInfo, Detail as DomainDetail } from '../domain/types';

export type {
  BuildStatus,
  CommitItem,
  EffectiveTheme,
  ErrorKind,
  ExternalLinkBridge,
  FetchedGlance,
  GitHubExternalTarget,
  Glance,
  GlanceValues,
  IssueItem,
  NormalizedError,
  OpenExternalResult,
  PullRequestItem,
  ReleaseItem,
  RepoInputResult,
  SettingsState,
  Snapshot,
  ThemePreference,
} from '../domain/types';

export const THEME_PREFERENCE_KEY = 'theme';
export const THEME_PREFERENCES: readonly import('../domain/types').ThemePreference[] = ['system', 'light', 'dark'];

/** Wire representation retains the provider's result description as `conclusion`. */
export type BuildInfo = Omit<DomainBuildInfo, 'resultDescription'> & { conclusion: string | null };

/** Wire detail uses the wire build DTO while all other fields remain domain values. */
export type Detail = Omit<DomainDetail, 'build'> & { build: BuildInfo };

export interface AccessTokenState {
  configured: boolean;
}

export interface AccessTokenResult {
  ok: boolean;
  error: import('../domain/types').NormalizedError | null;
}

export interface AddRepositoryResult {
  ok: boolean;
  repository: import('../domain/types').Glance | null;
  error: import('../domain/types').NormalizedError | null;
}

export interface RefreshGlanceResult {
  repositories: import('../domain/types').Glance[];
  errors: import('../domain/types').NormalizedError[];
}

export interface DetailResult {
  detail: Detail | null;
  error: import('../domain/types').NormalizedError | null;
}

/** Settings state is a domain value and remains the wire view unchanged. */
export type SettingsView = import('../domain/types').SettingsState;

/** Renderer-facing use-case facade. */
export interface BluebirdCourierFacade {
  accessTokenState(): Promise<AccessTokenState>;
  validateAccessToken(accessToken: string): Promise<AccessTokenResult>;
  saveAccessToken(accessToken: string): Promise<AccessTokenResult>;
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: Record<string, string>): Promise<SettingsView>;
  listRepositories(): Promise<import('../domain/types').Glance[]>;
  addRepository(fullName: string): Promise<AddRepositoryResult>;
  inspectRepositoryInput(input: string): Promise<import('../domain/types').RepoInputResult>;
  removeRepository(repositoryId: number): Promise<void>;
  refreshGlance(): Promise<RefreshGlanceResult>;
  fetchDetail(repositoryId: number): Promise<DetailResult>;
}

export type BluebirdCourierBridge = BluebirdCourierFacade & import('../domain/types').ExternalLinkBridge;
