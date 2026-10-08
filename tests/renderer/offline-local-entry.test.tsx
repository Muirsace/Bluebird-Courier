// @vitest-environment happy-dom
import { onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenOperationResult } from '../../src/shared/types';
import {
  buttonByText, click, createStub, makeGlance, renderApp, repoOpenButton, resetSystemTheme, setViewportWidth, settle,
  type RenderResult,
} from './helpers';

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

  it('离线时持久清理意图仍可读，也能执行本地清理重试（无网络校验）', async () => {
    onlineManager.setOnline(false);
    setViewportWidth(1152);
    const stub = createStub({ repositories: [] });
    stub.api.accessTokenState = async () => ({ configured: true, cleanupPending: true, accessContextRevision: 4 });
    const confirmed: string[] = [];
    let began = 0;
    stub.api.beginTokenReplacement = async () => {
      began += 1;
      return { ok: true, state: 'awaiting_confirmation', error: null };
    };
    stub.api.confirmTokenReplacement = async (token: string): Promise<TokenOperationResult> => {
      confirmed.push(token);
      stub.api.accessTokenState = async () => ({ configured: true, cleanupPending: false, accessContextRevision: 4 });
      return { ok: true, state: 'completed', error: null, tokenCommitted: true, cleanupPending: false, accessContextRevision: 4 };
    };
    stub.api.cancelTokenReplacement = async () => ({ ok: true, state: 'idle', error: null });

    view = await renderApp(stub);
    await settle();

    // networkMode:'always'：真正离线也要读到 pending 并给出恢复入口
    expect(document.querySelector('.settings-cleanup-pending')).not.toBeNull();
    expect(buttonByText('重试清理')).not.toBeNull();

    await click(buttonByText('重试清理'));
    await settle();

    // 本地清理重试不经网络校验、也不重新登记更换
    expect(confirmed).toEqual(['']);
    expect(began).toBe(0);
    expect(stub.calls.validateAccessToken).toBe(0);
    expect(document.querySelector('.settings-cleanup-pending')).toBeNull();
  });
});
