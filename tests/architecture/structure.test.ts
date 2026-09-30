import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanStructure } from './analyzer/classifier';
import { mergeFiles, requiredSkeleton, withFixture } from './test-utils';

describe('architecture structure', () => {
  it('accepts the documented skeleton and open extension areas', () => {
    withFixture(
      mergeFiles(requiredSkeleton, {
        'domain/rules/repository.ts': 'export const rule = true;\n',
        'main/core/infra/database/client.ts': 'export const db = true;\n',
        'main/core/adapters/github/client.ts': 'export const adapter = true;\n',
        'main/features/fetch/contract/index.ts': 'export interface FetchContract {}\n',
        'main/features/fetch/implementation/service.ts': 'export const makeFetch = () => ({});\n',
        'main/facade/facade.ts': 'export const facade = true;\n',
        'renderer/pages/Home.tsx': 'export const Home = () => null;\n',
        'renderer/components/ui/Button.tsx': 'export const Button = () => null;\n',
        'renderer/lib/format.ts': 'export const format = String;\n',
      }),
      ({ srcRoot }) => expect(scanStructure(srcRoot)).toEqual([]),
    );
  });

  it('requires the stable entry files', () => {
    const files: Record<string, string> = { ...requiredSkeleton };
    delete files['domain/ports.ts'];
    withFixture(files, ({ srcRoot }) => {
      const violations = scanStructure(srcRoot);
      expect(violations.some((entry) => entry.code === 'STRUCTURE_REQUIRED_MISSING' && entry.path === 'domain/ports.ts')).toBe(true);
    });
  });

  it('rejects an unknown top-level source layer', () => {
    withFixture(mergeFiles(requiredSkeleton, { 'database/index.ts': 'export const db = true;\n' }), ({ srcRoot }) => {
      expect(scanStructure(srcRoot).some((entry) => entry.code === 'STRUCTURE_TOP_LEVEL')).toBe(true);
    });
  });

  it('keeps domain, shared and preload locations closed to undocumented files', () => {
    withFixture(
      mergeFiles(requiredSkeleton, {
        'domain/extra.ts': 'export const extra = true;\n',
        'shared/extra.ts': 'export const extra = true;\n',
        'preload/helper.ts': 'export const helper = true;\n',
      }),
      ({ srcRoot }) => {
        const codes = scanStructure(srcRoot).map((entry) => entry.code);
        expect(codes).toEqual(expect.arrayContaining(['STRUCTURE_DOMAIN_LOCATION', 'STRUCTURE_SHARED_LOCATION', 'STRUCTURE_PRELOAD_LOCATION']));
      },
    );
  });

  it('requires domain rules to live under the rules directory', () => {
    withFixture(mergeFiles(requiredSkeleton, { 'domain/rules.ts': 'export const rule = true;\n' }), ({ srcRoot }) => {
      expect(scanStructure(srcRoot).some((entry) => entry.code === 'STRUCTURE_DOMAIN_LOCATION' && entry.path === 'domain/rules.ts')).toBe(true);
    });
  });

  it('requires both contract and implementation surfaces for each feature', () => {
    withFixture(
      mergeFiles(requiredSkeleton, { 'main/features/watch/contract/types.ts': 'export type Watch = string;\n' }),
      ({ srcRoot }) => {
        const violations = scanStructure(srcRoot);
        expect(violations.some((entry) => entry.code === 'STRUCTURE_FEATURE_SURFACE_MISSING' && entry.path.endsWith('/implementation'))).toBe(true);
      },
    );
  });

  it('rejects source files directly at a feature root', () => {
    withFixture(mergeFiles(requiredSkeleton, { 'main/features/watch.ts': 'export const watch = true;\n' }), ({ srcRoot }) => {
      const violations = scanStructure(srcRoot);
      expect(violations.some((entry) => entry.code === 'STRUCTURE_MAIN_LOCATION')).toBe(true);
    });
  });

  it('requires main entry files to be direct files in main/', () => {
    const files: Record<string, string> = { ...requiredSkeleton };
    delete files['main/index.ts'];
    delete files['main/ipc.ts'];
    files['main/index.ts/helper.ts'] = 'export const helper = true;\n';
    files['main/ipc.ts/helper.ts'] = 'export const helper = true;\n';
    withFixture(files, ({ srcRoot }) => {
      const violations = scanStructure(srcRoot);
      expect(violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'STRUCTURE_MAIN_LOCATION', path: 'main/index.ts/helper.ts' }),
          expect.objectContaining({ code: 'STRUCTURE_MAIN_LOCATION', path: 'main/ipc.ts/helper.ts' }),
        ]),
      );
    });
  });

  it('rejects legacy paths outside the documented layers', () => {
    withFixture(
      mergeFiles(requiredSkeleton, {
        'main/core/db/database.ts': 'export const database = true;\n',
        'main/features/watch.ts': 'export const watch = true;\n',
        'main/shell-links.ts': 'export const shellLinks = true;\n',
        'renderer/App.tsx': 'export const App = () => null;\n',
        'shared/theme.ts': 'export const theme = true;\n',
      }),
      ({ srcRoot }) => {
        const violations = scanStructure(srcRoot);
        expect(violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'STRUCTURE_MAIN_LOCATION', path: 'main/core/db/database.ts' }),
            expect.objectContaining({ code: 'STRUCTURE_MAIN_LOCATION', path: 'main/features/watch.ts' }),
            expect.objectContaining({ code: 'STRUCTURE_MAIN_LOCATION', path: 'main/shell-links.ts' }),
            expect.objectContaining({ code: 'STRUCTURE_RENDERER_LOCATION', path: 'renderer/App.tsx' }),
            expect.objectContaining({ code: 'STRUCTURE_SHARED_LOCATION', path: 'shared/theme.ts' }),
          ]),
        );
      },
    );
  });

  it('does not require a feature to exist before the project has one', () => {
    withFixture(requiredSkeleton, ({ srcRoot }) => expect(scanStructure(srcRoot)).toEqual([]));
  });

  it('uses normalized paths in diagnostics', () => {
    withFixture(mergeFiles(requiredSkeleton, { 'other/file.ts': 'export const value = 1;\n' }), ({ srcRoot }) => {
      const violation = scanStructure(srcRoot).find((entry) => entry.code === 'STRUCTURE_TOP_LEVEL');
      expect(violation?.path).toBe(path.posix.join('other', 'file.ts'));
    });
  });
});
