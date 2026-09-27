import { describe, expect, it, vi } from 'vitest';
import { buildGitHubUrl, isAllowedExternalUrl, openGitHubExternal } from '../../src/main/shell-links';

/**
 * 主进程外链守卫：渲染层送来的目标在运行期不可信（类型被擦除），
 * 所以这里既要验证每条构造规则，也要验证非法目标绝不触达 shell.openExternal。
 */

describe('buildGitHubUrl：GitHub 实体 → URL', () => {
  it('仓库：owner/name 直接拼接', () => {
    expect(buildGitHubUrl({ kind: 'repository', owner: 'octo', name: 'Hello-World' })).toBe(
      'https://github.com/octo/Hello-World',
    );
  });

  it('发版：tag 整段 encode（含 / 与 +，如 release/v1.0+hotfix）', () => {
    expect(buildGitHubUrl({ kind: 'release', owner: 'octo', name: 'Hello-World', tagName: 'v1.0.0' })).toBe(
      'https://github.com/octo/Hello-World/releases/tag/v1.0.0',
    );
    expect(
      buildGitHubUrl({ kind: 'release', owner: 'octo', name: 'Hello-World', tagName: 'release/v1.0+hotfix' }),
    ).toBe('https://github.com/octo/Hello-World/releases/tag/release%2Fv1.0%2Bhotfix');
  });

  it('提交：只接受十六进制 SHA（7~40 位）', () => {
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    expect(buildGitHubUrl({ kind: 'commit', owner: 'octo', name: 'Hello-World', sha })).toBe(
      `https://github.com/octo/Hello-World/commit/${sha}`,
    );
    expect(buildGitHubUrl({ kind: 'commit', owner: 'octo', name: 'Hello-World', sha: 'a1b2c3d' })).toBe(
      'https://github.com/octo/Hello-World/commit/a1b2c3d',
    );
  });

  it('议题与合并请求：编号必须为正整数，路径分别是 /issues 与 /pull', () => {
    expect(buildGitHubUrl({ kind: 'issue', owner: 'octo', name: 'Hello-World', number: 42 })).toBe(
      'https://github.com/octo/Hello-World/issues/42',
    );
    expect(buildGitHubUrl({ kind: 'pull', owner: 'octo', name: 'Hello-World', number: 7 })).toBe(
      'https://github.com/octo/Hello-World/pull/7',
    );
  });

  it('构建：Actions 页面地址由接口给出，透传的也必须是 github.com 的 https 地址', () => {
    expect(buildGitHubUrl({ kind: 'build', url: 'https://github.com/octo/Hello-World/actions/runs/123' })).toBe(
      'https://github.com/octo/Hello-World/actions/runs/123',
    );
    expect(buildGitHubUrl({ kind: 'build', url: 'https://evil.example/actions/runs/123' })).toBeNull();
    expect(buildGitHubUrl({ kind: 'build', url: 'http://github.com/octo/Hello-World/actions' })).toBeNull();
  });
});

describe('buildGitHubUrl：非法目标一律返回 null', () => {
  const rejected: Array<[string, unknown]> = [
    ['http 协议', { kind: 'build', url: 'http://github.com/octo/Hello-World' }],
    ['其他域名', { kind: 'build', url: 'https://evil.example/octo/Hello-World' }],
    ['javascript 伪协议', { kind: 'build', url: 'javascript:alert(1)' }],
    ['file 伪协议', { kind: 'build', url: 'file:///C:/Windows/System32/calc.exe' }],
    ['data 伪协议', { kind: 'build', url: 'data:text/html,<script>alert(1)</script>' }],
    ['前缀伪装域名', { kind: 'build', url: 'https://github.com.evil.example/octo/Hello-World' }],
    ['非默认端口', { kind: 'build', url: 'https://github.com:8443/octo/Hello-World' }],
    ['URL 内嵌凭据', { kind: 'build', url: 'https://user:pass@github.com/octo/Hello-World' }],
    ['owner 含路径分隔符', { kind: 'repository', owner: '../..', name: 'Hello-World' }],
    ['name 含斜杠', { kind: 'repository', owner: 'octo', name: 'a/../b' }],
    ['owner 含空格', { kind: 'repository', owner: 'oct o', name: 'Hello-World' }],
    ['owner 为空', { kind: 'repository', owner: '', name: 'Hello-World' }],
    ['tag 为空串', { kind: 'release', owner: 'octo', name: 'Hello-World', tagName: '' }],
    ['sha 不是十六进制', { kind: 'commit', owner: 'octo', name: 'Hello-World', sha: 'main' }],
    ['编号为 0', { kind: 'issue', owner: 'octo', name: 'Hello-World', number: 0 }],
    ['编号为负', { kind: 'pull', owner: 'octo', name: 'Hello-World', number: -1 }],
    ['编号是小数', { kind: 'issue', owner: 'octo', name: 'Hello-World', number: 1.5 }],
    ['编号是字符串', { kind: 'issue', owner: 'octo', name: 'Hello-World', number: '1' }],
    ['未知 kind', { kind: 'shell', owner: 'octo', name: 'Hello-World' }],
    ['缺 kind', { owner: 'octo', name: 'Hello-World' }],
    ['字符串入参', 'https://github.com/octo/Hello-World'],
    ['数组入参', ['repository']],
    ['null', null],
    ['undefined', undefined],
  ];

  for (const [label, target] of rejected) {
    it(`拒绝：${label}`, () => {
      expect(buildGitHubUrl(target)).toBeNull();
    });
  }
});

describe('isAllowedExternalUrl：只放行 https + github.com', () => {
  it('允许 github.com 的 https 地址', () => {
    expect(isAllowedExternalUrl('https://github.com/octo/Hello-World')).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/octo/Hello-World/issues/1')).toBe(true);
  });

  it('大小写不敏感地认主机名（浏览器等价于 github.com）', () => {
    expect(isAllowedExternalUrl('https://GitHub.com/octo/Hello-World')).toBe(true);
  });

  const rejected = [
    'http://github.com/octo/Hello-World',
    'https://evil.example/octo/Hello-World',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hi',
    'https://github.com.evil.example/octo/Hello-World',
    'https://github.com:8443/octo/Hello-World',
    'https://user:pass@github.com/octo/Hello-World',
    'github.com/octo/Hello-World',
  ];

  for (const url of rejected) {
    it(`拒绝：${url}`, () => {
      expect(isAllowedExternalUrl(url)).toBe(false);
      expect(buildGitHubUrl({ kind: 'build', url })).toBeNull();
    });
  }

  it('拒绝非字符串', () => {
    expect(isAllowedExternalUrl(undefined)).toBe(false);
    expect(isAllowedExternalUrl(42)).toBe(false);
  });
});

describe('openGitHubExternal：非法目标绝不触达系统', () => {
  it('合法目标交给注入的 open，并把 URL 原样传出', async () => {
    const open = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    await expect(
      openGitHubExternal({ kind: 'issue', owner: 'octo', name: 'Hello-World', number: 1 }, open),
    ).resolves.toEqual({ ok: true, reason: null });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://github.com/octo/Hello-World/issues/1');
  });

  it('非法目标连 open 都不调用，返回 invalid_target', async () => {
    const open = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    for (const target of [
      { kind: 'build', url: 'https://evil.example/x' },
      { kind: 'build', url: 'javascript:alert(1)' },
      { kind: 'repository', owner: 'octo', name: '../../etc/passwd' },
      { kind: 'commit', owner: 'octo', name: 'Hello-World', sha: 'not-a-sha' },
    ]) {
      await expect(openGitHubExternal(target, open)).resolves.toEqual({ ok: false, reason: 'invalid_target' });
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('系统打不开时如实回报 open_failed（不假装成功）', async () => {
    const open = vi.fn<(url: string) => Promise<void>>().mockRejectedValue(new Error('no browser'));
    await expect(
      openGitHubExternal({ kind: 'repository', owner: 'octo', name: 'Hello-World' }, open),
    ).resolves.toEqual({ ok: false, reason: 'open_failed' });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
