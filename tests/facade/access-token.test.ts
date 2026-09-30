import { describe, it, expect, afterEach } from 'vitest';
import { createSafeStorageCipherBox } from '../../src/main/core/infra/cipher';
import { createHarness, type Harness } from '../helpers/harness';
import { fixtures } from '../helpers/fake-github';

let harness: Harness | null = null;

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

afterEach(() => {
  harness?.destroy();
  harness = null;
});

describe('访问令牌校验与保存', () => {
  it('有效访问令牌校验保存成功，并以密文落库', async () => {
    harness = createHarness();

    const result = await h().facade.saveAccessToken('ghp_valid_token');
    expect(result).toEqual({ ok: true, error: null });
    expect(await h().facade.accessTokenState()).toEqual({ configured: true });

    const row = h()
      .db.prepare("SELECT value FROM setting WHERE key = 'access_token'")
      .get() as { value: string };
    expect(row.value).not.toContain('ghp_valid_token');
    expect(h().cipher.decrypt(row.value)).toBe('ghp_valid_token');
  });

  it('无效访问令牌（401）报访问令牌无效且不落库', async () => {
    harness = createHarness();

    const result = await h().facade.saveAccessToken('ghp_bad');
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: 'access_token_invalid' });
    expect(await h().facade.accessTokenState()).toEqual({ configured: false });

    const row = h().db.prepare("SELECT value FROM setting WHERE key = 'access_token'").get();
    expect(row).toBeUndefined();
  });

  it('校验时网络失败报网络失败且不落库', async () => {
    harness = createHarness();
    h().github.networkDown = true;

    const result = await h().facade.saveAccessToken('ghp_valid_token');
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: 'network' });
    expect(await h().facade.accessTokenState()).toEqual({ configured: false });
  });

  it('校验访问令牌只校验、不落库', async () => {
    harness = createHarness();

    expect(await h().facade.validateAccessToken('ghp_valid_token')).toEqual({ ok: true, error: null });
    expect(await h().facade.accessTokenState()).toEqual({ configured: false });

    h().github.fail('*', 'validateAccessToken', fixtures.unauthorized());
    const bad = await h().facade.validateAccessToken('whatever');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatchObject({ kind: 'access_token_invalid' });
  });

  it('重新保存覆盖旧访问令牌（换令牌后继续用）', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');
    h().github.validAccessToken = 'ghp_replaced_token';

    const result = await h().facade.saveAccessToken('ghp_replaced_token');
    expect(result).toEqual({ ok: true, error: null });

    const row = h()
      .db.prepare("SELECT value FROM setting WHERE key = 'access_token'")
      .get() as { value: string };
    expect(h().cipher.decrypt(row.value)).toBe('ghp_replaced_token');
  });

  it('系统安全存储不可用时保存失败并明示原因，且不落库', async () => {
    harness = createHarness({
      cipher: createSafeStorageCipherBox({
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from('unused'),
        decryptString: () => '',
      }),
    });

    const result = await h().facade.saveAccessToken('ghp_valid_token');

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      kind: 'unknown',
      message: '系统安全存储不可用，无法保存访问令牌',
    });
    expect(await h().facade.accessTokenState()).toEqual({ configured: false });
    expect(h().db.prepare("SELECT value FROM setting WHERE key = 'access_token'").get()).toBeUndefined();
  });
});
