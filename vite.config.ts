import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const rendererStylesEntry = path.resolve(__dirname, 'src/renderer/styles.css');

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [
    {
      name: 'renderer-style-imports',
      enforce: 'pre',
      transform(source, id) {
        if (id.split('?')[0] !== normalizePath(rendererStylesEntry)) return;
        // Inline only this entry before PostCSS: imports after @tailwind are otherwise ignored.
        // One Tailwind pass also keeps generated variants after all custom rules, as before.
        return source.replace(
          /^@import ['"](\.\/styles\/[^'"]+\.css)['"];[ \t]*\r?$/gm,
          (_statement, stylesheet: string) => {
            const file = path.resolve(path.dirname(rendererStylesEntry), stylesheet);
            this.addWatchFile(file);
            return readFileSync(file, 'utf8');
          },
        );
      },
    },
    react(),
  ],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
