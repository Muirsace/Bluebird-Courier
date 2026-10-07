import { resolveActivity } from '../../../../domain/rules/activity-sort';
import type { LocalDatabase } from '../../../core/infra/database';
import type {
  ActivityKind,
  FetchedGlance,
  Glance,
  ObservationHandoff,
  RepoChangeSet,
  RepositoryObservation,
} from '../../../../domain/types';

interface RepositoryRow {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  added_at: string;
  stars: number | null;
  forks: number | null;
  open_issues: number | null;
  pushed_at: string | null;
  latest_release_tag: string | null;
  fetched_at: string | null;
  latest_tag?: string | null;
  collaboration_activity_at?: string | null;
  code_activity_at?: string | null;
  repository_status?: 'active' | 'archived' | 'deleted' | 'renamed';
  last_error_kind?: string | null;
  last_error_message?: string | null;
  last_success_at?: string | null;
  observation_json?: string | null;
  activity_at?: string | null;
  activity_kind?: string | null;
  access_context_revision?: number | null;
}

export function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function rowToGlance(row: RepositoryRow): Glance {
  const legacy = resolveActivity([
    { kind: 'code', at: row.code_activity_at ?? row.pushed_at, important: true, verified: false },
    { kind: 'issue', at: row.collaboration_activity_at ?? null, important: true, verified: true },
  ], row.fetched_at ?? row.added_at);
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    addedAt: row.added_at,
    stars: row.stars,
    forks: row.forks,
    openIssues: row.open_issues,
    pushedAt: row.pushed_at,
    latestReleaseTag: row.latest_release_tag,
    fetchedAt: row.fetched_at,
    latestTag: row.latest_tag ?? null,
    collaborationAt: row.collaboration_activity_at ?? null,
    // 已观察行的 null 是有效聚合结论；不得重新启用被规则拒绝的推送时间。
    activityAt: row.observation_json ? row.activity_at ?? null : legacy.at,
    activityKind: row.observation_json ? (row.activity_kind as ActivityKind | null | undefined) ?? null : legacy.kind,
    status: row.repository_status ?? 'active',
    lastSucceededAt: row.last_success_at ?? row.fetched_at,
    failure: row.last_error_kind && row.last_error_message ? { kind: row.last_error_kind as import('../../../../domain/types').ErrorKind, message: row.last_error_message, fullName: row.full_name } : null,
  };
}

export function readRow(db: LocalDatabase, id: number): RepositoryRow | null {
  return (db.prepare('SELECT * FROM repository WHERE id = ?').get(id) as RepositoryRow | undefined) ?? null;
}

export function readRowByFullName(db: LocalDatabase, fullName: string): RepositoryRow | null {
  return (db.prepare('SELECT * FROM repository WHERE full_name = ? COLLATE NOCASE').get(fullName) as RepositoryRow | undefined) ?? null;
}

export function insertFetched(db: LocalDatabase, values: FetchedGlance, capturedAt: string): number {
  const slash = values.fullName.indexOf('/');
  const owner = slash < 0 ? values.fullName : values.fullName.slice(0, slash);
  const name = slash < 0 ? '' : values.fullName.slice(slash + 1);
  const result = db.prepare(
    `INSERT INTO repository (owner, name, full_name, added_at, stars, forks, open_issues, pushed_at, latest_release_tag, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(owner, name, values.fullName, capturedAt, values.stars, values.forks, values.openIssues, values.pushedAt, values.latestReleaseTag, capturedAt);
  return Number(result.lastInsertRowid);
}

/** 读取最近一次成功观察快照；缺失或损坏时返回 null（不可比较，不冒充基线）。 */
export function readStoredObservation(row: RepositoryRow): RepositoryObservation | null {
  if (!row.observation_json) return null;
  try {
    const parsed = JSON.parse(row.observation_json) as RepositoryObservation;
    if (typeof parsed !== 'object' || parsed === null ||
        !Number.isSafeInteger(parsed.accessContextRevision) || typeof parsed.observedAt !== 'string' ||
        typeof parsed.fullName !== 'string' || !parsed.values || !parsed.signals || !parsed.activity) return null;
    const validSignal = (value: unknown): boolean => typeof value === 'object' && value !== null &&
      ((value as { state?: unknown }).state === 'known' || (value as { state?: unknown }).state === 'unknown');
    const validCandidate = (value: unknown): boolean => typeof value === 'object' && value !== null &&
      ['code', 'release', 'pull-request', 'issue'].includes((value as { kind: string }).kind) &&
      ((value as { at?: unknown }).at === null || typeof (value as { at?: unknown }).at === 'string');
    if (!Object.values(parsed.signals).every(validSignal) ||
        !['defaultBranch', 'headRevision', 'releaseRevision', 'tagRevision'].every(key => key in parsed.signals) ||
        ![parsed.activity.code, parsed.activity.release, parsed.activity.collaboration].every(validCandidate)) return null;
    return { ...parsed, repoId: row.id };
  } catch {
    return null;
  }
}

/** 追加待交接观察；observation_id 唯一，重复交接按主键去重。 */
export function insertObservationHandoff(
  db: LocalDatabase,
  entry: { observationId: string; repositoryId: number; detectedAt: string; accessContextRevision: number; changeSet: RepoChangeSet },
): void {
  db.prepare(
    'INSERT INTO observation_handoff (observation_id, repository_id, detected_at, access_context_revision, change_set, applied_at) VALUES (?, ?, ?, ?, ?, NULL)',
  ).run(entry.observationId, entry.repositoryId, entry.detectedAt, entry.accessContextRevision, JSON.stringify(entry.changeSet));
}

/** 读取待交接观察（未确认，按检测时间升序）。 */
export function readPendingObservations(db: LocalDatabase, limit: number): ObservationHandoff[] {
  const rows = db.prepare(
    'SELECT observation_id, repository_id, detected_at, access_context_revision, change_set FROM observation_handoff WHERE applied_at IS NULL ORDER BY detected_at ASC, rowid ASC LIMIT ?',
  ).all(limit) as Array<{ observation_id: string; repository_id: number; detected_at: string; access_context_revision: number; change_set: string }>;
  const result: ObservationHandoff[] = [];
  for (const row of rows) {
    try {
      result.push({
        observationId: row.observation_id,
        repoId: row.repository_id,
        detectedAt: row.detected_at,
        accessContextRevision: row.access_context_revision,
        changeSet: JSON.parse(row.change_set) as RepoChangeSet,
      });
    } catch {
      // 损坏的交接记录跳过；确认接口仍可按 ID 标记，不影响其他观察。
    }
  }
  return result;
}

/** 确认交接已由详情应用（幂等）：未确认时置位返回 true，重复确认返回 false。 */
export function confirmObservationHandoff(db: LocalDatabase, observationId: string, confirmedAt: string): boolean {
  const info = db.prepare('UPDATE observation_handoff SET applied_at = ? WHERE observation_id = ? AND applied_at IS NULL').run(confirmedAt, observationId);
  return info.changes > 0;
}
