import type { RepoInputResult } from '../types';

const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\//i;
const GITHUB_SSH = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i;
const OWNER_REPO = /^([^\s/]+)\/([^\s/]+)$/;
const ANY_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const ANY_SSH = /^git@/i;
const FORMAT_ERROR = '仓库名格式应为 owner/repo 或 GitHub 仓库网址';
const HOST_ERROR = '仅支持 github.com 的仓库地址';

function identity(owner: string, name: string): RepoInputResult {
  const cleanName = name.replace(/\.git$/i, '');
  if (!owner || !cleanName) return { ok: false, message: FORMAT_ERROR };
  return { ok: true, owner, name: cleanName };
}

/** Normalize a GitHub URL, SSH clone URL, or owner/repo input. */
export function parseRepoInput(input: string): RepoInputResult {
  const text = input.trim();
  if (GITHUB_URL.test(text)) {
    try {
      const [owner = '', name = ''] = new URL(text).pathname.split('/').filter(Boolean);
      return identity(owner, name);
    } catch {
      return { ok: false, message: FORMAT_ERROR };
    }
  }
  const ssh = GITHUB_SSH.exec(text);
  if (ssh) return identity(ssh[1] ?? '', ssh[2] ?? '');
  if (ANY_URL.test(text) || ANY_SSH.test(text)) return { ok: false, message: HOST_ERROR };
  const direct = OWNER_REPO.exec(text);
  if (direct) return identity(direct[1] ?? '', direct[2] ?? '');
  return { ok: false, message: FORMAT_ERROR };
}
