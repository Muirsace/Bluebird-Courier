import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDependency } from './resolver';
import { scanDependencies } from './scanner';
import { createFixture, removeFixture } from '../test-utils';

function oneReference(source: string) {
  const result = scanDependencies(source, 'module.ts');
  if (!result[0]) throw new Error('fixture did not produce a dependency');
  return result[0];
}

describe('dependency resolver', () => {
  it('resolves relative TypeScript files and index files', () => {
    const fixture = createFixture({
      'domain/types.ts': 'export type Value = string;\n',
      'domain/rules/index.ts': 'export const rule = true;\n',
      'domain/source.ts': 'export const source = true;\n',
    });
    try {
      const source = path.join(fixture.srcRoot, 'domain', 'source.ts');
      const direct = resolveDependency(source, oneReference("import '../domain/types';"));
      const index = resolveDependency(path.join(fixture.srcRoot, 'domain', 'rules', 'consumer.ts'), oneReference("import './';"));
      expect(direct.kind).toBe('source');
      expect(direct.absolutePath).toBe(path.join(fixture.srcRoot, 'domain', 'types.ts'));
      expect(index.kind).toBe('source');
      expect(index.absolutePath).toBe(path.join(fixture.srcRoot, 'domain', 'rules', 'index.ts'));
    } finally {
      removeFixture(fixture);
    }
  });

  it('preserves complete external package specifiers', () => {
    const result = resolveDependency('/tmp/module.ts', oneReference("import runtime from 'react/jsx-runtime';"));
    expect(result).toMatchObject({ kind: 'external', packageSpecifier: 'react/jsx-runtime', specifier: 'react/jsx-runtime' });
  });

  it('treats stylesheet and image imports as resources', () => {
    const source = '/tmp/src/renderer/Home.tsx';
    expect(resolveDependency(source, oneReference("import './styles.css';")).kind).toBe('resource');
    expect(resolveDependency(source, oneReference("import icon from './icon.svg';")).kind).toBe('resource');
  });

  it('reports unresolved literal and non-literal dependencies', () => {
    const source = '/tmp/src/domain/types.ts';
    expect(resolveDependency(source, oneReference("import './missing';")).kind).toBe('unresolved');
    expect(resolveDependency(source, oneReference('import(name);')).kind).toBe('unresolved');
  });

  it('supports explicit path aliases', () => {
    const fixture = createFixture({ 'domain/types.ts': 'export type Value = string;\n' });
    try {
      const result = resolveDependency(
        path.join(fixture.srcRoot, 'consumer.ts'),
        oneReference("import type { Value } from '@domain/types';"),
        { baseUrl: fixture.srcRoot, aliases: [{ pattern: '@domain/*', targets: ['domain/*'] }] },
      );
      expect(result.kind).toBe('source');
      expect(result.absolutePath).toBe(path.join(fixture.srcRoot, 'domain', 'types.ts'));
    } finally {
      removeFixture(fixture);
    }
  });

  it('does not require resource files to exist before classifying them as resources', () => {
    const result = resolveDependency('/tmp/module.ts', oneReference("import './missing.css';"));
    expect(result.kind).toBe('resource');
  });
});
