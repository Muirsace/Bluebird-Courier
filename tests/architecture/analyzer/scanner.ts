import type { DependencyKind, DependencyReference } from './types';

export interface LexicalToken {
  kind: 'identifier' | 'string' | 'template' | 'punctuation';
  value: string;
  start: number;
  end: number;
}

function decodeString(raw: string): string {
  if (raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  return body.replace(/\\([\\'"`nrt])/g, (_match, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    return escaped;
  });
}

/** A small lexical scanner keeps this tool independent of TypeScript 7's compiler API packaging. */
export function tokenizeSource(source: string): LexicalToken[] {
  const tokens: LexicalToken[] = [];
  let index = 0;
  const length = source.length;
  while (index < length) {
    const character = source[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index = Math.min(length, index + 2);
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;
      index += 1;
      while (index < length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      const raw = source.slice(start, index);
      tokens.push({ kind: 'string', value: decodeString(raw), start, end: index });
      continue;
    }
    if (character === '`') {
      const start = index;
      index += 1;
      while (index < length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === '`') {
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({ kind: 'template', value: source.slice(start + 1, Math.max(start + 1, index - 1)), start, end: index });
      continue;
    }
    if (character === '/') {
      const previous = tokens[tokens.length - 1];
      const regexAfterKeyword = previous?.kind === 'identifier' && ['return', 'case', 'throw', 'else', 'do', 'typeof', 'void', 'delete', 'yield', 'await'].includes(previous.value);
      const canStartRegex = !previous || regexAfterKeyword || (previous.kind === 'punctuation' && '=([{,:;!&|?>'.includes(previous.value));
      if (canStartRegex) {
        index += 1;
        let escaped = false;
        while (index < length) {
          const current = source[index]!;
          if (!escaped && current === '/') {
            index += 1;
            while (index < length && /[A-Za-z]/.test(source[index]!)) index += 1;
            break;
          }
          escaped = !escaped && current === '\\';
          if (current !== '\\') escaped = false;
          index += 1;
        }
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < length && /[A-Za-z0-9_$]/.test(source[index]!)) index += 1;
      tokens.push({ kind: 'identifier', value: source.slice(start, index), start, end: index });
      continue;
    }
    const start = index;
    index += 1;
    tokens.push({ kind: 'punctuation', value: character, start, end: index });
  }
  return tokens;
}

function lineAndColumn(source: string, position: number): Pick<DependencyReference, 'line' | 'column'> {
  const before = source.slice(0, position);
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  return { line, column: position - lastBreak };
}

function addReference(
  references: DependencyReference[],
  source: string,
  kind: DependencyKind,
  token: LexicalToken,
  specifier: string | undefined,
  isStatic: boolean,
): void {
  references.push({ kind, specifier, isStatic, ...lineAndColumn(source, token.start) });
}

/** Extract every module edge observable by the architecture policy. */
export function scanDependencies(sourceText: string, _fileName = 'module.ts'): DependencyReference[] {
  const tokens = tokenizeSource(sourceText);
  const dependencies: DependencyReference[] = [];
  const seen = new Set<string>();
  const add = (kind: DependencyKind, token: LexicalToken, specifier: string | undefined, isStatic: boolean) => {
    const key = `${kind}:${token.start}:${specifier ?? '<dynamic>'}`;
    if (!seen.has(key)) {
      seen.add(key);
      addReference(dependencies, sourceText, kind, token, specifier, isStatic);
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== 'identifier') continue;

    if (token.value === 'import') {
      const next = tokens[index + 1];
      if (next?.value === '(') {
        const argument = tokens[index + 2];
        const argumentEnd = tokens[index + 3]?.value;
        const isLiteralArgument = argument?.kind === 'string' && (argumentEnd === ')' || argumentEnd === ',');
        const specifier = isLiteralArgument ? argument.value : undefined;
        const isTypeContext = tokens[index - 3]?.value === 'type' && tokens[index - 1]?.value === '=';
        add(isTypeContext ? 'import-type' : 'dynamic-import', token, specifier, isLiteralArgument);
        continue;
      }

      let end = index + 1;
      if (tokens[end]?.kind === 'string') {
        add('import', token, tokens[end]!.value, true);
        continue;
      }
      while (end < tokens.length && tokens[end]!.value !== ';' && tokens[end]!.value !== 'import' && tokens[end]!.value !== 'export') {
        if (['const', 'let', 'var', 'function', 'class', 'interface'].includes(tokens[end]!.value)) break;
        if (tokens[end]!.value === 'from' && tokens[end + 1]?.kind === 'string') {
          add(tokens[index + 1]?.value === 'type' ? 'import-type' : 'import', token, tokens[end + 1]!.value, true);
          break;
        }
        end += 1;
      }
      continue;
    }

    if (token.value === 'export') {
      let end = index + 1;
      while (end < tokens.length && tokens[end]!.value !== ';' && tokens[end]!.value !== 'import' && tokens[end]!.value !== 'export') {
        if (tokens[end]!.value === 'from' && tokens[end + 1]?.kind === 'string') {
          add('export', token, tokens[end + 1]!.value, true);
          break;
        }
        end += 1;
      }
      continue;
    }

    const directRequire = token.value === 'require' && tokens[index - 1]?.value !== '.' && tokens[index - 1]?.value !== '?';
    const optionalRequire = token.value === 'require' && tokens[index + 1]?.value === '?' && tokens[index + 2]?.value === '.';
    if ((directRequire && tokens[index + 1]?.value === '(') || (optionalRequire && tokens[index + 3]?.value === '(')) {
      const argumentIndex = optionalRequire ? index + 4 : index + 2;
      const argument = tokens[argumentIndex];
      const argumentEnd = tokens[argumentIndex + 1]?.value;
      const isLiteralArgument = argument?.kind === 'string' && argumentEnd === ')';
      add('require', token, isLiteralArgument ? argument.value : undefined, isLiteralArgument);
    }
  }
  return dependencies;
}

export function scanFile(filePath: string, sourceText: string): DependencyReference[] {
  return scanDependencies(sourceText, filePath);
}
