import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS } from '../../src/shared/ipc';
import type { BluebirdCourierBridge } from '../../src/shared/types';

/**
 * 回归测试接缝：preload 构建产物在 Electron 沙箱语义下必须自包含。
 *
 * Electron ≥20 默认沙箱化 preload，其 require 只允许 electron/events/timers/url
 * （Electron 官方文档 Process Sandboxing）；preload 一旦运行时依赖相对模块，
 * require 当场抛 MODULE_NOT_FOUND，contextBridge 桥不会暴露，
 * 症状即启动时报"无法读取访问令牌状态，请稍后重试"且无法输入令牌（见 .scratch/diagnose/）。
 *
 * 这里直接执行真实构建产物 dist/main/preload/index.js（npm test 已先跑 build:main），
 * 用白名单 require 复现沙箱限制，锁定"preload 不得依赖白名单外模块"这一模式。
 */

const PRELOAD_ARTIFACT = fileURLToPath(new URL('../../dist/main/preload/index.js', import.meta.url));
/** Electron 沙箱 preload 的 require 白名单（官方文档 Process Sandboxing）。 */
const SANDBOX_WHITELIST = new Set(['electron', 'events', 'timers', 'url']);
const nodeRequire = createRequire(import.meta.url);

const GATEWAY_METHODS = [
  'accessTokenState',
  'validateAccessToken',
  'saveAccessToken',
  'getSettings',
  'updateSettings',
  'listRepositories',
  'addRepository',
  'inspectRepositoryInput',
  'removeRepository',
  'refreshGlance',
  'fetchDetail',
  'openGitHubExternal',
] as const;

/** 渲染层不得具备的任意能力：通用外链、任意通道、Node / Electron 本体。 */
const FORBIDDEN_METHODS = ['openExternal', 'shell', 'execute', 'send', 'sendSync', 'invoke', 'require', 'ipcRenderer'];

interface LoadedPreload {
  exposed: Array<{ name: string; api: Record<string, () => unknown> }>;
  invokedChannels: string[];
  loadError: Error | null;
}

/** 用沙箱 require 白名单执行 preload 产物（等价于 Electron 加载沙箱 preload）。 */
function loadPreloadUnderSandbox(): LoadedPreload {
  const code = fs.readFileSync(PRELOAD_ARTIFACT, 'utf8');

  const exposed: LoadedPreload['exposed'] = [];
  const invokedChannels: string[] = [];
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld: (name: string, api: Record<string, () => unknown>) => {
        exposed.push({ name, api });
      },
    },
    ipcRenderer: {
      invoke: (channel: string) => {
        invokedChannels.push(channel);
        return Promise.resolve({ configured: false });
      },
    },
  };

  const sandboxRequire = (request: string): unknown => {
    if (request === 'electron') return fakeElectron;
    if (SANDBOX_WHITELIST.has(request)) return nodeRequire(request);
    const error: NodeJS.ErrnoException = new Error(`Cannot find module '${request}'`);
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  };

  const moduleObject = { exports: {} as Record<string, unknown> };
  let loadError: Error | null = null;
  try {
    const compile = new Function('require', 'module', 'exports', code);
    compile(sandboxRequire, moduleObject, moduleObject.exports);
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error));
  }
  return { exposed, invokedChannels, loadError };
}

describe('preload 沙箱自包含（启动即报"无法读取访问令牌状态"的回归）', () => {
  it('preload 产物在沙箱 require 白名单下加载成功且不抛异常', () => {
    const { loadError } = loadPreloadUnderSandbox();
    expect(loadError).toBeNull();
  });

  it('contextBridge 暴露 bluebirdCourier 网关与全部用例方法', () => {
    const { exposed, loadError } = loadPreloadUnderSandbox();
    expect(loadError).toBeNull();
    expect(exposed).toHaveLength(1);
    expect(exposed[0]?.name).toBe('bluebirdCourier');
    expect(Object.keys(exposed[0]?.api ?? {}).sort()).toEqual([...GATEWAY_METHODS].sort());
  });

  it('网关不暴露通用外链 / 任意通道 / Electron 本体（只有 openGitHubExternal 这一条窄口）', () => {
    const { exposed, loadError } = loadPreloadUnderSandbox();
    expect(loadError).toBeNull();
    const api = exposed[0]?.api ?? {};
    for (const forbidden of FORBIDDEN_METHODS) {
      expect(api, `网关不应暴露 ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it('网关每个方法调用的 IPC 通道与 shared/ipc.ts 逐字一致（防内联字面量漂移）', () => {
    const { exposed, loadError } = loadPreloadUnderSandbox();
    expect(loadError).toBeNull();
    const api = exposed[0]?.api ?? {};
    // 逐方法比对：网关方法名与 IPC_CHANNELS 键一一对应
    for (const method of GATEWAY_METHODS) {
      const loaded = loadPreloadUnderSandbox();
      const gateway = loaded.exposed[0]?.api ?? {};
      const invoke = gateway[method];
      expect(invoke, `网关缺少方法 ${method}`).toBeTypeOf('function');
      invoke?.();
      expect(loaded.invokedChannels, `方法 ${method} 的通道`).toEqual([IPC_CHANNELS[method]]);
    }
    // 类型层面同样锁死：暴露的形状就是 BluebirdCourierBridge
    const _bridgeCheck: BluebirdCourierBridge = api as unknown as BluebirdCourierBridge;
    void _bridgeCheck;
  });
});
