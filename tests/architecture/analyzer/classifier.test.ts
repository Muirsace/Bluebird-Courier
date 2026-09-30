import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyModule, scanStructure } from './classifier';
import { mergeFiles, requiredSkeleton, withFixture } from '../test-utils';

describe('module classifier', () => {
  it('classifies all documented source roles', () => {
    withFixture(
      mergeFiles(requiredSkeleton, {
        'main/core/infra/db.ts': 'export const db = true;\n',
        'main/core/adapters/api.ts': 'export const api = true;\n',
        'main/features/fetch/contract/types.ts': 'export type Fetch = string;\n',
        'main/features/fetch/implementation/service.ts': 'export const service = true;\n',
        'main/facade/facade.ts': 'export const facade = true;\n',
        'renderer/pages/Home.tsx': 'export const Home = () => null;\n',
      }),
      ({ srcRoot }) => {
        expect(classifyModule(srcRoot, path.join(srcRoot, 'domain', 'types.ts')).role).toBe('domain');
        expect(classifyModule(srcRoot, path.join(srcRoot, 'shared', 'types.ts')).role).toBe('shared');
        expect(classifyModule(srcRoot, path.join(srcRoot, 'preload', 'index.ts')).role).toBe('preload');
        expect(classifyModule(srcRoot, path.join(srcRoot, 'main', 'index.ts')).role).toBe('main-index');
        expect(classifyModule(srcRoot, path.join(srcRoot, 'main', 'ipc.ts')).role).toBe('main-ipc');
        expect(classifyModule(srcRoot, path.join(srcRoot, 'main', 'core', 'infra', 'db.ts')).role).toBe('main-infra');
        expect(classifyModule(srcRoot, path.join(srcRoot, 'main', 'core', 'adapters', 'api.ts')).role).toBe('main-adapter');
        expect(classifyModule(srcRoot, path.join(srcRoot, 'main', 'features', 'fetch', 'contract', 'types.ts'))).toMatchObject({ role: 'feature-contract', feature: 'fetch' });
        expect(classifyModule(srcRoot, path.join(srcRoot, 'main', 'features', 'fetch', 'implementation', 'service.ts'))).toMatchObject({ role: 'feature-implementation', feature: 'fetch' });
        expect(classifyModule(srcRoot, path.join(srcRoot, 'main', 'facade', 'facade.ts')).role).toBe('facade');
        expect(classifyModule(srcRoot, path.join(srcRoot, 'renderer', 'pages', 'Home.tsx')).role).toBe('renderer');
      },
    );
  });

  it('classifies unknown main locations as main-runtime for root policy diagnostics', () => {
    withFixture(mergeFiles(requiredSkeleton, { 'main/runtime.ts': 'export const runtime = true;\n' }), ({ srcRoot }) => {
      expect(classifyModule(srcRoot, path.join(srcRoot, 'main', 'runtime.ts')).role).toBe('main-runtime');
    });
  });

  it('does not classify nested entry paths as main entry roles', () => {
    withFixture(requiredSkeleton, ({ srcRoot }) => {
      expect(classifyModule(srcRoot, path.join(srcRoot, 'main', 'index.ts', 'helper.ts')).role).toBe('main-runtime');
      expect(classifyModule(srcRoot, path.join(srcRoot, 'main', 'ipc.ts', 'helper.ts')).role).toBe('main-runtime');
    });
  });

  it('marks files outside src as unknown', () => {
    withFixture(requiredSkeleton, ({ srcRoot, root }) => {
      expect(classifyModule(srcRoot, path.join(root, 'outside.ts'))).toMatchObject({ role: 'unknown', withinSrc: false });
    });
  });

  it('keeps optional rules directory optional', () => {
    withFixture(requiredSkeleton, ({ srcRoot }) => expect(scanStructure(srcRoot)).toEqual([]));
  });
});
