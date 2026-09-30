import fs from 'node:fs';
import path from 'node:path';
import type { ArchitectureViolation, ClassifiedModule, ResolvedDependency } from './types';
import { analyzeSourceTree, type AnalyzeOptions } from './index';
import { tokenizeSource, type LexicalToken } from './scanner';

function contractViolation(code: string, message: string, source: ClassifiedModule, target?: ResolvedDependency): ArchitectureViolation {
  return { code, message, source, reference: target?.reference, target };
}

function tokenValue(tokens: LexicalToken[], index: number): string | undefined {
  return tokens[index]?.value;
}

function matchingBrace(tokens: LexicalToken[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]?.value === '{') depth += 1;
    if (tokens[index]?.value === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return tokens.length;
}

function hasStaticChannelDeclaration(tokens: LexicalToken[], name: string): boolean {
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (tokens[index]?.value !== 'const' || tokens[index + 1]?.value !== name) continue;
    let equals = index + 2;
    while (tokens[equals] && tokens[equals]!.value !== '=' && tokens[equals]!.value !== ';') equals += 1;
    if (tokens[equals]?.value !== '=') continue;
    return tokens[equals + 1]?.value === '{' || tokens[equals + 1]?.kind === 'string';
  }
  return false;
}

function isStaticChannelExpression(tokens: LexicalToken[], start: number): boolean {
  const first = tokens[start];
  if (!first) return false;
  if (first.kind === 'string') return tokens[start + 1]?.value === ',' || tokens[start + 1]?.value === ')';
  if (first.kind !== 'identifier') return false;
  let index = start + 1;
  let memberDepth = 0;
  while (tokens[index]?.value === '.' && tokens[index + 1]?.kind === 'identifier') {
    memberDepth += 1;
    index += 2;
  }
  return memberDepth > 0 && hasStaticChannelDeclaration(tokens, first.value) && (tokens[index]?.value === ',' || tokens[index]?.value === ')');
}

function sharedIpcBindings(tokens: LexicalToken[]): Set<string> {
  const bindings = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== 'import') continue;
    let end = index + 1;
    while (end < tokens.length && tokens[end]?.value !== 'from' && tokens[end]?.value !== ';') end += 1;
    const module = tokens[end + 1];
    if (tokens[end]?.value !== 'from' || module?.kind !== 'string' || !module.value.endsWith('/shared/ipc')) continue;
    if (tokens[index + 1]?.value === 'type') continue;
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (tokens[cursor]?.value === 'type') {
        cursor += 1;
        continue;
      }
      if (tokens[cursor]?.value === 'as' && tokens[cursor + 1]?.kind === 'identifier') bindings.add(tokens[cursor + 1]!.value);
      else if (tokens[cursor]?.kind === 'identifier' && !['type', 'from', 'as'].includes(tokens[cursor]!.value)) {
        const previous = tokens[cursor - 1]?.value;
        const next = tokens[cursor + 1]?.value;
        if (previous === '{' || previous === ',' || (next === ',' && previous !== 'as')) bindings.add(tokens[cursor]!.value);
      }
    }
  }
  return bindings;
}

function isImportedChannelExpression(tokens: LexicalToken[], start: number, bindings: Set<string>): boolean {
  const first = tokens[start];
  if (first?.kind !== 'identifier' || !bindings.has(first.value)) return false;
  let index = start + 1;
  while (tokens[index]?.value === '.' && tokens[index + 1]?.kind === 'identifier') index += 2;
  return tokens[index]?.value === ',' || tokens[index]?.value === ')';
}

function inspectPreloadBridge(source: ClassifiedModule, sourceText: string): ArchitectureViolation[] {
  const tokens = tokenizeSource(sourceText);
  const violations: ArchitectureViolation[] = [];
  let exposureCount = 0;
  const forbiddenElectronIdentifiers = new Set([
    'ipcRenderer',
    'ipcMain',
    'webContents',
    'remote',
    'session',
    'contextBridge',
  ]);

  const inspectObject = (start: number): void => {
    const end = matchingBrace(tokens, start);
    let nestedBraces = 0;
    let nestedParens = 0;
    let nestedBrackets = 0;
    for (let member = start + 1; member < end; member += 1) {
      const current = tokens[member];
      if (nestedBraces === 0 && nestedParens === 0 && nestedBrackets === 0) {
        if (current?.value === '.' && tokens[member + 1]?.value === '.' && tokens[member + 2]?.value === '.') {
          violations.push(contractViolation('CONTRACT_PRELOAD_GENERIC_ELECTRON', 'Preload bridge must not spread an unknown Electron capability object.', source));
        }
        if (
          current?.kind === 'identifier' &&
          (tokens[member - 1]?.value === '{' || tokens[member - 1]?.value === ',') &&
          (tokens[member + 1]?.value === ',' || tokens[member + 1]?.value === '}')
        ) {
          violations.push(contractViolation('CONTRACT_PRELOAD_GENERIC_ELECTRON', `Preload bridge contains an unresolved shorthand binding '${current.value}'.`, source));
        }
      }
      if (current?.value === '{') nestedBraces += 1;
      if (current?.value === '}') nestedBraces = Math.max(0, nestedBraces - 1);
      if (current?.value === '(') nestedParens += 1;
      if (current?.value === ')') nestedParens = Math.max(0, nestedParens - 1);
      if (current?.value === '[') nestedBrackets += 1;
      if (current?.value === ']') nestedBrackets = Math.max(0, nestedBrackets - 1);
      if (current?.kind !== 'identifier' || !forbiddenElectronIdentifiers.has(current.value)) continue;
      const next = tokens[member + 1]?.value;
      const afterMember = tokens[member + 3]?.value;
      if (current.value === 'ipcRenderer' && next === '.' && tokens[member + 2]?.value === 'invoke' && afterMember === '(') {
        if (!isStaticChannelExpression(tokens, member + 4)) {
          violations.push(contractViolation('CONTRACT_PRELOAD_GENERIC_ELECTRON', 'Preload bridge invoke calls must use a statically named channel.', source));
        }
        continue;
      }
      violations.push(contractViolation('CONTRACT_PRELOAD_GENERIC_ELECTRON', `Preload bridge exposes generic Electron capability '${current.value}'.`, source));
    }
  };

  const inspectBridgeValue = (valueStart: number): void => {
    const value = tokens[valueStart];
    if (!value) return;
    if (value.value === '{') {
      inspectObject(valueStart);
      return;
    }
    if (value.kind === 'identifier') {
      for (let index = 0; index < tokens.length - 2; index += 1) {
        if (tokens[index]?.value === 'const' && tokens[index + 1]?.value === value.value && tokens[index + 2]?.value === '=' && tokens[index + 3]?.value === '{') {
          inspectObject(index + 3);
          return;
        }
      }
    }
    violations.push(contractViolation('CONTRACT_PRELOAD_GENERIC_ELECTRON', 'Preload bridge must be a statically inspectable constrained object.', source));
  };

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokenValue(tokens, index) !== 'contextBridge' || tokenValue(tokens, index + 1) !== '.' || tokenValue(tokens, index + 2) !== 'exposeInMainWorld' || tokenValue(tokens, index + 3) !== '(') continue;
    exposureCount += 1;
    const name = tokens[index + 4];
    if (name?.kind !== 'string' || name.value !== 'bluebirdCourier') {
      violations.push(contractViolation('CONTRACT_PRELOAD_EXPOSURE', `Preload may expose only window.bluebirdCourier, found '${name?.value ?? '<dynamic>'}'.`, source));
      continue;
    }
    const valueStart = index + 6; // name string, closing paren, then comma
    inspectBridgeValue(valueStart);
  }
  if (exposureCount === 0) {
    violations.push(contractViolation('CONTRACT_PRELOAD_EXPOSURE_MISSING', 'preload/index.ts must expose window.bluebirdCourier through contextBridge.', source));
  }
  return violations;
}

/** Static checks for the shared/preload/main-ipc contract seams. */
export function collectContractViolations(options: AnalyzeOptions): ArchitectureViolation[] {
  const analyses = analyzeSourceTree(options);
  const violations: ArchitectureViolation[] = [];

  for (const analysis of analyses) {
    const sourceText = fs.readFileSync(analysis.module.absolutePath, 'utf8');
    if (analysis.module.role === 'preload') {
      violations.push(...inspectPreloadBridge(analysis.module, sourceText));
    }

    if (analysis.module.role === 'renderer') {
      const tokens = tokenizeSource(sourceText);
      if (tokens.some((token) => token.kind === 'identifier' && ['ipcRenderer', 'ipcMain', 'contextBridge'].includes(token.value))) {
        violations.push(contractViolation('CONTRACT_RENDERER_DIRECT_ELECTRON', 'Renderer must consume the preload bridge rather than Electron IPC primitives.', analysis.module));
      }
    }

    if (analysis.module.role === 'main-ipc') {
      const tokens = tokenizeSource(sourceText);
      const importsSharedIpc = analysis.resolved.some((target) => {
        if (target.kind !== 'source' || !target.absolutePath) return false;
        return path.relative(options.srcRoot, target.absolutePath).split(path.sep).join('/') === 'shared/ipc.ts';
      });
      if (!importsSharedIpc) {
        violations.push(contractViolation('CONTRACT_MAIN_IPC_CHANNEL_SOURCE', 'main/ipc must source channel definitions from shared/ipc.ts.', analysis.module));
      }
      const importedChannelBindings = sharedIpcBindings(tokens);
      for (let index = 0; index < tokens.length; index += 1) {
        if (tokenValue(tokens, index) !== 'ipcMain' || tokenValue(tokens, index + 1) !== '.' || !['handle', 'on', 'once', 'removeHandler'].includes(tokenValue(tokens, index + 2) ?? '') || tokenValue(tokens, index + 3) !== '(') continue;
        if (!isImportedChannelExpression(tokens, index + 4, importedChannelBindings)) {
          violations.push(contractViolation('CONTRACT_MAIN_IPC_CHANNEL_LITERAL', 'main/ipc must use channel constants from shared/ipc.ts.', analysis.module));
        }
      }
    }

    for (const target of analysis.resolved) {
      if (target.kind !== 'source' || !target.absolutePath) continue;
      const targetRelative = path.relative(options.srcRoot, target.absolutePath).split(path.sep).join('/');
      if (analysis.module.role === 'facade' && targetRelative.startsWith('shared/') && targetRelative !== 'shared/types.ts') {
        violations.push(contractViolation('CONTRACT_FACADE_SHARED_SOURCE', 'Facade may consume shared/types.ts for result contracts.', analysis.module, target));
      }
    }
  }
  return violations;
}
