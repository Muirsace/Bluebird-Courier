/**
 * 发版的类型识别。
 *
 * 当前 domain 只保存 tagName / title / publishedAt（见 shared/types.ts 的 ReleaseItem），
 * 没有 GitHub 的 prerelease / draft 字段，所以这里**不假装**知道 GitHub 的预发布属性：
 * 只对明确写出 alpha / beta / rc 标记的 tag 做保守识别，其余一律返回 null。
 * 特别注意 nightly / canary / dev / snapshot 这类 tag 必须返回 null，
 * 它们不是预发布类型，更不能被当成 Stable。
 */
export type PrereleaseKind = 'alpha' | 'beta' | 'rc';

const PRERELEASE_PATTERNS: ReadonlyArray<{ kind: PrereleaseKind; token: RegExp }> = [
  { kind: 'rc', token: /^rc\d*$/ },
  { kind: 'beta', token: /^beta\d*$/ },
  { kind: 'alpha', token: /^alpha\d*$/ },
];

export const PRERELEASE_LABELS: Record<PrereleaseKind, string> = {
  alpha: 'Alpha',
  beta: 'Beta',
  rc: 'RC',
};

/** 版本标签 → 预发布类型：按分隔符切词后精确匹配 rc / rc1 / beta / beta2 / alpha / alpha.1 这类词。 */
export function classifyReleaseTag(tagName: string | null | undefined): PrereleaseKind | null {
  if (!tagName) return null;
  for (const token of tagName.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!token) continue;
    for (const pattern of PRERELEASE_PATTERNS) {
      if (pattern.token.test(token)) return pattern.kind;
    }
  }
  return null;
}

/** 标题与标签重复（GitHub 上 name === tag_name 很常见）时不重复展示；无标题也返回 null。 */
export function dedupeReleaseTitle(
  title: string | null | undefined,
  tagName: string | null | undefined,
): string | null {
  const value = (title ?? '').trim();
  if (!value) return null;
  if (value.toLowerCase() === (tagName ?? '').trim().toLowerCase()) return null;
  return value;
}
