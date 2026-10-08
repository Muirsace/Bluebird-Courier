import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, type LocalDatabase } from '../../src/main/core/infra/database';
import { SecureStorageUnavailableError, type CipherBox } from '../../src/main/core/infra/encryption';
import { createTokenSettings } from '../../src/main/features/token-settings/implementation/create';
import type { TokenSettingsService } from '../../src/main/features/token-settings/contract';
import { FakeGitHub } from '../helpers/fake-github';
import { FakeCipherBox, FakeClock } from '../helpers/fakes';

interface Rig {
  db: Database.Database;
  github: FakeGitHub;
  cipher: CipherBox;
  clock: FakeClock;
  service: TokenSettingsService;
  /** 挂起下一次令牌网络校验；返回放行函数。 */
  holdNextValidation(): () => void;
  destroy(): void;
}

let rig: Rig | null = null;

afterEach(() => {
  rig?.destroy();
  rig = null;
});

function setup(options: { cipher?: CipherBox; database?: (db: LocalDatabase) => LocalDatabase } = {}): Rig {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-token-'));
  const base = openDatabase(path.join(directory, 'app.db'));
  const db = options.database ? options.database(base) : base;
  const github = new FakeGitHub();
  const cipher = options.cipher ?? new FakeCipherBox();
  const clock = new FakeClock(new Date('2026-10-07T08:00:00.000Z'));
  let validationGate: Promise<void> | null = null;
  const validate = github.validateAccessToken.bind(github);
  github.validateAccessToken = async (token: string) => {
    if (validationGate) await validationGate;
    return await validate(token);
  };
  rig = {
    db: base,
    github,
    cipher,
    clock,
    service: createTokenSettings({ db, cipher, github, clock }),
    holdNextValidation() {
      let release = (): void => {};
      validationGate = new Promise<void>((resolve) => { release = resolve; });
      return () => {
        validationGate = null;
        release();
      };
    },
    destroy() {
      base.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
  return rig;
}

function tokenRow(db: Database.Database): { value: string } | undefined {
  return db.prepare("SELECT value FROM setting WHERE key = 'access_token'").get() as { value: string } | undefined;
}

function contextRow(db: Database.Database): { revision: number; updated_at: string | null } {
  return db.prepare('SELECT revision, updated_at FROM access_context WHERE id = 1').get() as { revision: number; updated_at: string | null };
}

describe('Token 原语：首次保存', () => {
  it('首次保存写入加密令牌，不推进访问上下文', async () => {
    const h = setup();

    const result = await h.service.save('ghp_valid_token');
    expect(result.ok).toBe(true);
    expect(h.service.accessTokenConfigured()).toBe(true);
    expect(h.service.readAccessToken()).toBe('ghp_valid_token');
    expect(h.service.accessContextRevision()).toBe(0);

    const row = tokenRow(h.db);
    expect(row?.value).not.toContain('ghp_valid_token');
    expect(h.cipher.decrypt(row!.value)).toBe('ghp_valid_token');
  });

  it('已配置后直接保存被拒绝，原令牌与上下文不变', async () => {
    const h = setup();
    await h.service.save('ghp_valid_token');
    h.github.validAccessToken = 'ghp_replaced_token';

    const result = await h.service.save('ghp_replaced_token');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('已配置');
    expect(h.service.readAccessToken()).toBe('ghp_valid_token');
    expect(h.service.accessContextRevision()).toBe(0);
    expect(h.github.count('validateAccessToken')).toBe(1);
  });

  it('并行首次保存：迟到的验证不能覆盖已经提交的令牌', async () => {
    const h = setup();
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.github.validateAccessToken = async token => {
      if (token === 'slow-first-token') await gate;
    };

    const slow = h.service.save('slow-first-token');
    expect((await h.service.save('fast-first-token')).ok).toBe(true);
    release();

    expect((await slow).ok).toBe(false);
    expect(h.service.readAccessToken()).toBe('fast-first-token');
    expect(h.service.accessContextRevision()).toBe(0);
  });

  it('首次保存校验失败时不落库、不推进上下文', async () => {
    const h = setup();

    const result = await h.service.save('ghp_bad_token');
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ kind: 'access_token_invalid' });
    expect(h.service.accessTokenConfigured()).toBe(false);
    expect(h.service.accessContextRevision()).toBe(0);
    expect(tokenRow(h.db)).toBeUndefined();
  });

  it('未 begin 直接确认更换被拒绝，不触碰任何状态', async () => {
    const h = setup();

    const result = await h.service.confirmReplace('ghp_valid_token');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('请先确认更换访问令牌');
    expect(h.service.readAccessToken()).toBeNull();
    expect(h.service.accessContextRevision()).toBe(0);
  });
});

describe('Token 原语：确认更换', () => {
  it('验证成功后原子保存新令牌并推进上下文，返回时新版本已可读', async () => {
    const h = setup();
    await h.service.save('ghp_valid_token');
    h.github.validAccessToken = 'ghp_replaced_token';

    expect(h.service.beginReplace().ok).toBe(true);
    const result = await h.service.confirmReplace('ghp_replaced_token');

    expect(result.ok).toBe(true);
    // Promise 返回的当下新版本已经可读，时间来自注入时钟。
    expect(h.service.accessContextRevision()).toBe(1);
    expect(h.service.readAccessToken()).toBe('ghp_replaced_token');
    expect(contextRow(h.db)).toEqual({ revision: 1, updated_at: '2026-10-07T08:00:00.000Z' });
  });

  it('验证失败停在 failed，可直接重新确认，状态机不卡死', async () => {
    const h = setup();
    await h.service.save('ghp_valid_token');

    h.service.beginReplace();
    const failed = await h.service.confirmReplace('ghp_wrong_token');
    expect(failed.ok).toBe(false);
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatchObject({ kind: 'access_token_invalid' });
    expect(h.service.readAccessToken()).toBe('ghp_valid_token');
    expect(h.service.accessContextRevision()).toBe(0);

    // 不重新 begin 也能再次确认：失败不是死状态。
    const retried = await h.service.confirmReplace('ghp_valid_token');
    expect(retried.ok).toBe(true);
    expect(retried.state).toBe('completed');
    expect(h.service.accessContextRevision()).toBe(1);
  });

  it('取消后确认被拒绝；取消不改变原令牌与上下文', async () => {
    const h = setup();
    await h.service.save('ghp_valid_token');

    h.service.beginReplace();
    expect(h.service.cancelReplace().ok).toBe(true);

    const result = await h.service.confirmReplace('ghp_valid_token');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('请先确认更换访问令牌');
    expect(h.service.readAccessToken()).toBe('ghp_valid_token');
    expect(h.service.accessContextRevision()).toBe(0);
  });

  it('取消进行中的确认：迟到的验证结果不提交', async () => {
    const h = setup();
    await h.service.save('ghp_valid_token');
    h.github.validAccessToken = 'ghp_replaced_token';

    h.service.beginReplace();
    const releaseValidation = h.holdNextValidation();
    const pending = h.service.confirmReplace('ghp_replaced_token');
    // 验证在途时用户取消：后端必须真实阻止后续提交，而不只是界面收起。
    h.service.cancelReplace();
    releaseValidation();

    const late = await pending;
    expect(late.ok).toBe(false);
    expect(late.error?.message).toContain('取消');
    expect(h.service.readAccessToken()).toBe('ghp_valid_token');
    expect(h.service.accessContextRevision()).toBe(0);
  });

  it('确认在途时再次 begin 使迟到结果失效', async () => {
    const h = setup();
    await h.service.save('ghp_valid_token');
    h.github.validAccessToken = 'ghp_replaced_token';

    h.service.beginReplace();
    const releaseValidation = h.holdNextValidation();
    const pending = h.service.confirmReplace('ghp_replaced_token');
    expect(h.service.beginReplace().state).toBe('awaiting_confirmation');
    releaseValidation();

    const late = await pending;
    expect(late.ok).toBe(false);
    expect(h.service.readAccessToken()).toBe('ghp_valid_token');
    expect(h.service.accessContextRevision()).toBe(0);
  });

  it('重复确认：进行中的确认拒绝第二次调用，命令只提交一次', async () => {
    const h = setup();
    await h.service.save('ghp_valid_token');
    h.github.validAccessToken = 'ghp_replaced_token';

    h.service.beginReplace();
    const releaseValidation = h.holdNextValidation();
    const first = h.service.confirmReplace('ghp_replaced_token');
    const validationCalls = h.github.count('validateAccessToken');

    const duplicate = await h.service.confirmReplace('ghp_replaced_token');
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error?.message).toContain('进行中');
    expect(h.github.count('validateAccessToken')).toBe(validationCalls);

    releaseValidation();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    expect(h.service.accessContextRevision()).toBe(1);
    // 首次保存 1 次 + 更换确认 1 次；重复调用没有发出第二次验证。
    expect(h.github.count('validateAccessToken')).toBe(2);
  });
});

describe('Token 原语：更换失败与回滚', () => {
  it('安全存储不可用时更换失败：原令牌与上下文保留', async () => {
    class FlakyCipher extends FakeCipherBox {
      failEncrypt = false;
      override encrypt(plain: string): string {
        if (this.failEncrypt) throw new SecureStorageUnavailableError();
        return super.encrypt(plain);
      }
    }
    const cipher = new FlakyCipher();
    const h = setup({ cipher });
    await h.service.save('ghp_valid_token');
    h.github.validAccessToken = 'ghp_replaced_token';
    cipher.failEncrypt = true;

    h.service.beginReplace();
    const result = await h.service.confirmReplace('ghp_replaced_token');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('系统安全存储不可用');
    expect(h.service.readAccessToken()).toBe('ghp_valid_token');
    expect(h.service.accessContextRevision()).toBe(0);
    expect(contextRow(h.db).updated_at).toBeNull();
  });

  it('事务中途失败整体回滚，不留下半提交的新令牌或推进的版本', async () => {
    const h = setup({
      database: (db) =>
        new Proxy(db, {
          get(target, prop) {
            if (prop === 'prepare') {
              return (sql: string) => {
                if (sql.includes('INSERT INTO access_context')) throw new Error('注入的上下文写入失败');
                return target.prepare(sql);
              };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as LocalDatabase,
    });
    await h.service.save('ghp_valid_token');
    h.github.validAccessToken = 'ghp_replaced_token';

    h.service.beginReplace();
    const result = await h.service.confirmReplace('ghp_replaced_token');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('注入的上下文写入失败');
    expect(h.service.readAccessToken()).toBe('ghp_valid_token');
    expect(h.service.accessContextRevision()).toBe(0);
    expect(contextRow(h.db)).toEqual({ revision: 0, updated_at: null });
  });
});
