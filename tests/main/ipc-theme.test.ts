import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BluebirdCourierFacade, SettingsView } from '../../src/shared/types';
import { IPC_CHANNELS } from '../../src/shared/ipc';

const state = vi.hoisted(() => ({ handlers: new Map() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(channel, handler),
  },
}));

import { registerIpc } from '../../src/main/ipc';

type IpcHandler = (_event: unknown, ...args: unknown[]) => unknown;

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = state.handlers.get(channel) as IpcHandler | undefined;
  if (!handler) throw new Error(`IPC handler was not registered: ${channel}`);
  return handler({}, ...args);
}

describe('theme appearance IPC', () => {
  beforeEach(() => state.handlers.clear());

  it('applies a valid preference while persistence is pending and never reapplies it after save', async () => {
    let finishSave!: (view: SettingsView) => void;
    const facade = {
      updateSettings: vi.fn(() => new Promise<SettingsView>((resolve) => { finishSave = resolve; })),
    } as unknown as BluebirdCourierFacade;
    const applyTheme = vi.fn();
    registerIpc(facade, {
      openGitHubExternal: vi.fn(),
      applyTheme,
    });

    const pendingSave = invoke(IPC_CHANNELS.updateSettings, { theme: 'dark' }) as Promise<SettingsView>;
    expect(invoke(IPC_CHANNELS.setThemePreference, 'dark')).toBeUndefined();
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(applyTheme).toHaveBeenCalledWith('dark');

    finishSave({ preferences: { theme: 'dark' }, accessTokenConfigured: true });
    await expect(pendingSave).resolves.toEqual({ preferences: { theme: 'dark' }, accessTokenConfigured: true });
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('ignores values outside the three supported theme preferences', async () => {
    const facade = {} as BluebirdCourierFacade;
    const applyTheme = vi.fn();
    registerIpc(facade, { openGitHubExternal: vi.fn(), applyTheme });

    expect(invoke(IPC_CHANNELS.setThemePreference, 'neon')).toBeUndefined();
    expect(applyTheme).not.toHaveBeenCalled();
  });
});
