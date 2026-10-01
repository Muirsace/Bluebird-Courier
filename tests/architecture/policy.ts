import path from 'node:path';
import type { ArchitectureViolation, ClassifiedModule, ResolvedDependency, ModuleRole } from './analyzer/types';
import { classifyModule } from './analyzer/classifier';

/**
 * Executable projection of docs/agents/skeleton.md's dependency whitelist.
 * The source document remains authoritative; these sets only record the
 * explicitly maintained technology exceptions requested by that document.
 */
export const coreInfraTechnicalDependencies = new Set<string>(['better-sqlite3', 'node:fs', 'node:path']);
export const coreAdapterTechnicalDependencies = new Set<string>(['electron']);
export const mainIndexTechnicalDependencies = new Set<string>(['electron', 'node:fs', 'node:path']);
export const rendererPresentationLibraries = new Set<string>([
  'react',
  'react-dom/client',
  '@tanstack/react-query',
  'chart.js',
  'react-chartjs-2',
  'motion/react',
]);

export interface PolicyRule {
  id: string;
  description: string;
  source: string;
}

export const policyRules: PolicyRule[] = [
  { id: 'DEP-DOMAIN', description: 'domain may only collaborate with domain modules', source: 'skeleton.md / 依赖白名单 / domain' },
  { id: 'DEP-INFRA', description: 'core/infra may use same-layer modules and registered technology dependencies', source: 'skeleton.md / 依赖白名单 / core/infra' },
  { id: 'DEP-ADAPTER', description: 'core/adapters may use domain, same-layer modules and registered technology dependencies', source: 'skeleton.md / 依赖白名单 / core/adapters' },
  { id: 'DEP-CONTRACT', description: 'feature contracts may use domain and same-feature contract modules', source: 'skeleton.md / 依赖白名单 / features/<feature>/contract' },
  { id: 'DEP-IMPLEMENTATION', description: 'feature implementations may use own contract, domain and core/infra', source: 'skeleton.md / 依赖白名单 / features/<feature>/implementation' },
  { id: 'DEP-FACADE', description: 'facade may use feature contracts, domain, shared/types and same-facade modules', source: 'skeleton.md / 依赖白名单 / facade' },
  { id: 'DEP-SHARED', description: 'shared may use domain and same-shared modules', source: 'skeleton.md / 依赖白名单 / shared' },
  { id: 'DEP-PRELOAD', description: 'preload may use shared and electron', source: 'skeleton.md / 依赖白名单 / preload' },
  { id: 'DEP-RENDERER', description: 'renderer may use shared and registered presentation libraries', source: 'skeleton.md / 依赖白名单 / renderer' },
  { id: 'DEP-IPC', description: 'main/ipc may use facade, shared and electron', source: 'skeleton.md / 依赖白名单 / main/ipc' },
  { id: 'DEP-ROOT', description: 'main/index is the composition root', source: 'skeleton.md / 依赖白名单 / main/index' },
];

function sourceTarget(target: ResolvedDependency, source: ClassifiedModule, srcRoot: string): ClassifiedModule | undefined {
  if (target.kind !== 'source' || !target.absolutePath) return undefined;
  return classifyModule(srcRoot, target.absolutePath);
}

function externalAllowed(source: ClassifiedModule, specifier: string): boolean {
  if (source.role === 'main-infra') return coreInfraTechnicalDependencies.has(specifier);
  if (source.role === 'main-adapter') return coreAdapterTechnicalDependencies.has(specifier);
  if (source.role === 'main-index') return mainIndexTechnicalDependencies.has(specifier);
  if (source.role === 'renderer') return rendererPresentationLibraries.has(specifier);
  if (source.role === 'preload' || source.role === 'main-ipc') {
    return specifier === 'electron';
  }
  return false;
}

function sourceAllowed(source: ClassifiedModule, target: ClassifiedModule): { allowed: boolean; code: string } {
  const same = (role: ModuleRole) => target.role === role;
  const sameFeature = (role: ModuleRole) => same(role) && target.feature === source.feature;
  switch (source.role) {
    case 'domain':
      return { allowed: same('domain'), code: 'DEP-DOMAIN' };
    case 'shared':
      return { allowed: same('shared') || same('domain'), code: 'DEP-SHARED' };
    case 'main-infra':
      return { allowed: same('main-infra'), code: 'DEP-INFRA' };
    case 'main-adapter':
      return { allowed: same('main-adapter') || same('domain'), code: 'DEP-ADAPTER' };
    case 'feature-contract':
      return { allowed: sameFeature('feature-contract') || same('domain'), code: 'DEP-CONTRACT' };
    case 'feature-implementation':
      return {
        allowed: sameFeature('feature-implementation') || sameFeature('feature-contract') || same('domain') || same('main-infra'),
        code: 'DEP-IMPLEMENTATION',
      };
    case 'facade':
      return {
        allowed:
          same('facade') ||
          same('feature-contract') ||
          same('domain') ||
          (same('shared') && target.relativePath === 'shared/types.ts'),
        code: 'DEP-FACADE',
      };
    case 'preload':
      return { allowed: same('shared'), code: 'DEP-PRELOAD' };
    case 'renderer':
      return { allowed: same('renderer') || same('shared'), code: 'DEP-RENDERER' };
    case 'main-ipc':
      return { allowed: same('facade') || same('shared'), code: 'DEP-IPC' };
    case 'main-index':
      return {
        allowed:
          target.role === 'main-index' ||
          target.role === 'main-ipc' ||
          target.role === 'main-infra' ||
          target.role === 'main-adapter' ||
          target.role === 'main-runtime' ||
          target.role === 'feature-implementation' ||
          target.role === 'facade' ||
          target.role === 'domain' ||
          target.role === 'shared',
        code: 'DEP-ROOT',
      };
    case 'main-runtime':
    case 'unknown':
      return { allowed: false, code: 'DEP-UNKNOWN-SOURCE' };
  }
}

export function evaluateDependency(
  source: ClassifiedModule,
  target: ResolvedDependency,
  analyses: Array<{ module: ClassifiedModule }>,
): ArchitectureViolation | undefined {
  if (target.kind === 'resource') return undefined;
  if (target.kind === 'unresolved') {
    return {
      code: 'DEP_UNRESOLVED',
      message: `Dependency cannot be statically resolved: ${target.specifier ?? '<dynamic path>'}`,
      source,
      reference: target.reference,
      target,
    };
  }
  if (target.kind === 'external') {
    if (externalAllowed(source, target.packageSpecifier ?? target.specifier ?? '')) return undefined;
    return {
      code: 'DEP_EXTERNAL_NOT_ALLOWED',
      message: `External dependency is not registered for ${source.role}: ${target.packageSpecifier ?? target.specifier}`,
      source,
      reference: target.reference,
      target,
    };
  }

  const targetModule = analyses.find((entry) => path.resolve(entry.module.absolutePath) === path.resolve(target.absolutePath ?? ''))?.module;
  if (!targetModule) {
    return {
      code: 'DEP_TARGET_UNCLASSIFIED',
      message: `Source dependency is outside the analyzed source tree: ${target.absolutePath}`,
      source,
      reference: target.reference,
      target,
    };
  }
  const result = sourceAllowed(source, targetModule);
  if (result.allowed) return undefined;
  return {
    code: `DEP_NOT_ALLOWED_${result.code}`,
    message: `Dependency from ${source.role}${source.feature ? ` '${source.feature}'` : ''} to ${targetModule.role}${targetModule.feature ? ` '${targetModule.feature}'` : ''} is not allowed`,
    source,
    reference: target.reference,
    target: { ...target, absolutePath: targetModule.absolutePath },
  };
}

export function formatViolation(violation: ArchitectureViolation): string {
  const line = violation.reference ? `:${violation.reference.line}:${violation.reference.column}` : '';
  const target = violation.target?.specifier ?? violation.target?.absolutePath ?? '<unknown>';
  return `${violation.code} ${violation.source.relativePath}${line} -> ${target}: ${violation.message}`;
}
