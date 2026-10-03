import type { GitHubHttpClient } from './github-http-client';

/** GitHub 用户端点对应的 Token 校验领域端口。 */
export function createGitHubTokenAdapter(client: GitHubHttpClient): { validateAccessToken(accessToken: string): Promise<void> } {
  return {
    validateAccessToken: (accessToken) => client.request(accessToken, '/user', () => undefined),
  };
}
