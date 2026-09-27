import type { OpenExternalResult } from '../shared/types';

/**
 * 在系统默认浏览器里打开 GitHub 页面。主进程是最终信任边界：
 * 渲染层送来的目标可能被篡改（类型在运行期被擦除），所以这里既构造 URL 也再校验一遍，
 * 只有 https + host 恰为 github.com 的地址才会交给 shell.openExternal。
 * 绝不让 BrowserWindow 自己导航——OCTO 窗口永远不离开应用。
 */
const GITHUB_HOST = 'github.com';
const GITHUB_ORIGIN = `https://${GITHUB_HOST}`;

/** owner / name 的合法字符：GitHub 实际只允许字母数字与 . - _，逐段校验即挡掉 ../ 之类的路径拼接。 */
const SEGMENT = /^[A-Za-z0-9._-]+$/;
/** 提交 SHA：接口给的是 40 位，缩短写法 7 位起；只认十六进制。 */
const SHA = /^[0-9a-f]{7,40}$/i;

function isSegment(value: unknown): value is string {
  return typeof value === 'string' && SEGMENT.test(value) && value !== '.' && value !== '..';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** 最终信任边界：只放行 https + host 恰为 github.com（github.com.evil.example 不在其列）、无端口与凭据的 URL。 */
export function isAllowedExternalUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === GITHUB_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

/** 目标 → URL；目标有任何一个字段不合法就返回 null，绝不拼接可疑片段。 */
export function buildGitHubUrl(target: unknown): string | null {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return null;
  const { kind, owner, name } = target as Record<string, unknown>;

  if (kind === 'build') {
    // Actions 页面地址来自 GitHub 接口的 html_url，本地没有 run id 可构造，只能透传后再校验
    const { url } = target as Record<string, unknown>;
    return isAllowedExternalUrl(url) ? url : null;
  }

  if (!isSegment(owner) || !isSegment(name)) return null;
  const repository = `${GITHUB_ORIGIN}/${owner}/${name}`;

  switch (kind) {
    case 'repository':
      return repository;
    case 'release': {
      const { tagName } = target as Record<string, unknown>;
      if (typeof tagName !== 'string' || tagName.length === 0) return null;
      // tag 里可能有 / + # 等字符（如 release/v1.0），必须整段 encode
      return `${repository}/releases/tag/${encodeURIComponent(tagName)}`;
    }
    case 'commit': {
      const { sha } = target as Record<string, unknown>;
      if (typeof sha !== 'string' || !SHA.test(sha)) return null;
      return `${repository}/commit/${sha}`;
    }
    case 'issue': {
      const { number } = target as Record<string, unknown>;
      if (!isPositiveInteger(number)) return null;
      return `${repository}/issues/${number}`;
    }
    case 'pull': {
      const { number } = target as Record<string, unknown>;
      if (!isPositiveInteger(number)) return null;
      return `${repository}/pull/${number}`;
    }
    default:
      return null;
  }
}

/**
 * 窄接口实现：目标非法时连 shell 都不碰；打开失败如实回报，不假装成功。
 * open 由调用方注入（生产是 shell.openExternal），测试可断言"非法目标绝不触达系统"。
 */
export async function openGitHubExternal(
  target: unknown,
  open: (url: string) => Promise<void>,
): Promise<OpenExternalResult> {
  const url = buildGitHubUrl(target);
  if (url === null) return { ok: false, reason: 'invalid_target' };
  try {
    await open(url);
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: 'open_failed' };
  }
}
