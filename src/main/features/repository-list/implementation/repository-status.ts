import type { LocalDatabase } from '../../../core/infra/database';
import type { ActivityKind, GlanceValues, RepositoryObservation } from '../../../../domain/types';

export function writeRepositoryGlance(db: LocalDatabase, id: number, values: GlanceValues, fetchedAt: string): void {
  const candidateFullName = (values as GlanceValues & { fullName?: unknown }).fullName;
  const slash = typeof candidateFullName === 'string' ? candidateFullName.indexOf('/') : -1;
  const owner = typeof candidateFullName === 'string' && slash > 0 ? candidateFullName.slice(0, slash) : null;
  const name = typeof candidateFullName === 'string' && slash > 0 ? candidateFullName.slice(slash + 1) : null;
  db.prepare(
    `UPDATE repository
       SET owner = COALESCE(?, owner), name = COALESCE(?, name), full_name = COALESCE(?, full_name),
           stars = ?, forks = ?, open_issues = ?, pushed_at = ?, latest_release_tag = ?, fetched_at = ?,
           code_activity_at = ?, collaboration_activity_at = ?, repository_status = ?, last_success_at = ?, last_error_kind = NULL, last_error_message = NULL
     WHERE id = ?`,
  ).run(owner, name, owner && name ? candidateFullName : null, values.stars, values.forks, values.openIssues, values.pushedAt, values.latestReleaseTag, fetchedAt, values.pushedAt, values.collaborationAt ?? null, values.status ?? 'active', fetchedAt, id);
}

export interface ObservedGlanceWrite {
  values: GlanceValues;
  /** 合并后的完整观察（含 CheckedSignal 状态与活动候选）；与 Summary 同事务保存。 */
  observation: RepositoryObservation;
  activityAt: string | null;
  activityKind: ActivityKind | null;
  accessContextRevision: number;
  fetchedAt: string;
}

/** 保存一次成功观察的摘要值、统一活动结果与观察快照；失败路径不得调用（保留旧值）。 */
export function writeObservedGlance(db: LocalDatabase, id: number, write: ObservedGlanceWrite): void {
  const { values } = write;
  const [owner, name] = write.observation.fullName.split('/');
  db.prepare(
    `UPDATE repository
       SET owner = ?, name = ?, full_name = ?,
           stars = ?, forks = ?, open_issues = ?, pushed_at = ?, latest_release_tag = ?, latest_tag = ?,
           code_activity_at = ?, collaboration_activity_at = ?, repository_status = ?,
           activity_at = ?, activity_kind = ?, observation_json = ?, access_context_revision = ?,
           fetched_at = ?, last_success_at = ?, last_error_kind = NULL, last_error_message = NULL
     WHERE id = ?`,
  ).run(
    owner, name, write.observation.fullName,
    values.stars, values.forks, values.openIssues, values.pushedAt, values.latestReleaseTag, values.latestTag ?? null,
    values.pushedAt, values.collaborationAt ?? null, values.status ?? 'active',
    write.activityAt, write.activityKind, JSON.stringify(write.observation), write.accessContextRevision,
    write.fetchedAt, write.fetchedAt, id,
  );
}
