import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';

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
});
