import type { Snapshot } from '../types';
function day(value: string): string { return value.slice(0, 10); }
/** 按仓库同日只保留最后一档，并保留 now 前最近 30 个自然日。 */
export function retainRecentSnapshots<T extends Pick<Snapshot, 'capturedAt'>>(snapshots: readonly T[], now: string | Date, days = 30): T[] {
  const nowDate = now instanceof Date ? now : new Date(now);
  const cutoff = new Date(nowDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const latest = new Map<string, T>();
  for (const snapshot of snapshots) {
    const at = new Date(snapshot.capturedAt);
    if (!Number.isFinite(at.getTime()) || at < cutoff || at > nowDate) continue;
    const key = day(snapshot.capturedAt);
    const previous = latest.get(key);
    if (!previous || new Date(previous.capturedAt) < at) latest.set(key, snapshot);
  }
  return [...latest.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}
export const applySnapshotRetention = retainRecentSnapshots;
export const retainSnapshots = retainRecentSnapshots;
