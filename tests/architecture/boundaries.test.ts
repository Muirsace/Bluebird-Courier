import { describe, expect, it } from 'vitest';
import { collectBoundaryViolations } from './analyzer/boundaries';
import { collectDependencyViolations } from './analyzer';
import { mergeFiles, requiredSkeleton, withFixture } from './test-utils';

function boundaryViolations(files: Record<string, string>) {
  return withFixture(files, ({ srcRoot }) => collectBoundaryViolations({ srcRoot, resolver: {} }));
}

describe('architecture ownership and process boundaries', () => {
  it('allows implementation modules within one feature to collaborate', () => {
    const result = boundaryViolations(
      mergeFiles(requiredSkeleton, {
        'main/features/fetch/contract/types.ts': 'export type Fetch = string;\n',
        'main/features/fetch/implementation/one.ts': 'import { two } from "./two"; export const one = two;\n',
        'main/features/fetch/implementation/two.ts': 'export const two = "two";\n',
      }),
    );
    expect(result).toEqual([]);
  });

  it('rejects direct cross-feature imports', () => {
    const result = boundaryViolations(
      mergeFiles(requiredSkeleton, {
        'main/features/a/contract/types.ts': 'export type A = string;\n',
        'main/features/b/contract/types.ts': 'import type { A } from "../../a/contract/types"; export type B = A;\n',
      }),
    );
    expect(result.some((entry) => entry.code === 'BOUNDARY_CROSS_FEATURE')).toBe(true);
  });

  it('rejects feature imports of core adapters', () => {
    const result = boundaryViolations(
      mergeFiles(requiredSkeleton, {
        'main/core/adapters/github.ts': 'export const github = {};\n',
        'main/features/fetch/contract/types.ts': 'export type Fetch = string;\n',
        'main/features/fetch/implementation/service.ts': 'import { github } from "../../../core/adapters/github"; export const service = github;\n',
      }),
    );
    expect(result.some((entry) => entry.code === 'BOUNDARY_FEATURE_TO_ADAPTER')).toBe(true);
  });

  it('rejects facade imports of implementation modules', () => {
    const result = boundaryViolations(
      mergeFiles(requiredSkeleton, {
        'main/features/fetch/contract/types.ts': 'export type Fetch = string;\n',
        'main/features/fetch/implementation/service.ts': 'export const service = "service";\n',
        'main/facade/facade.ts': 'import { service } from "../features/fetch/implementation/service"; export const facade = service;\n',
      }),
    );
    expect(result.some((entry) => entry.code === 'BOUNDARY_FACADE_TO_IMPLEMENTATION')).toBe(true);
  });

  it('makes main/index the only implementation owner', () => {
    const result = boundaryViolations(
      mergeFiles(requiredSkeleton, {
        'main/features/fetch/contract/types.ts': 'export type Fetch = string;\n',
        'main/features/fetch/implementation/service.ts': 'export const service = "service";\n',
        'main/ipc.ts': 'import { service } from "./features/fetch/implementation/service"; export const register = service;\n',
      }),
    );
    expect(result.some((entry) => entry.code === 'BOUNDARY_IMPLEMENTATION_OWNER')).toBe(true);
  });

  it('rejects composition root imports of preload and renderer', () => {
    const result = boundaryViolations(
      mergeFiles(requiredSkeleton, {
        'main/index.ts': 'import "../preload/index"; import "../renderer/pages/Home"; export const compose = true;\n',
        'renderer/pages/Home.tsx': 'export const Home = () => null;\n',
      }),
    );
    expect(result.filter((entry) => entry.code === 'BOUNDARY_ROOT_TO_UI')).toHaveLength(2);
  });

  it('rejects renderer imports of domain and main modules', () => {
    const result = boundaryViolations(
      mergeFiles(requiredSkeleton, {
        'main/core/infra/database.ts': 'export const database = {};\n',
        'renderer/pages/Home.tsx': 'import { DomainValue } from "../../domain/types"; import { database } from "../../main/core/infra/database"; export const Home = [DomainValue, database];\n',
      }),
    );
    expect(result.filter((entry) => entry.code === 'BOUNDARY_RENDERER_TO_BACKEND')).toHaveLength(2);
  });

  it('keeps preload and main/ipc on their documented seams', () => {
    const result = boundaryViolations(
      mergeFiles(requiredSkeleton, {
        'preload/index.ts': 'import { SharedValue } from "../shared/types"; export const bridge = null as unknown as SharedValue;\n',
        'main/ipc.ts': 'import { register } from "./facade/facade"; import { IPC_CHANNEL } from "../shared/ipc"; export const ipc = [register, IPC_CHANNEL];\n',
        'main/facade/facade.ts': 'export const register = true;\n',
      }),
    );
    expect(result).toEqual([]);
  });

  it('reports renderer backend imports through the dependency policy too', () => {
    const result = withFixture(
      mergeFiles(requiredSkeleton, { 'renderer/pages/Home.tsx': "import fs from 'node:fs'; export const Home = fs;\n" }),
      ({ srcRoot }) => collectDependencyViolations({ srcRoot, resolver: {} }),
    );
    expect(result.some((entry) => entry.code === 'DEP_EXTERNAL_NOT_ALLOWED')).toBe(true);
  });
});
