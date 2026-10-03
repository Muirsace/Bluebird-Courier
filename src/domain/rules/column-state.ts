import type { ColumnStatus } from '../types';
export interface ColumnResponse<T = unknown> { status: number; value?: T | null; error?: unknown; unsupported?: boolean; }
export interface ClassifiedColumn<T = unknown> { status: ColumnStatus; value: T | null; error: unknown | null; }
/** 将适配器响应归类为详情栏目状态。 */
export function classifyColumnResponse<T>(response: ColumnResponse<T>): ClassifiedColumn<T> {
  if (response.unsupported) return { status: 'unsupported', value: null, error: response.error ?? null };
  if (response.status === 401 || response.status === 403) return { status: 'forbidden', value: null, error: response.error ?? null };
  if (response.status < 200 || response.status >= 300) return { status: 'failed', value: null, error: response.error ?? null };
  const value = response.value ?? null;
  if (value == null || (Array.isArray(value) && value.length === 0) || value === '') return { status: 'empty', value, error: null };
  return { status: 'success', value, error: null };
}
export const classifyColumn = classifyColumnResponse;
export const toColumnState = classifyColumnResponse;
