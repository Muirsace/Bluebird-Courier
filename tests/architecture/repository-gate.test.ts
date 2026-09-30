import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectBoundaryViolations } from './analyzer/boundaries';
import { collectContractViolations } from './analyzer/contracts';
import { collectDependencyViolations } from './analyzer';
import { scanStructure } from './analyzer/classifier';
import { formatViolation } from './policy';

const srcRoot = path.resolve(process.cwd(), 'src');

describe('repository architecture gate', () => {
  it('keeps the real src tree inside the documented skeleton', () => {
    const structure = scanStructure(srcRoot).map((entry) => `${entry.code} ${entry.path}: ${entry.message}`);
    const dependencies = collectDependencyViolations({ srcRoot }).map(formatViolation);
    const boundaries = collectBoundaryViolations({ srcRoot }).map(formatViolation);
    const contracts = collectContractViolations({ srcRoot }).map(formatViolation);
    const violations = [...structure, ...dependencies, ...boundaries, ...contracts];

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
