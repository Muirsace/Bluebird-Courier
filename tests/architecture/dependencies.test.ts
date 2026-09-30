import { describe, expect, it } from 'vitest';
import { collectDependencyViolations, analyzeSourceTree } from './analyzer';
import { resolveDependency } from './analyzer/resolver';
import { scanDependencies } from './analyzer/scanner';
import { coreAdapterTechnicalDependencies, coreInfraTechnicalDependencies, mainIndexTechnicalDependencies, rendererPresentationLibraries } from './policy';
import { mergeFiles, requiredSkeleton, withFixture } from './test-utils';

function violations(files: Record<string, string>) {
  return withFixture(files, ({ srcRoot }) => collectDependencyViolations({ srcRoot, resolver: {} }));
}

describe('architecture dependency whitelist', () => {
  it('accepts dependencies that match every documented layer', () => {
    const files = mergeFiles(requiredSkeleton, {
      'domain/rules/rule.ts': 'import type { DomainValue } from "../types"; export const rule = (v: DomainValue) => v;\n',
      'shared/extra.ts': 'import type { DomainValue } from "../domain/types"; export type Extra = DomainValue;\n',
      'main/core/infra/database.ts': 'export const database = {};\n',
      'main/core/infra/logging.ts': 'import { database } from "./database"; export const logger = database;\n',
      'main/core/adapters/repository.ts': 'import type { DomainPort } from "../../../domain/ports"; export const adapter = null as unknown as DomainPort;\n',
      'main/features/fetch/contract/types.ts': 'import type { DomainValue } from "../../../../domain/types"; export type FetchContract = DomainValue;\n',
      'main/features/fetch/implementation/service.ts': 'import type { FetchContract } from "../contract/types"; import { database } from "../../../core/infra/database"; export const makeFetch = (): FetchContract => database as FetchContract;\n',
      'main/facade/facade.ts': 'import type { FetchContract } from "../features/fetch/contract/types"; import type { SharedValue } from "../../shared/types"; export const createFacade = (f: FetchContract): SharedValue => f as unknown as SharedValue;\n',
      'preload/index.ts': 'import type { SharedValue } from "../shared/types"; export const bridge = null as unknown as SharedValue;\n',
      'renderer/pages/Home.tsx': 'import type { SharedValue } from "../../shared/types"; export const Home = (p: SharedValue) => p;\n',
      'main/ipc.ts': 'import { createFacade } from "./facade/facade"; import { IPC_CHANNEL } from "../shared/ipc"; export const register = [createFacade, IPC_CHANNEL];\n',
      'main/index.ts': 'import { makeFetch } from "./features/fetch/implementation/service"; import { createFacade } from "./facade/facade"; import { database } from "./core/infra/database"; import type { DomainValue } from "../domain/types"; import type { SharedValue } from "../shared/types"; export const compose = [makeFetch, createFacade, database] as Array<unknown | DomainValue | SharedValue>;\n',
    });
    const result = violations(files);
    expect(result).toEqual([]);
  });

  it('rejects a domain dependency on another project layer', () => {
    const result = violations(mergeFiles(requiredSkeleton, { 'domain/rules/bad.ts': 'import { value } from "../../shared/types"; export { value };\n' }));
    expect(result.some((entry) => entry.code.startsWith('DEP_NOT_ALLOWED_DEP-DOMAIN'))).toBe(true);
  });

  it('rejects feature implementation dependencies on adapters', () => {
    const result = violations(
      mergeFiles(requiredSkeleton, {
        'main/core/adapters/github.ts': 'export const github = {};\n',
        'main/features/fetch/contract/types.ts': 'export type Fetch = string;\n',
        'main/features/fetch/implementation/service.ts': 'import { github } from "../../../core/adapters/github"; export const service = github;\n',
      }),
    );
    expect(result.some((entry) => entry.code === 'DEP_NOT_ALLOWED_DEP-IMPLEMENTATION')).toBe(true);
  });

  it('rejects unregistered technology dependencies by default', () => {
    const result = violations(
      mergeFiles(requiredSkeleton, {
        'main/core/infra/database.ts': 'import Database from "@architecture/unregistered-technology"; export const db = Database;\n',
      }),
    );
    expect(result.some((entry) => entry.code === 'DEP_EXTERNAL_NOT_ALLOWED' && entry.target?.specifier === '@architecture/unregistered-technology')).toBe(true);
  });

  it('allows only explicitly registered technical dependencies for each owning layer', () => {
    const registered = {
      infra: '@architecture/infra',
      adapter: '@architecture/adapter',
      root: '@architecture/root',
      renderer: '@architecture/presentation',
    };
    coreInfraTechnicalDependencies.add(registered.infra);
    coreAdapterTechnicalDependencies.add(registered.adapter);
    mainIndexTechnicalDependencies.add(registered.root);
    rendererPresentationLibraries.add(registered.renderer);
    try {
      const result = violations(
        mergeFiles(requiredSkeleton, {
          'main/core/infra/store.ts': `import store from '${registered.infra}'; export const value = store;\n`,
          'main/core/adapters/platform.ts': `import client from '${registered.adapter}'; export const value = client;\n`,
          'main/index.ts': `import root from '${registered.root}'; export const compose = root;\n`,
          'renderer/pages/Home.tsx': `import View from '${registered.renderer}'; export const Home = View;\n`,
        }),
      );
      expect(result.filter((entry) => entry.code === 'DEP_EXTERNAL_NOT_ALLOWED')).toEqual([]);
    } finally {
      coreInfraTechnicalDependencies.delete(registered.infra);
      coreAdapterTechnicalDependencies.delete(registered.adapter);
      mainIndexTechnicalDependencies.delete(registered.root);
      rendererPresentationLibraries.delete(registered.renderer);
    }
  });

  it('keeps registered external dependencies exact, including subpaths', () => {
    rendererPresentationLibraries.add('@architecture/presentation');
    try {
      const result = violations(
        mergeFiles(requiredSkeleton, {
          'renderer/pages/Home.tsx': "import View from '@architecture/presentation/subpath'; export const Home = View;\n",
        }),
      );
      expect(result.some((entry) => entry.code === 'DEP_EXTERNAL_NOT_ALLOWED' && entry.target?.specifier === '@architecture/presentation/subpath')).toBe(true);
    } finally {
      rendererPresentationLibraries.delete('@architecture/presentation');
    }
  });

  it('preserves full external specifiers', () => {
    const references = scanDependencies("import jsx from 'react/jsx-runtime';\n", 'renderer.tsx');
    const result = resolveDependency('/tmp/renderer.tsx', references[0]!, {});
    expect(result.packageSpecifier).toBe('react/jsx-runtime');
  });

  it('rejects non-literal dynamic paths', () => {
    const result = violations(
      mergeFiles(requiredSkeleton, {
        'main/core/infra/dynamic.ts': 'const name = "./database"; export const load = () => import(name);\n',
      }),
    );
    expect(result.some((entry) => entry.code === 'DEP_UNRESOLVED' && entry.reference?.kind === 'dynamic-import')).toBe(true);
  });

  it('ignores stylesheet and image resources as source dependencies', () => {
    const result = violations(
      mergeFiles(requiredSkeleton, {
        'renderer/pages/Home.tsx': "import '../styles.css'; import icon from '../icon.svg'; export const Home = () => icon;\n",
        'renderer/styles.css': 'body {}\n',
        'renderer/icon.svg': '<svg />\n',
      }),
    );
    expect(result.filter((entry) => entry.reference?.specifier?.endsWith('.css') || entry.reference?.specifier?.endsWith('.svg'))).toEqual([]);
  });

  it('reports the reference location for every violation', () => {
    const result = violations(mergeFiles(requiredSkeleton, { 'domain/bad.ts': 'import "node:fs";\n' }));
    expect(result[0]?.reference?.line).toBe(1);
    expect(result[0]?.source.relativePath).toBe('domain/bad.ts');
  });

  it('analyzes every source module in the tree', () => {
    withFixture(mergeFiles(requiredSkeleton, { 'domain/rules/a.ts': 'export const a = true;\n' }), ({ srcRoot }) => {
      const analyses = analyzeSourceTree({ srcRoot, resolver: {} });
      expect(analyses.some((entry) => entry.module.relativePath === 'domain/rules/a.ts')).toBe(true);
    });
  });
});
