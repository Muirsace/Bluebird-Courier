import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FixtureContext {
  root: string;
  srcRoot: string;
}

export function createFixture(files: Record<string, string>): FixtureContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-fixture-'));
  const srcRoot = path.join(root, 'src');
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(srcRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, 'utf8');
  }
  return { root, srcRoot };
}

export function removeFixture(fixture: FixtureContext): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

export function withFixture<T>(files: Record<string, string>, callback: (fixture: FixtureContext) => T): T {
  const fixture = createFixture(files);
  try {
    return callback(fixture);
  } finally {
    removeFixture(fixture);
  }
}

export const requiredSkeleton = {
  'domain/types.ts': 'export type DomainValue = string;\n',
  'domain/ports.ts': 'export interface DomainPort { read(): string; }\n',
  'shared/types.ts': 'export type SharedValue = string;\n',
  'shared/ipc.ts': "export const IPC_CHANNEL = 'sample';\n",
  'main/index.ts': 'export const compose = true;\n',
  'main/ipc.ts': 'import { IPC_CHANNEL } from "../shared/ipc"; export const register = IPC_CHANNEL;\n',
  'preload/index.ts': "import { contextBridge } from 'electron'; contextBridge.exposeInMainWorld('bluebirdCourier', {});\n",
};

export function mergeFiles(...groups: Array<Record<string, string>>): Record<string, string> {
  return Object.assign({}, ...groups);
}
