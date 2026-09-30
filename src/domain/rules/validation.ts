/** Runtime validation for values arriving through IPC or other untyped seams. */
export function isRepositoryId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Accept a settings patch only when every value is a string. */
export function normalizeStringPatch(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const patch: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null;
    patch[key] = item;
  }
  return patch;
}

/** Alias with a descriptive name for callers that validate preferences. */
export const validatePreferencesPatch = normalizeStringPatch;
