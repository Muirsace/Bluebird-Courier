import { describe, expect, it } from 'vitest';
import { normalizeRepositoryIdentity } from '../../src/domain/rules/repository-identity';

describe('仓库身份规范化', () => {
  it('接受 owner/repo、HTTPS 与 SSH 根地址并生成统一身份', () => {
    expect(normalizeRepositoryIdentity(' https://github.com/OpenAI/Codex.git/ ')).toEqual({
      ok: true,
      owner: 'OpenAI',
      name: 'Codex',
      fullName: 'OpenAI/Codex',
    });
    expect(normalizeRepositoryIdentity('git@github.com:OpenAI/Codex.git')).toMatchObject({ ok: true, fullName: 'OpenAI/Codex' });
    expect(normalizeRepositoryIdentity('OpenAI/Codex')).toMatchObject({ ok: true, fullName: 'OpenAI/Codex' });
  });

  it('拒绝仓库子页面、查询参数、额外路径段和其他主机', () => {
    for (const value of [
      'https://github.com/owner/repo/issues',
      'https://github.com/owner/repo?tab=readme',
      'https://github.com/owner/repo#readme',
      'https://example.com/owner/repo',
      'owner/repo/issues',
    ]) {
      expect(normalizeRepositoryIdentity(value).ok, value).toBe(false);
    }
  });
});
