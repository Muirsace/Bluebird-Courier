import type { ColumnName, ColumnResult } from '../contract';

export function aggregateColumns(values: Record<ColumnName, unknown>): Partial<Record<ColumnName, ColumnResult>> {
  const columns: Partial<Record<ColumnName, ColumnResult>> = {};
  for (const [name, value] of Object.entries(values) as Array<[ColumnName, unknown]>) {
    const empty = Array.isArray(value) ? value.length === 0 : value === null || value === '';
    columns[name] = { status: empty ? 'empty' : 'success', value, error: null };
  }
  if (!columns.tags) columns.tags = { status: 'unsupported', value: null, error: null };
  if (!columns.readme) columns.readme = { status: 'unsupported', value: null, error: null };
  if (!columns.tree) columns.tree = { status: 'unsupported', value: null, error: null };
  return columns;
}
