/** 输入归一化结果：成功给出 owner/name，失败给出面向用户的提示。 */
export type RepoInputResult =
  | { ok: true; owner: string; name: string }
  | { ok: false; message: string };

const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\//i;
const GITHUB_SSH = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i;
const OWNER_REPO = /^([^\s/]+)\/([^\s/]+)$/;
const ANY_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const ANY_SSH = /^git@/i;
const FORMAT_ERROR = '仓库名格式应为 owner/repo 或 GitHub 仓库网址';
const HOST_ERROR = '仅支持 github.com 的仓库地址';

/** 归一 owner/name：name 去掉 .git 克隆后缀。 */
function identity(owner: string, name: string): RepoInputResult {
  const cleanName = name.replace(/\.git$/i, '');
  if (!owner || !cleanName) return { ok: false, message: FORMAT_ERROR };
  return { ok: true, owner, name: cleanName };
}

/** 把用户输入的监控仓库标识归一为 owner/name（GitHub 网址或 owner/repo）。 */
export function parseRepoInput(input: string): RepoInputResult {
  const text = input.trim();
  if (GITHUB_URL.test(text)) {
    // 网址只取路径前两段：深层路径（/tree/...、/pull/12 等）、尾斜杠、query/fragment 都归一到仓库
    const [owner = '', name = ''] = new URL(text).pathname.split('/').filter(Boolean);
    return identity(owner, name);
  }
  const ssh = GITHUB_SSH.exec(text);
  if (ssh) return identity(ssh[1] ?? '', ssh[2] ?? '');
  // 地址形态但不是 GitHub：明确拒绝，绝不误当成 owner/name 去抓取
  if (ANY_URL.test(text) || ANY_SSH.test(text)) return { ok: false, message: HOST_ERROR };
  const direct = OWNER_REPO.exec(text);
  if (direct) return identity(direct[1] ?? '', direct[2] ?? '');
  return { ok: false, message: FORMAT_ERROR };
}
