export type RepositoryIdentityResult =
  | { ok: true; owner: string; name: string; fullName: string }
  | { ok: false; message: string };

const FORMAT_ERROR = '仓库名格式应为 owner/repo 或 GitHub 仓库根网址';
const HOST_ERROR = '仅支持 github.com 的仓库地址';
const PART = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

function invalid(message = FORMAT_ERROR): RepositoryIdentityResult {
  return { ok: false, message };
}

function identity(owner: string, rawName: string): RepositoryIdentityResult {
  const name = rawName.replace(/\.git$/i, '');
  if (!PART.test(owner) || !PART.test(name) || owner.length > 39 || name.length > 100 || name.endsWith('.')) return invalid();
  return { ok: true, owner, name, fullName: `${owner}/${name}` };
}

/** 解析 GitHub 仓库根地址或 owner/repo，并生成稳定的仓库全名。 */
export function normalizeRepositoryIdentity(input: string): RepositoryIdentityResult {
  const text = input.trim();
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(text);
  if (ssh) return identity(ssh[1] ?? '', ssh[2] ?? '');
  if (/^git@/i.test(text)) return invalid(HOST_ERROR);

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return invalid();
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return invalid();
    if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) return invalid(HOST_ERROR);
    if (url.username || url.password || url.port || url.search || url.hash) return invalid();
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2 || url.pathname.replace(/\/$/, '').split('/').length !== 3) return invalid();
    return identity(segments[0] ?? '', segments[1] ?? '');
  }

  if (text.includes('?') || text.includes('#')) return invalid();
  const direct = /^([^/\s]+)\/([^/\s]+)$/.exec(text);
  if (!direct) return invalid();
  return identity(direct[1] ?? '', direct[2] ?? '');
}
