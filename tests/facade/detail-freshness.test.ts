import { afterEach, describe, expect, it } from 'vitest';
import { DETAIL_VERIFICATION_TTL_MS } from '../../src/domain/rules/refresh-window';
import { createHarness, type Harness } from '../helpers/harness';

let harness: Harness | null = null;

function h(): Harness {
  if (!harness) throw new Error('harness not created');
  return harness;
}

afterEach(() => {
  harness?.destroy();
  harness = null;
});

function seedLocalDetail(lastCheckedAt: string | null, overrides: {
  detectedRevision?: number;
  syncedRevision?: number;
  dirtyReasons?: string[];
  freshness?: 'fresh' | 'stale' | 'unknown';
  lastSyncedAt?: string | null;
} = {}): void {
  const id = 1;
  const now = h().clock.now().toISOString();
  h().db.prepare(
    'INSERT INTO repository (owner, name, full_name, added_at, stars, forks, open_issues) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('octo-demo', 'hello-world', 'octo-demo/hello-world', now, 10, 2, 3);
  const payload = JSON.stringify({
    repositoryId: id,
    fullName: 'octo-demo/hello-world',
    values: { commits: [{ sha: 'sha-1', message: 'cached', authorName: null, committedAt: now }] },
    columns: {},
    fetchedAt: now,
    source: 'fresh',
  });
  h().db.prepare(
    'INSERT INTO detail_cache (repository_id, payload, fetched_at, source_updated_at, schema_version, access_context_revision, complete_fetched_at) VALUES (?, ?, ?, NULL, 1, 0, ?)',
  ).run(id, payload, now, now);
  h().db.prepare(
    `INSERT INTO detail_scope_state (
      repository_id, scope, cache_status, freshness, check_status, sync_status,
      detected_revision, synced_revision, important_revision, viewed_revision, dirty_reasons,
      synced_fingerprint, last_checked_at, last_synced_at, access_context_revision
    ) VALUES (?, 'commits', 'valid', ?, 'idle', 'idle', ?, ?, 0, 0, ?, 'baseline', ?, ?, 0)`,
  ).run(id, overrides.freshness ?? 'fresh', overrides.detectedRevision ?? 0, overrides.syncedRevision ?? 0,
    JSON.stringify(overrides.dirtyReasons ?? []), lastCheckedAt, overrides.lastSyncedAt === undefined ? now : overrides.lastSyncedAt);
}

describe('详情只读新鲜度', () => {
  it('共享30分钟 TTL：边界前 fresh，到期变 unknown，且 view/status 一致', async () => {
    harness = createHarness({ now: new Date('2026-10-09T00:00:00.000Z') });
    seedLocalDetail(new Date(h().clock.now().getTime() - DETAIL_VERIFICATION_TTL_MS + 1).toISOString());

    const freshStatus = await h().facade.readLocalDetail(1, { mode: 'status' });
    const freshView = await h().facade.readLocalDetail(1, { scopes: ['commits'] });
    expect(freshStatus.syncState.commits?.freshness).toBe('fresh');
    expect(freshView.syncState.commits?.freshness).toBe('fresh');

    h().clock.advanceMs(1);
    const writesBefore = (h().db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const expiredStatus = await h().facade.readLocalDetail(1, { mode: 'status' });
    const expiredView = await h().facade.readLocalDetail(1, { scopes: ['commits'] });
    expect(expiredStatus.syncState.commits?.freshness).toBe('unknown');
    expect(expiredView.syncState.commits?.freshness).toBe('unknown');
    expect((h().db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(writesBefore);
    expect(h().github.calls).toEqual({});
  });

  it('缺少、无效或未来的验证时间，以及只有同步时间的状态都为 unknown', async () => {
    harness = createHarness({ now: new Date('2026-10-09T00:00:00.000Z') });
    seedLocalDetail(null, { lastSyncedAt: h().clock.now().toISOString() });
    for (const lastCheckedAt of [null, 'not-a-time', '2026-10-09T00:00:00.001Z']) {
      h().db.prepare("UPDATE detail_scope_state SET last_checked_at = ? WHERE repository_id = 1 AND scope = 'commits'").run(lastCheckedAt);
      const result = await h().facade.readLocalDetail(1, { mode: 'status' });
      expect(result.syncState.commits?.freshness).toBe('unknown');
    }
    h().db.prepare("UPDATE detail_scope_state SET last_checked_at = '2026-10-09T00:00:00.000Z' WHERE repository_id = 1 AND scope = 'commits'").run();
    h().clock.set(new Date('2026-10-08T23:59:59.999Z'));
    expect((await h().facade.readLocalDetail(1, { mode: 'status' })).syncState.commits?.freshness).toBe('unknown');
    h().clock.set(new Date(Number.NaN));
    expect((await h().facade.readLocalDetail(1, { mode: 'status' })).syncState.commits?.freshness).toBe('unknown');
    expect(h().github.calls).toEqual({});
  });

  it('已知 dirty 在 TTL 过期后仍优先 stale', async () => {
    harness = createHarness({ now: new Date('2026-10-09T00:00:00.000Z') });
    seedLocalDetail('2026-10-08T22:00:00.000Z', {
      detectedRevision: 2,
      syncedRevision: 1,
      dirtyReasons: ['head'],
      freshness: 'stale',
    });

    const status = await h().facade.readLocalDetail(1, { mode: 'status' });
    const view = await h().facade.readLocalDetail(1, { scopes: ['commits'] });
    expect(status.syncState.commits?.freshness).toBe('stale');
    expect(view.syncState.commits?.freshness).toBe('stale');
  });

  it('旧检查时间仍有效也不把新同步或失败验证的unknown恢复成fresh', async () => {
    harness = createHarness({ now: new Date('2026-10-09T00:00:00.000Z') });
    seedLocalDetail('2026-10-08T23:59:59.000Z', { freshness: 'unknown' });
    expect((await h().facade.readLocalDetail(1, { mode: 'status' })).syncState.commits?.freshness).toBe('unknown');
    h().db.prepare("UPDATE detail_scope_state SET freshness='fresh',check_status='error',last_check_error='验证失败' WHERE repository_id=1 AND scope='commits'").run();
    expect((await h().facade.readLocalDetail(1, { mode: 'status' })).syncState.commits?.freshness).toBe('unknown');
    expect(h().github.calls).toEqual({});
  });

  it('有界读取发现栏目损坏不同时宣称fresh，已知dirty仍为stale', async () => {
    harness = createHarness({ now: new Date('2026-10-09T00:00:00.000Z') });
    seedLocalDetail(h().clock.now().toISOString());
    h().db.prepare("UPDATE detail_cache SET payload=json_set(payload,'$.values.commits',json('[null]')) WHERE repository_id=1").run();
    const writesBefore = (h().db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    expect((await h().facade.readLocalDetail(1, { scopes: ['commits'] })).syncState.commits)
      .toMatchObject({ cacheStatus: 'invalid', freshness: 'unknown' });
    expect((h().db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(writesBefore);
    h().db.prepare("UPDATE detail_scope_state SET detected_revision=2,synced_revision=1 WHERE repository_id=1 AND scope='commits'").run();
    expect((await h().facade.readLocalDetail(1, { scopes: ['commits'] })).syncState.commits)
      .toMatchObject({ cacheStatus: 'invalid', freshness: 'stale' });
    expect(h().github.calls).toEqual({});
  });

  it('离线且没有令牌时仍只读缓存，不联网、不写验证时间或账本', async () => {
    harness = createHarness({ now: new Date('2026-10-09T00:00:00.000Z') });
    seedLocalDetail('2026-10-08T23:59:59.000Z');
    h().github.networkDown = true;
    const before = (h().db.prepare("SELECT last_checked_at, last_synced_at, detected_revision, synced_revision FROM detail_scope_state WHERE repository_id = 1 AND scope = 'commits'").get() as Record<string, unknown>);
    const writesBefore = (h().db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

    expect(await h().facade.accessTokenState()).toMatchObject({ configured: false });
    const status = await h().facade.readLocalDetail(1, { mode: 'status' });
    const view = await h().facade.readLocalDetail(1, { scopes: ['commits'] });

    expect(status.syncState.commits?.freshness).toBe('fresh');
    expect(view.syncState.commits?.freshness).toBe('fresh');
    expect(view.detail?.commits).toHaveLength(1);
    expect(h().github.calls).toEqual({});
    expect((h().db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(writesBefore);
    expect(h().db.prepare("SELECT last_checked_at, last_synced_at, detected_revision, synced_revision FROM detail_scope_state WHERE repository_id = 1 AND scope = 'commits'").get()).toEqual(before);
  });
});
