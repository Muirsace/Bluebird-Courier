import fs from 'node:fs';
import path from 'node:path';
import type {
  ArchitectureViolation,
  ClassifiedModule,
  DependencyReference,
  ResolvedDependency,
} from './types';
import { classifyModule, listSourceFiles } from './classifier';
import { resolveDependency, resolverOptionsFromTsConfig, type ResolverOptions } from './resolver';
import { scanFile } from './scanner';
import { evaluateDependency } from '../policy';

export interface AnalyzeOptions {
  srcRoot: string;
  resolver?: ResolverOptions;
}

export interface ModuleAnalysis {
  module: ClassifiedModule;
  references: DependencyReference[];
  resolved: ResolvedDependency[];
}

export function analyzeSourceFile(srcRoot: string, filePath: string, options: AnalyzeOptions): ModuleAnalysis {
  const source = fs.readFileSync(filePath, 'utf8');
  const module = classifyModule(srcRoot, filePath);
  const references = scanFile(filePath, source);
  const resolved = references.map((reference) => resolveDependency(filePath, reference, options.resolver));
  return { module, references, resolved };
}

export function analyzeSourceTree(options: AnalyzeOptions): ModuleAnalysis[] {
  const resolver = options.resolver ?? resolverOptionsFromTsConfig(path.join(path.dirname(options.srcRoot), 'tsconfig.json')).options;
  return listSourceFiles(options.srcRoot).map((filePath) => analyzeSourceFile(options.srcRoot, filePath, { ...options, resolver }));
}

export function collectDependencyViolations(options: AnalyzeOptions): ArchitectureViolation[] {
  const analyses = analyzeSourceTree(options);
  const violations: ArchitectureViolation[] = [];
  for (const analysis of analyses) {
    for (const target of analysis.resolved) {
      const violation = evaluateDependency(analysis.module, target, analyses);
      if (violation) violations.push(violation);
    }
  }
  return violations;
}
