import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BluebirdCourierFacade, LocalReadResult } from '../../src/shared/types';

/**
 * 主进程 IPC 注册回归（任务 01）：不只比对 preload 字符串，
 * 而是用假的 ipcMain 实际执行 registerIpc，检查每个命名通道都真正注册，
 * 并验证展示确认 / 本地读取通道把参数转发给门面、结果原样返回。
 */

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(channel, handler),
  },
}));

import { registerIpc } from '../../src/main/ipc';
import { IPC_CHANNELS } from '../../src/shared/ipc';

type IpcHandler = (_event: unknown, ...args: unknown[]) => unknown;

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = state.handlers.get(channel);
  if (!handler) throw new Error(`IPC handler was not registered: ${channel}`);
  return handler({}, ...args);
}

/** 全量假门面：每个方法都有可断言的调用记录；直接按契约类型装配，缺方法会在编译期暴露。 */
function fakeFacade() {
  const calls = {
    accessTokenState: vi.fn(async () => ({ configured: false })),
    validateAccessToken: vi.fn(async () => ({ ok: true, error: null })),
    saveAccessToken: vi.fn(async () => ({ ok: true, error: null })),
    beginTokenReplacement: vi.fn(async () => ({ ok: true, state: 'idle' as const, error: null })),
    confirmTokenReplacement: vi.fn(async () => ({ ok: true, state: 'idle' as const, error: null })),
    cancelTokenReplacement: vi.fn(async () => ({ ok: true, state: 'idle' as const, error: null })),
    getSettings: vi.fn(async () => ({ preferences: {}, accessTokenConfigured: false })),
    updateSettings: vi.fn(async () => ({ preferences: {}, accessTokenConfigured: false })),
    inspectRepositoryInput: vi.fn(async () => ({ ok: false as const, message: 'stub' })),
    listRepositories: vi.fn(async () => []),
    addRepository: vi.fn(async () => ({ ok: false, repository: null, error: null })),
    removeRepository: vi.fn(async () => undefined),
    refreshGlance: vi.fn(async () => ({ repositories: [], errors: [] })),
    refreshRepository: vi.fn(async () => ({ detail: null, error: null })),
    fetchDetail: vi.fn(async () => ({ detail: null, error: null })),
    readLocalDetail: vi.fn(async (repositoryId: number): Promise<LocalReadResult> => ({
      repositoryId, viewVersion: 0, detailViewVersion: 0, accessContextRevision: 0, detail: null, columns: {},
      syncState: {}, task: null, truncated: false, summaryFetchedAt: null, detailFetchedAt: null, error: null,
    })),
    acknowledgeRepositoryViewed: vi.fn(async () => ({ ok: true, seenRevision: 0 })),
    loadHistory: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    trend: vi.fn(async (repositoryId: number) => ({ repositoryId, points: [] })),
  };
  const facade: BluebirdCourierFacade = calls;
  return { facade, calls };
}

describe('IPC 注册与转发（展示确认 / 本地读取）', () => {
  beforeEach(() => state.handlers.clear());

  it('每个命名通道都在主进程实际注册（不依赖 preload 字符串）', () => {
    const { facade } = fakeFacade();
    registerIpc(facade, { openGitHubExternal: vi.fn(), applyTheme: vi.fn() });
    expect([...state.handlers.keys()].sort()).toEqual([...Object.values(IPC_CHANNELS)].sort());
  });

  it('每个业务通道转发到对应门面方法（实际注册 + 逐通道对应）', () => {
    const { facade, calls } = fakeFacade();
    registerIpc(facade, { openGitHubExternal: vi.fn(), applyTheme: vi.fn() });
    for (const method of Object.keys(calls) as Array<keyof typeof calls>) {
      invoke(IPC_CHANNELS[method], 1, {});
      expect(calls[method], `通道 ${method}`).toHaveBeenCalledTimes(1);
    }
  });

  it('展示确认通道：仓库标识与确认数据转发给门面，结果原样返回', async () => {
    const { facade, calls } = fakeFacade();
    calls.acknowledgeRepositoryViewed.mockResolvedValue({ ok: true, seenRevision: 2 });
    registerIpc(facade, { openGitHubExternal: vi.fn(), applyTheme: vi.fn() });
    const acknowledgment = { detailViewVersion: 7, accessContextRevision: 0, scopes: ['overview', 'commits'] };

    const result = await invoke(IPC_CHANNELS.acknowledgeRepositoryViewed, 42, acknowledgment);

    expect(calls.acknowledgeRepositoryViewed).toHaveBeenCalledWith(42, acknowledgment);
    expect(result).toEqual({ ok: true, seenRevision: 2 });
  });

  it('本地读取与强制同步通道同样注册并原样转发', async () => {
    const { facade, calls } = fakeFacade();
    registerIpc(facade, { openGitHubExternal: vi.fn(), applyTheme: vi.fn() });
    const request = { mode: 'status' as const };

    await invoke(IPC_CHANNELS.readLocalDetail, 7, request);
    await invoke(IPC_CHANNELS.refreshRepository, 7, true);

    expect(calls.readLocalDetail).toHaveBeenCalledWith(7, request);
    expect(calls.refreshRepository).toHaveBeenCalledWith(7, true);
  });

  it('平台通道（主题 / 外链）走注入处理器，不经过业务门面', () => {
    const { facade } = fakeFacade();
    const openGitHubExternal = vi.fn(async () => ({ ok: true, reason: null }));
    const applyTheme = vi.fn();
    registerIpc(facade, { openGitHubExternal, applyTheme });

    invoke(IPC_CHANNELS.setThemePreference, 'dark');
    invoke(IPC_CHANNELS.openGitHubExternal, { kind: 'repository', owner: 'a', name: 'b' });

    expect(applyTheme).toHaveBeenCalledWith('dark');
    expect(openGitHubExternal).toHaveBeenCalledOnce();
  });
});
