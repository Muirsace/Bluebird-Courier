import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/main/core/infra/database';
import { createTokenSettings } from '../../src/main/features/token-settings/implementation/create';
import { createHarness, type Harness } from '../helpers/harness';
import { FakeGitHub } from '../helpers/fake-github';
import { FakeCipherBox } from '../helpers/fakes';

let harness: Harness | null = null;

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

afterEach(() => {
  harness?.destroy();
  harness = null;
});

describe('Token 设置 feature', () => {
  it('偏好项写入后可读回并持久化', async () => {
    harness = createHarness();
    await h().facade.saveAccessToken('ghp_valid_token');

    const updated = await h().facade.updateSettings({ theme: 'dark', locale: 'zh-CN' });
    expect(updated.preferences).toEqual({ theme: 'dark', locale: 'zh-CN' });
    expect(updated.accessTokenConfigured).toBe(true);

    const reopened = h().reopen();
    expect((await reopened.facade.getSettings()).preferences).toEqual({ theme: 'dark', locale: 'zh-CN' });
  });

  it('偏好项按键覆盖写入', async () => {
    harness = createHarness();
    await h().facade.updateSettings({ theme: 'dark' });
    await h().facade.updateSettings({ theme: 'light' });

    expect((await h().facade.getSettings()).preferences).toEqual({ theme: 'light' });
  });

  it('设置视图反映访问令牌配置状态', async () => {
    harness = createHarness();
    expect((await h().facade.getSettings()).accessTokenConfigured).toBe(false);

    await h().facade.saveAccessToken('ghp_valid_token');
    expect((await h().facade.getSettings()).accessTokenConfigured).toBe(true);

    const reopened = h().reopen();
    expect((await reopened.facade.getSettings()).accessTokenConfigured).toBe(true);
  });

  it('访问上下文版本：初始 0，推进后持久化递增（时间由调用方提供）', () => {
    // facade 尚未暴露访问上下文用例（步骤 9/10 接入），这里直接构造 token 服务验证原语
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-access-context-'));
    const db = openDatabase(path.join(directory, 'app.db'));
    try {
      const service = createTokenSettings({ db, cipher: new FakeCipherBox(), github: new FakeGitHub(), clock: { now: () => new Date('2026-10-07T08:00:00.000Z') } });
      expect(service.accessContextRevision()).toBe(0);

      expect(service.advanceAccessContext('2026-10-06T08:00:00.000Z')).toBe(1);
      expect(service.advanceAccessContext('2026-10-06T09:00:00.000Z')).toBe(2);
      expect(service.accessContextRevision()).toBe(2);

      expect(db.prepare('SELECT revision, updated_at FROM access_context WHERE id = 1').get()).toEqual({
        revision: 2,
        updated_at: '2026-10-06T09:00:00.000Z',
      });
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
