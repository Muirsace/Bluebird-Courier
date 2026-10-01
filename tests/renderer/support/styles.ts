import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rendererRoot = resolve(process.cwd(), 'src/renderer');
const entry = resolve(rendererRoot, 'styles.css');

// Read the production imports instead of maintaining a second cascade order.
export const rendererStyleFiles = [
  'styles.css',
  ...[...readFileSync(entry, 'utf8').matchAll(
    /^@import ['"](\.\/styles\/[^'"]+\.css)['"];[ \t]*\r?$/gm,
  )].map((match) => match[1]!.slice(2)),
];

export function readRendererStyles(): string {
  return rendererStyleFiles
    .map((file) => readFileSync(resolve(rendererRoot, file), 'utf8'))
    .join('\n');
}
