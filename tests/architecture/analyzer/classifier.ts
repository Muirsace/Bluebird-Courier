import fs from 'node:fs';
import path from 'node:path';
import type { ClassifiedModule, ModuleRole, StructureViolation } from './types';
import { normalizedRelativePath } from './types';

const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

export function isSourceFile(filePath: string): boolean {
  return sourceExtensions.has(path.extname(filePath).toLowerCase());
}

export function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && isSourceFile(absolute)) files.push(absolute);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files.sort();
}

export function classifyModule(srcRoot: string, filePath: string): ClassifiedModule {
  const absolutePath = path.resolve(filePath);
  const relativePath = normalizedRelativePath(srcRoot, absolutePath);
  const segments = relativePath.split('/');
  const withinSrc = !relativePath.startsWith('../') && relativePath !== '..' && !path.isAbsolute(relativePath);

  if (!withinSrc || segments.length === 0) {
    return { absolutePath, relativePath, role: 'unknown', withinSrc };
  }
  const [top, second, third, fourth] = segments;
  let role: ModuleRole = 'unknown';
  let feature: string | undefined;

  if (top === 'domain') role = 'domain';
  else if (top === 'shared') role = 'shared';
  else if (top === 'preload') role = 'preload';
  else if (top === 'renderer') role = 'renderer';
  else if (top === 'main') {
    if (segments.length === 2 && second === 'index.ts') role = 'main-index';
    else if (segments.length === 2 && second === 'ipc.ts') role = 'main-ipc';
    else if (second === 'core' && third === 'infra') role = 'main-infra';
    else if (second === 'core' && third === 'adapters') role = 'main-adapter';
    else if (second === 'features' && third && fourth === 'contract') {
      role = 'feature-contract';
      feature = third;
    } else if (second === 'features' && third && fourth === 'implementation') {
      role = 'feature-implementation';
      feature = third;
    } else if (second === 'facade') role = 'facade';
    else role = 'main-runtime';
  }

  return { absolutePath, relativePath, role, feature, withinSrc };
}

export function scanStructure(srcRoot: string): StructureViolation[] {
  const violations: StructureViolation[] = [];
  const allowedTop = new Set(['domain', 'shared', 'main', 'preload', 'renderer']);
  const requiredFiles = [
    'domain/types.ts',
    'domain/ports.ts',
    'shared/types.ts',
    'shared/ipc.ts',
    'main/index.ts',
    'main/ipc.ts',
    'preload/index.ts',
  ];
  const files = listSourceFiles(srcRoot);
  const relativeFiles = new Set(files.map((file) => normalizedRelativePath(srcRoot, file)));
  for (const required of requiredFiles) {
    if (!relativeFiles.has(required)) {
      violations.push({ code: 'STRUCTURE_REQUIRED_MISSING', message: `Required skeleton file is missing: src/${required}`, path: required });
    }
  }

  for (const file of files) {
    const relative = normalizedRelativePath(srcRoot, file);
    const segments = relative.split('/');
    const [top, second, third, fourth] = segments;
    if (!top || !allowedTop.has(top)) {
      violations.push({ code: 'STRUCTURE_TOP_LEVEL', message: `Source file is outside an allowed src top-level layer: ${relative}`, path: relative });
      continue;
    }
    if (top === 'main') {
      const isMainEntry = segments.length === 2 && (second === 'index.ts' || second === 'ipc.ts');
      const isCoreArea = segments.length >= 4 && second === 'core' && (third === 'infra' || third === 'adapters');
      const isFeatureSurface =
        segments.length >= 5 &&
        second === 'features' &&
        Boolean(third) &&
        (fourth === 'contract' || fourth === 'implementation');
      const isFacadeArea = segments.length >= 3 && second === 'facade';
      const recognized =
        isMainEntry ||
        isCoreArea ||
        isFeatureSurface ||
        isFacadeArea;
      if (!recognized) {
        violations.push({ code: 'STRUCTURE_MAIN_LOCATION', message: `Main source file is outside the documented main areas: ${relative}`, path: relative });
      }
      if (second === 'features' && third && !fourth) {
        violations.push({ code: 'STRUCTURE_FEATURE_SURFACE', message: `Feature source must be inside contract/ or implementation/: ${relative}`, path: relative });
      }
    }
    if (top === 'domain' && second && !((relative.split('/').length === 2 && (second === 'types.ts' || second === 'ports.ts')) || (second === 'rules' && relative.split('/').length >= 3))) {
      violations.push({ code: 'STRUCTURE_DOMAIN_LOCATION', message: `Domain source is outside types.ts, ports.ts, or rules/: ${relative}`, path: relative });
    }
    if (top === 'shared' && second && !(relative.split('/').length === 2 && (second === 'types.ts' || second === 'ipc.ts'))) {
      violations.push({ code: 'STRUCTURE_SHARED_LOCATION', message: `Shared source must be types.ts or ipc.ts: ${relative}`, path: relative });
    }
    if (top === 'preload' && second && !(relative.split('/').length === 2 && second === 'index.ts')) {
      violations.push({ code: 'STRUCTURE_PRELOAD_LOCATION', message: `Preload source must be index.ts: ${relative}`, path: relative });
    }
    if (top === 'renderer' && second && !['pages', 'components', 'lib'].includes(second)) {
      violations.push({ code: 'STRUCTURE_RENDERER_LOCATION', message: `Renderer source must be inside pages/, components/, or lib/: ${relative}`, path: relative });
    }
  }

  const featureRoots = new Set<string>();
  for (const file of files) {
    const relative = normalizedRelativePath(srcRoot, file);
    const segments = relative.split('/');
    if (segments[0] === 'main' && segments[1] === 'features' && segments[2]) featureRoots.add(segments[2]);
  }
  for (const feature of featureRoots) {
    for (const surface of ['contract', 'implementation']) {
      const surfacePath = path.join(srcRoot, 'main', 'features', feature, surface);
      if (!fs.existsSync(surfacePath) || !fs.statSync(surfacePath).isDirectory()) {
        violations.push({ code: 'STRUCTURE_FEATURE_SURFACE_MISSING', message: `Feature '${feature}' must provide ${surface}/: src/main/features/${feature}/${surface}`, path: `main/features/${feature}/${surface}` });
      }
    }
  }
  return violations;
}
