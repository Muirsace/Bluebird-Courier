import type { RepositoryCapabilities } from '../../../domain/types';

/** 只有仓库元信息明确给出的布尔值才能确认能力；端点错误不提供禁用证据。 */
export function repositoryCapabilities(repo: { has_issues?: unknown; has_pull_requests?: unknown }): RepositoryCapabilities {
  const availability = (value: unknown) => value === false ? 'disabled' as const : value === true ? 'enabled' as const : 'unknown' as const;
  return { issues: availability(repo.has_issues), pullRequests: availability(repo.has_pull_requests) };
}
