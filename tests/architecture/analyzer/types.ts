import path from 'node:path';

export type DependencyKind =
  | 'import'
  | 'import-type'
  | 'export'
  | 'dynamic-import'
  | 'require';

export interface DependencyReference {
  kind: DependencyKind;
  specifier: string | undefined;
  isStatic: boolean;
  line: number;
  column: number;
}

export type ResolvedDependencyKind = 'source' | 'external' | 'resource' | 'unresolved';

export interface ResolvedDependency {
  kind: ResolvedDependencyKind;
  specifier: string | undefined;
  absolutePath?: string;
  packageSpecifier?: string;
  reference: DependencyReference;
}

export type ModuleRole =
  | 'domain'
  | 'shared'
  | 'preload'
  | 'renderer'
  | 'main-index'
  | 'main-ipc'
  | 'main-infra'
  | 'main-adapter'
  | 'feature-contract'
  | 'feature-implementation'
  | 'facade'
  | 'main-runtime'
  | 'unknown';

export interface ClassifiedModule {
  absolutePath: string;
  relativePath: string;
  role: ModuleRole;
  feature?: string;
  withinSrc: boolean;
}

export interface StructureViolation {
  code: string;
  message: string;
  path: string;
}

export interface ArchitectureViolation {
  code: string;
  message: string;
  source: ClassifiedModule;
  reference?: DependencyReference;
  target?: ResolvedDependency;
}

export function normalizedRelativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}
