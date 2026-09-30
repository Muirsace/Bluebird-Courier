import { describe, expect, it } from 'vitest';
import { collectContractViolations } from './analyzer/contracts';
import { collectDependencyViolations } from './analyzer';
import { mergeFiles, requiredSkeleton, withFixture } from './test-utils';

function contractViolations(files: Record<string, string>) {
  return withFixture(files, ({ srcRoot }) => collectContractViolations({ srcRoot, resolver: {} }));
}

describe('architecture cross-process contracts', () => {
  it('accepts the documented bridge name', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': "import { contextBridge } from 'electron'; contextBridge.exposeInMainWorld('bluebirdCourier', { ping: () => true });\n",
      }),
    );
    expect(result).toEqual([]);
  });

  it('rejects preload exposure under another global name', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': "import { contextBridge } from 'electron'; contextBridge.exposeInMainWorld('anythingElse', {});\n",
      }),
    );
    expect(result.some((entry) => entry.code === 'CONTRACT_PRELOAD_EXPOSURE')).toBe(true);
  });

  it('rejects direct exposure of ipcRenderer and generic Electron methods', () => {
    const direct = contractViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': "import { contextBridge, ipcRenderer } from 'electron'; contextBridge.exposeInMainWorld('bluebirdCourier', ipcRenderer);\n",
      }),
    );
    const member = contractViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': "import { contextBridge, ipcRenderer } from 'electron'; contextBridge.exposeInMainWorld('bluebirdCourier', { ipcRenderer, sendSync: ipcRenderer.sendSync });\n",
      }),
    );
    expect(direct.some((entry) => entry.code === 'CONTRACT_PRELOAD_GENERIC_ELECTRON')).toBe(true);
    expect(member.some((entry) => entry.code === 'CONTRACT_PRELOAD_GENERIC_ELECTRON')).toBe(true);
  });

  it('rejects generic invoke and listener methods exposed by the bridge', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': "import { contextBridge, ipcRenderer } from 'electron'; contextBridge.exposeInMainWorld('bluebirdCourier', { invoke: (...args: unknown[]) => ipcRenderer.invoke(...args), on: (...args: unknown[]) => ipcRenderer.on(...args) });\n",
      }),
    );
    expect(result.filter((entry) => entry.code === 'CONTRACT_PRELOAD_GENERIC_ELECTRON')).not.toHaveLength(0);
  });

  it('allows business methods whose names resemble IPC methods when they do not expose Electron objects', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': "import { contextBridge } from 'electron'; contextBridge.exposeInMainWorld('bluebirdCourier', { invoke: () => true, on: () => true });\n",
      }),
    );
    expect(result).toEqual([]);
  });

  it('allows a constrained bridge wrapper around a fixed channel', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': "import { contextBridge, ipcRenderer } from 'electron'; const CHANNELS = { ping: 'ping' }; const bridge = { ping: () => ipcRenderer.invoke(CHANNELS.ping) }; contextBridge.exposeInMainWorld('bluebirdCourier', bridge);\n",
      }),
    );
    expect(result).toEqual([]);
  });

  it('rejects a bridge wrapper that forwards an arbitrary channel', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': "import { contextBridge, ipcRenderer } from 'electron'; const bridge = { invoke: (channel: string) => ipcRenderer.invoke(channel) }; contextBridge.exposeInMainWorld('bluebirdCourier', bridge);\n",
      }),
    );
    expect(result.some((entry) => entry.code === 'CONTRACT_PRELOAD_GENERIC_ELECTRON')).toBe(true);
  });

  it('rejects indirect Electron capability aliases and object spreads', () => {
    const alias = contractViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': "import { contextBridge, ipcRenderer } from 'electron'; const invoke = (...args: unknown[]) => ipcRenderer.invoke(...args); const bridge = { invoke }; contextBridge.exposeInMainWorld('bluebirdCourier', bridge);\n",
      }),
    );
    const spread = contractViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': "import { contextBridge } from 'electron'; const electronApi = {}; const bridge = { ...electronApi }; contextBridge.exposeInMainWorld('bluebirdCourier', bridge);\n",
      }),
    );
    expect(alias.some((entry) => entry.code === 'CONTRACT_PRELOAD_GENERIC_ELECTRON')).toBe(true);
    expect(spread.some((entry) => entry.code === 'CONTRACT_PRELOAD_GENERIC_ELECTRON')).toBe(true);
  });

  it('requires a preload bridge exposure', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, { 'preload/index.ts': "import { contextBridge } from 'electron'; export const bridge = contextBridge;\n" }),
    );
    expect(result.some((entry) => entry.code === 'CONTRACT_PRELOAD_EXPOSURE_MISSING')).toBe(true);
  });

  it('rejects direct Electron primitives in renderer source', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'renderer/pages/Home.tsx': "import { ipcRenderer } from 'electron'; export const Home = ipcRenderer;\n",
      }),
    );
    expect(result.some((entry) => entry.code === 'CONTRACT_RENDERER_DIRECT_ELECTRON')).toBe(true);
  });

  it('does not flag renderer comments or string values as direct Electron usage', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'renderer/pages/Home.tsx': 'const label = "ipcRenderer"; // contextBridge is not used\nexport const Home = () => label;\n',
      }),
    );
    expect(result).toEqual([]);
  });

  it('keeps facade result contracts on shared/types', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'main/facade/facade.ts': 'import type { SharedValue } from "../../shared/types"; export const facade = null as unknown as SharedValue;\n',
      }),
    );
    expect(result).toEqual([]);
  });

  it('rejects facade imports of other shared modules as result contracts', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'shared/ipc.ts': 'export const IPC_CHANNEL = "sample";\n',
        'main/facade/facade.ts': 'import { IPC_CHANNEL } from "../../shared/ipc"; export const facade = IPC_CHANNEL;\n',
      }),
    );
    expect(result.some((entry) => entry.code === 'CONTRACT_FACADE_SHARED_SOURCE')).toBe(true);
  });

  it('allows renderer to consume shared types and main/ipc to consume shared channels', () => {
    const result = withFixture(
      mergeFiles(requiredSkeleton, {
        'renderer/pages/Home.tsx': 'import type { SharedValue } from "../../shared/types"; export const Home = (value: SharedValue) => value;\n',
        'main/ipc.ts': 'import { IPC_CHANNEL } from "../shared/ipc"; export const channels = [IPC_CHANNEL];\n',
      }),
      ({ srcRoot }) => collectDependencyViolations({ srcRoot, resolver: {} }),
    );
    expect(result).toEqual([]);
  });

  it('requires main/ipc channel registration to use shared constants', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'main/ipc.ts': "import { ipcMain } from 'electron'; ipcMain.handle('arbitrary-channel', () => true);\n",
      }),
    );
    expect(result.some((entry) => entry.code === 'CONTRACT_MAIN_IPC_CHANNEL_SOURCE')).toBe(true);
    expect(result.some((entry) => entry.code === 'CONTRACT_MAIN_IPC_CHANNEL_LITERAL')).toBe(true);
  });

  it('requires main/ipc to import shared/ipc when registering a channel', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'main/ipc.ts': "import { ipcMain } from 'electron'; const channel = IPC_CHANNEL; ipcMain.handle(channel, () => true);\n",
      }),
    );
    expect(result.some((entry) => entry.code === 'CONTRACT_MAIN_IPC_CHANNEL_SOURCE')).toBe(true);
  });

  it('requires each registered main channel expression to come from an imported shared constant', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'main/ipc.ts': "import { ipcMain } from 'electron'; import { IPC_CHANNELS } from '../shared/ipc'; const channel = 'arbitrary:' + suffix; ipcMain.handle(channel, () => true);\n",
      }),
    );
    expect(result.some((entry) => entry.code === 'CONTRACT_MAIN_IPC_CHANNEL_LITERAL')).toBe(true);
  });

  it('accepts a registered member of an imported shared channel map', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'main/ipc.ts': "import { ipcMain } from 'electron'; import { IPC_CHANNELS } from '../shared/ipc'; ipcMain.handle(IPC_CHANNELS.sample, () => true);\n",
      }),
    );
    expect(result).toEqual([]);
  });

  it('accepts aliased and namespace imports from shared/ipc', () => {
    const aliased = contractViolations(
      mergeFiles(requiredSkeleton, {
        'main/ipc.ts': "import { ipcMain } from 'electron'; import { IPC_CHANNELS as CHANNELS } from '../shared/ipc'; ipcMain.handle(CHANNELS.sample, () => true);\n",
      }),
    );
    const namespaced = contractViolations(
      mergeFiles(requiredSkeleton, {
        'main/ipc.ts': "import { ipcMain } from 'electron'; import * as CHANNELS from '../shared/ipc'; ipcMain.handle(CHANNELS.IPC_CHANNEL, () => true);\n",
      }),
    );
    expect(aliased).toEqual([]);
    expect(namespaced).toEqual([]);
  });

  it('does not treat a type-only shared import as a runtime channel source', () => {
    const result = contractViolations(
      mergeFiles(requiredSkeleton, {
        'main/ipc.ts': "import { ipcMain } from 'electron'; import type { IPC_CHANNELS } from '../shared/ipc'; ipcMain.handle(IPC_CHANNELS.sample, () => true);\n",
      }),
    );
    expect(result.some((entry) => entry.code === 'CONTRACT_MAIN_IPC_CHANNEL_LITERAL')).toBe(true);
  });
});
