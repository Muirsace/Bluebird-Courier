import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRendererStyles, rendererStyleFiles } from './support/styles';

describe('Renderer stylesheet structure', () => {
  it('loads every section once in the original order, with reduced motion last', () => {
    expect(rendererStyleFiles).toEqual([
      'styles.css',
      'styles/tokens.css',
      'styles/brand.css',
      'styles/settings.css',
      'styles/foundation.css',
      'styles/overlays.css',
      'styles/navigation.css',
      'styles/detail.css',
      'styles/watchlist.css',
      'styles/accessibility.css',
    ]);
    // Reading the entire cascade also verifies that every imported file exists.
    const css = readRendererStyles();
    expect(css.match(/@tailwind\s+[^;]+;/g)).toEqual([
      '@tailwind base;',
      '@tailwind components;',
      '@tailwind utilities;',
    ]);
    const entry = readFileSync(resolve(process.cwd(), 'src/renderer/styles.css'), 'utf8');
    expect(entry.replace(/^@import .*;[ \t]*\r?$/gm, '').replaceAll('\r', '').trim()).toBe(
      '@tailwind base;\n@tailwind components;\n@tailwind utilities;',
    );
    const accessibility = readFileSync(
      resolve(process.cwd(), 'src/renderer/styles/accessibility.css'),
      'utf8',
    );
    expect(accessibility.trimStart()).toMatch(/^@media \(prefers-reduced-motion: reduce\)/);
    expect(css.endsWith(accessibility)).toBe(true);
  });
});
