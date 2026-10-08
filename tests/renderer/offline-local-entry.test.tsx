// @vitest-environment happy-dom
import { onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { createStub, makeGlance, renderApp, repoOpenButton, resetSystemTheme, setViewportWidth, settle, type RenderResult } from './helpers';

let view: RenderResult | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  onlineManager.setOnline(true);
  resetSystemTheme();
  setViewportWidth(768);
});

describe('离线冷启动的本地入口', () => {
  it('Query网络状态离线且无Token时，仍执行本地桥接并显示缓存清单', async () => {
    onlineManager.setOnline(false);
    setViewportWidth(1152);
    const stub = createStub({ repositories: [makeGlance(1, 'owner/offline')] });
    stub.api.accessTokenState = async () => ({ configured: false });
    stub.api.refreshGlance = async () => ({ repositories: [makeGlance(1, 'owner/offline')], errors: [] });
    view = await renderApp(stub);
    await settle();

    expect(stub.calls.listRepositories).toBeGreaterThan(0);
    expect(repoOpenButton('owner/offline')).not.toBeNull();
    expect(stub.calls.fetchDetail).toBe(0);
  });
});
