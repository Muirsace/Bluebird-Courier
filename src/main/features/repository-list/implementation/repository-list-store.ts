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

/**
 * 交接记录的结构可用性：只有通过校验的观察才交给详情应用。
 * 结构损坏的记录无法通过重试修复，隔离它们以免坏前缀每次重放都占用预算、饿死后续有效观察。
 */
function isValidChangeSet(value: unknown, repositoryId: number): value is RepoChangeSet {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.repoId !== repositoryId) return false;
  if (!Array.isArray(candidate.affectedScopes) || !candidate.affectedScopes.every((scope) => typeof scope === 'string')) return false;
  return typeof candidate.detectedAt === 'string' && Number.isFinite(Date.parse(candidate.detectedAt));
}

function parsesAsValidChangeSet(raw: string, repositoryId: number): boolean {
  try { return isValidChangeSet(JSON.parse(raw) as unknown, repositoryId); } catch { return false; }
}

/** 隔离一条不可修复的交接记录：保留原始行供审计，但不再参与后续重放。 */
export function quarantineObservationHandoff(db: LocalDatabase, observationId: string, quarantinedAt: string): void {
  db.prepare('UPDATE observation_handoff SET quarantined_at = ? WHERE observation_id = ? AND quarantined_at IS NULL').run(quarantinedAt, observationId);
}

/**
 * 有界扫描未确认交接并隔离结构中不可修复的损坏记录（含无法解析的 JSON）。
 * 返回本批扫描区间，供调用方继续推进；已被隔离的记录不再重复扫描，因此进度可以跨批次累积。
 */
export function quarantineInvalidObservations(db: LocalDatabase, limit: number, filter: { repositoryId?: number; afterObservationId?: string }, quarantinedAt: string): { scanned: number; quarantined: number; lastScannedObservationId: string | null } {
  const rows = db.prepare(
    'SELECT observation_id, repository_id, change_set FROM observation_handoff WHERE applied_at IS NULL AND quarantined_at IS NULL AND (? IS NULL OR repository_id = ?) AND (? IS NULL OR (detected_at, rowid) > (SELECT detected_at, rowid FROM observation_handoff WHERE observation_id = ?)) ORDER BY detected_at ASC, rowid ASC LIMIT ?',
  ).all(filter.repositoryId ?? null, filter.repositoryId ?? null, filter.afterObservationId ?? null, filter.afterObservationId ?? null, limit) as Array<{ observation_id: string; repository_id: number; change_set: string }>;
  let quarantined = 0;
  for (const row of rows) {
    if (parsesAsValidChangeSet(row.change_set, row.repository_id)) continue;
    quarantineObservationHandoff(db, row.observation_id, quarantinedAt);
    quarantined += 1;
  }
  return { scanned: rows.length, quarantined, lastScannedObservationId: rows.length > 0 ? rows[rows.length - 1]!.observation_id : null };
}

/**
 * 读取待交接观察（未确认、未被隔离，按检测时间升序）。
 * 可重试的失败仍保持待交接，供后续重放继续尝试；不可修复的损坏记录由隔离扫描先行清除。
 */
export function readPendingObservations(db: LocalDatabase, limit: number, filter: { repositoryId?: number; accessContextRevision?: number; afterObservationId?: string }): ObservationHandoff[] {
  const rows = db.prepare(
    'SELECT observation_id, repository_id, detected_at, access_context_revision, change_set FROM observation_handoff WHERE applied_at IS NULL AND quarantined_at IS NULL AND json_valid(change_set) AND (? IS NULL OR repository_id = ?) AND (? IS NULL OR access_context_revision = ?) AND (? IS NULL OR (detected_at, rowid) > (SELECT detected_at, rowid FROM observation_handoff WHERE observation_id = ?)) ORDER BY detected_at ASC, rowid ASC LIMIT ?',
  ).all(filter.repositoryId ?? null, filter.repositoryId ?? null, filter.accessContextRevision ?? null, filter.accessContextRevision ?? null, filter.afterObservationId ?? null, filter.afterObservationId ?? null, limit) as Array<{ observation_id: string; repository_id: number; detected_at: string; access_context_revision: number; change_set: string }>;
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
      // 无法解析的记录由隔离扫描处理，这里跳过；不影响其他观察。
    }
  }
  return result;
}

/** 确认交接已由详情应用（幂等）：未确认时置位返回 true，重复确认返回 false。 */
export function confirmObservationHandoff(db: LocalDatabase, observationId: string, confirmedAt: string): boolean {
  const info = db.prepare('UPDATE observation_handoff SET applied_at = ? WHERE observation_id = ? AND applied_at IS NULL').run(confirmedAt, observationId);
  return info.changes > 0;
}

/** 原始队列按持久行位置有界扫描；坏结构隔离、合法失败保留，到尾后下次从头重试。 */
export function nextObservationReplayPage(db: LocalDatabase, limit: number, revision: number, repositoryId: number | undefined, now: string): { observations: ObservationHandoff[]; reachedEnd: boolean } {
  return db.transaction(() => {
    const key = repositoryId ?? 0;
    const cursor = (db.prepare('SELECT last_rowid FROM observation_replay_cursor WHERE queue_key = ?').get(key) as { last_rowid: number } | undefined)?.last_rowid ?? 0;
    const rows = db.prepare('SELECT rowid AS position, observation_id, repository_id, detected_at, access_context_revision, change_set FROM observation_handoff WHERE rowid > ? AND applied_at IS NULL AND quarantined_at IS NULL AND access_context_revision = ? AND (? IS NULL OR repository_id = ?) ORDER BY rowid LIMIT ?').all(cursor, revision, repositoryId ?? null, repositoryId ?? null, limit) as Array<{ position: number; observation_id: string; repository_id: number; detected_at: string; access_context_revision: number; change_set: string }>;
    const observations: ObservationHandoff[] = [];
    for (const row of rows) {
      if (!parsesAsValidChangeSet(row.change_set, row.repository_id)) {
        quarantineObservationHandoff(db, row.observation_id, now);
      } else observations.push({ observationId: row.observation_id, repoId: row.repository_id, detectedAt: row.detected_at, accessContextRevision: row.access_context_revision, changeSet: JSON.parse(row.change_set) as RepoChangeSet });
    }
    const last = rows[rows.length - 1]?.position ?? cursor;
    const reachedEnd = rows.length < limit || !db.prepare('SELECT 1 FROM observation_handoff WHERE rowid > ? AND applied_at IS NULL AND quarantined_at IS NULL AND access_context_revision = ? AND (? IS NULL OR repository_id = ?) LIMIT 1').get(last, revision, repositoryId ?? null, repositoryId ?? null);
    // 应用前持久推进：崩溃不会丢资料，队尾回绕会再试尚未确认的行。
    db.prepare('INSERT INTO observation_replay_cursor (queue_key, last_rowid) VALUES (?, ?) ON CONFLICT(queue_key) DO UPDATE SET last_rowid = excluded.last_rowid').run(key, reachedEnd ? 0 : last);
    return { observations, reachedEnd };
  })();
}
