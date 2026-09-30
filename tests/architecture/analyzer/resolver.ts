import fs from 'node:fs';
import path from 'node:path';
import type { DependencyReference, ResolvedDependency } from './types';

const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];
const resourceExtensions = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
]);

export interface PathAlias {
  pattern: string;
  targets: string[];
}

export interface ResolverOptions {
  aliases?: PathAlias[];
  baseUrl?: string;
}

function isResourceSpecifier(specifier: string): boolean {
  return resourceExtensions.has(path.extname(specifier).toLowerCase());
}

function candidatePaths(base: string): string[] {
  const candidates = [base];
  if (!path.extname(base)) {
    for (const extension of sourceExtensions) candidates.push(`${base}${extension}`);
    for (const extension of sourceExtensions) candidates.push(path.join(base, `index${extension}`));
  }
  return candidates;
}

function findSourceFile(base: string): string | undefined {
  for (const candidate of candidatePaths(base)) {
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // A missing candidate is expected while trying extensions.
    }
  }
  return undefined;
}

function aliasTarget(specifier: string, options: ResolverOptions): string | undefined {
  for (const alias of options.aliases ?? []) {
    const star = alias.pattern.indexOf('*');
    if (star < 0) {
      if (specifier !== alias.pattern) continue;
      const target = alias.targets[0];
      return target ? path.resolve(options.baseUrl ?? process.cwd(), target) : undefined;
    }
    const prefix = alias.pattern.slice(0, star);
    const suffix = alias.pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
    const target = alias.targets[0];
    return target ? path.resolve(options.baseUrl ?? process.cwd(), target.replace('*', wildcard)) : undefined;
  }
  return undefined;
}

/** Resolve an import specifier without treating stylesheet/image assets as source modules. */
export function resolveDependency(
  sourceFile: string,
  reference: DependencyReference,
  options: ResolverOptions = {},
): ResolvedDependency {
  const specifier = reference.specifier;
  if (!specifier) {
    return { kind: 'unresolved', specifier, reference };
  }

  const isRelative = specifier.startsWith('.') || specifier.startsWith('/') || Boolean(aliasTarget(specifier, options));
  if (!isRelative) {
    return { kind: 'external', specifier, packageSpecifier: specifier, reference };
  }

  if (isResourceSpecifier(specifier)) {
    return { kind: 'resource', specifier, reference };
  }

  const base = aliasTarget(specifier, options) ?? path.resolve(path.dirname(sourceFile), specifier);
  const absolutePath = findSourceFile(base);
  if (absolutePath) return { kind: 'source', specifier, absolutePath, reference };
  return { kind: 'unresolved', specifier, reference };
}

export interface ResolvedTsConfig {
  options: ResolverOptions;
}

/** Small tsconfig helper used by the repository gate and resolver tests. */
export function resolverOptionsFromTsConfig(tsconfigPath: string): ResolvedTsConfig {
  let config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    config = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as typeof config;
  } catch {
    return { options: {} };
  }
  const configDirectory = path.dirname(tsconfigPath);
  const baseUrlValue = config.compilerOptions?.baseUrl;
  const baseUrl = baseUrlValue ? path.resolve(configDirectory, baseUrlValue) : undefined;
  const aliases: PathAlias[] = [];
  const paths = config.compilerOptions?.paths ?? {};
  for (const [pattern, targets] of Object.entries(paths)) {
    aliases.push({ pattern, targets: targets.map(String) });
  }
  return {
    options: {
      baseUrl,
      aliases,
    },
  };
}
