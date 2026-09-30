import { describe, expect, it } from 'vitest';
import { scanDependencies } from './scanner';

describe('dependency scanner', () => {
  it('finds import, import type, re-export and dynamic import edges', () => {
    const result = scanDependencies(
      [
        "import value from './value';",
        "import type { Type } from './type';",
        "export { thing } from './thing';",
        "export * from './all';",
        "const lazy = import('./lazy');",
      ].join('\n'),
      'module.ts',
    );
    expect(result.map((entry) => [entry.kind, entry.specifier])).toEqual([
      ['import', './value'],
      ['import-type', './type'],
      ['export', './thing'],
      ['export', './all'],
      ['dynamic-import', './lazy'],
    ]);
  });

  it('finds literal and non-literal require calls', () => {
    const result = scanDependencies(
      [
        "const a = require('./a');",
        'const name = "./b";',
        'const b = require(name);',
      ].join('\n'),
      'module.ts',
    );
    expect(result.map((entry) => [entry.kind, entry.specifier, entry.isStatic])).toEqual([
      ['require', './a', true],
      ['require', undefined, false],
    ]);
  });

  it('does not report comments or string contents as imports', () => {
    const result = scanDependencies(
      [
        '// import fake from "./comment";',
        'const text = "import fake from \'./string\'";',
        'export const value = 1;',
      ].join('\n'),
      'module.ts',
    );
    expect(result).toEqual([]);
  });

  it('reports the exact line and column', () => {
    const result = scanDependencies('\n\nimport value from "./value";\n', 'module.ts');
    expect(result[0]).toMatchObject({ line: 3, column: 1 });
  });

  it('marks a non-literal import type as unresolved', () => {
    const result = scanDependencies('type Value = import(typeof name).Value;\n', 'module.ts');
    expect(result[0]).toMatchObject({ kind: 'import-type', specifier: undefined, isStatic: false });
  });

  it('treats template interpolation as a non-literal dynamic import', () => {
    const result = scanDependencies('const load = (name: string) => import(`./${name}`);\n', 'module.ts');
    expect(result[0]).toMatchObject({ kind: 'dynamic-import', specifier: undefined, isStatic: false });
  });

  it('treats concatenated import and require paths as unresolved', () => {
    const result = scanDependencies(
      [
        "const load = (suffix: string) => import('./allowed' + suffix);",
        "const loadAgain = (suffix: string) => require('./allowed' + suffix);",
      ].join('\n'),
      'module.ts',
    );
    expect(result).toEqual([
      expect.objectContaining({ kind: 'dynamic-import', specifier: undefined, isStatic: false }),
      expect.objectContaining({ kind: 'require', specifier: undefined, isStatic: false }),
    ]);
  });

  it('does not treat member calls or regular-expression text as require dependencies', () => {
    const result = scanDependencies(
      [
        "logger.require('./member');",
        "const expression = /require('regex')/;",
        "const actual = require('./actual');",
      ].join('\n'),
      'module.ts',
    );
    expect(result.map((entry) => entry.specifier)).toEqual(['./actual']);
  });

  it('detects optional direct require calls but not member require calls', () => {
    const result = scanDependencies("const optional = require?.('./optional'); window.require('./member');\n", 'module.ts');
    expect(result.map((entry) => [entry.kind, entry.specifier, entry.isStatic])).toEqual([
      ['require', './optional', true],
    ]);
  });

  it('does not scan require text inside an arrow expression regular expression', () => {
    const result = scanDependencies("const matcher = () => /require('fake')/;\n", 'module.ts');
    expect(result).toEqual([]);
  });

  it('does not cross a declaration boundary when an import has no semicolon', () => {
    const result = scanDependencies('import value from "./value"\nconst from = "not-a-module";\n', 'module.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.specifier).toBe('./value');
  });
});
