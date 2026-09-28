import type { OpenExternalResult } from '../shared/types';

/**
 * 在系统默认浏览器里打开 GitHub 页面。主进程是最终信任边界：
 * 渲染层送来的目标可能被篡改（类型在运行期被擦除），所以这里既构造 URL 也再校验一遍，
 * 只有 https + host 恰为 github.com 的地址才会交给 shell.openExternal。
 * 绝不让 BrowserWindow 自己导航——应用窗口永远不离开应用。
 */
const GITHUB_HOST = 'github.com';
const GITHUB_ORIGIN = `https://${GITHUB_HOST}`;

/** owner / name 的合法字符：GitHub 实际只允许字母数字与 . - _，逐段校验即挡掉 ../ 之类的路径拼接。 */
const SEGMENT = /^[A-Za-z0-9._-]+$/;
/** 提交 SHA：接口给的是 40 位，缩短写法 7 位起；只认十六进制。 */
const SHA = /^[0-9a-f]{7,40}$/i;
/** 构建外链必须是精确的单次 Actions run 路径；拒绝额外路径和非正整数 run id。 */
const ACTIONS_RUN_PATH = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/actions\/runs\/([1-9]\d*)$/;
/** 先匹配原始 URL，避免 URL parser 归一化掉 dot segments 后误收额外路径。 */
const ACTIONS_RUN_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/actions\/runs\/([1-9]\d*)$/;

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

/** build.url 来自 GitHub html_url，但仍必须匹配当前仓库的单次 Actions run。 */
function buildActionsRunUrl(raw: unknown, owner: string, name: string): string | null {
  if (typeof raw !== 'string' || !isAllowedExternalUrl(raw)) return null;
  const rawMatch = ACTIONS_RUN_URL.exec(raw);
  if (!rawMatch) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const match = ACTIONS_RUN_PATH.exec(url.pathname);
  if (
    !match ||
    match[1]?.toLowerCase() !== owner.toLowerCase() ||
    match[2]?.toLowerCase() !== name.toLowerCase() ||
    rawMatch[3] !== match[3]
  ) {
    return null;
  }

  // 只把经过验证的 run id 带入规范 URL，不透传 GitHub 返回的原始字符串。
  return `${GITHUB_ORIGIN}/${owner}/${name}/actions/runs/${match[3]}`;
}

/** 目标 → URL；目标有任何一个字段不合法就返回 null，绝不拼接可疑片段。 */
export function buildGitHubUrl(target: unknown): string | null {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return null;
  const { kind, owner, name } = target as Record<string, unknown>;

  if (kind === 'build') {
    const { url } = target as Record<string, unknown>;
    if (!isSegment(owner) || !isSegment(name)) return null;
    return buildActionsRunUrl(url, owner, name);
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
