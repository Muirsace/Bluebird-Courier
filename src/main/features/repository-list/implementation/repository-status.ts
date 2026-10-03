import type { LocalDatabase } from '../../../core/infra/database';
import type { GlanceValues } from '../../../../domain/types';

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
