import type { ArchitectureViolation, ClassifiedModule, ResolvedDependency } from './types';
import { analyzeSourceTree, type AnalyzeOptions } from './index';

function violation(code: string, message: string, source: ClassifiedModule, target: ResolvedDependency): ArchitectureViolation {
  return { code, message, source, reference: target.reference, target };
}

/** Rules in the skeleton's "额外边界" section that remain statically observable. */
export function collectBoundaryViolations(options: AnalyzeOptions): ArchitectureViolation[] {
  const analyses = analyzeSourceTree(options);
  const violations: ArchitectureViolation[] = [];
  for (const analysis of analyses) {
    for (const target of analysis.resolved) {
      if (target.kind !== 'source' || !target.absolutePath) continue;
      const targetAnalysis = analyses.find((entry) => entry.module.absolutePath === target.absolutePath);
      const targetModule = targetAnalysis?.module;
      if (!targetModule) continue;

      if (
        (analysis.module.role === 'feature-contract' || analysis.module.role === 'feature-implementation') &&
        (targetModule.role === 'feature-contract' || targetModule.role === 'feature-implementation')
      ) {
        if (analysis.module.feature !== targetModule.feature) {
          violations.push(violation('BOUNDARY_CROSS_FEATURE', 'Features must not directly import another feature.', analysis.module, target));
        }
      }

      if (
        (analysis.module.role === 'feature-contract' || analysis.module.role === 'feature-implementation') &&
        targetModule.role === 'main-adapter'
      ) {
        violations.push(violation('BOUNDARY_FEATURE_TO_ADAPTER', 'Features must not directly import core/adapters.', analysis.module, target));
      }

      if (analysis.module.role === 'facade' && targetModule.role === 'feature-implementation') {
        violations.push(violation('BOUNDARY_FACADE_TO_IMPLEMENTATION', 'Facade may import feature contracts only.', analysis.module, target));
      }

      const sameFeatureImplementation =
        analysis.module.role === 'feature-implementation' &&
        targetModule.role === 'feature-implementation' &&
        analysis.module.feature === targetModule.feature;
      if (targetModule.role === 'feature-implementation' && analysis.module.role !== 'main-index' && !sameFeatureImplementation) {
        violations.push(violation('BOUNDARY_IMPLEMENTATION_OWNER', 'Only main/index.ts may import feature implementations.', analysis.module, target));
      }

      if (analysis.module.role === 'main-index' && (targetModule.role === 'preload' || targetModule.role === 'renderer')) {
        violations.push(violation('BOUNDARY_ROOT_TO_UI', 'main/index.ts must not import preload or renderer.', analysis.module, target));
      }

      if (
        analysis.module.role === 'renderer' &&
        (targetModule.role === 'domain' || targetModule.role === 'preload' || targetModule.role.startsWith('main-'))
      ) {
        violations.push(violation('BOUNDARY_RENDERER_TO_BACKEND', 'Renderer must consume shared contracts through preload and cannot import backend layers.', analysis.module, target));
      }
    }
  }

  return violations;
}
