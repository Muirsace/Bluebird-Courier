import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, openDatabase } from '../../src/main/core/infra/database';
import { createMigrationRunner } from '../../src/main/core/infra/migrations';

const opened: Database.Database[] = [];
const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-db-'));
  tempDirs.push(dir);
  return path.join(dir, 'octo.db');
}

function open(pathname: string): Database.Database {
  const db = openDatabase(pathname);
  opened.push(db);
  return db;
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tableNames(db: Database.Database): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('数据库建表与迁移', () => {
  it('在全新数据库文件上建出 repository / snapshot / setting 三张表', () => {
    const db = open(tempDbPath());
    expect(tableNames(db)).toEqual(expect.arrayContaining(['repository', 'snapshot', 'setting']));
  });

  it('snapshot 以 repository_id + 本地日期 唯一', () => {
    const db = open(tempDbPath());
    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'snapshot'")
      .all() as Array<{ name: string; sql: string | null }>;
    const unique = indexes.find((i) => i.sql?.includes('UNIQUE') && i.sql.includes('repository_id') && i.sql.includes('day'));
    expect(unique).toBeDefined();
  });

  it('重复打开同一数据库文件不报错（迁移幂等）', () => {
    const pathname = tempDbPath();
    open(pathname).close();
    const db = open(pathname);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['repository', 'snapshot', 'setting']));
  });

  it('启用 WAL 与 busy_timeout（写锁冲突时等待而不是立刻抛 SQLITE_BUSY）', () => {
    const db = open(tempDbPath());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('对缺表的旧库补齐新表与缺失列（升级迁移）', () => {
    const pathname = tempDbPath();
    const legacy = new Database(pathname);
    legacy.exec('CREATE TABLE repository (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL UNIQUE)');
    legacy.close();

    const db = open(pathname);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['repository', 'snapshot', 'setting']));

    const columns = (db.pragma('table_info(repository)') as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'owner',
        'name',
        'full_name',
        'added_at',
        'stars',
        'forks',
        'open_issues',
        'pushed_at',
        'latest_release_tag',
        'fetched_at',
      ]),
    );
  });
});

describe('同步记账存储与兼容升级（V3）', () => {
  function seedRepository(db: Database.Database): void {
    db.prepare(
      `INSERT INTO repository (owner, name, full_name, added_at, stars, forks, open_issues, pushed_at, latest_release_tag, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('octo-demo', 'hello-world', 'octo-demo/hello-world', '2026-09-26T12:00:00.000Z', 1284, 96, 23, '2026-09-25T08:30:00.000Z', 'v2.4.0', '2026-09-26T12:00:00.000Z');
  }

  it('升级 V2 旧库：追加同步存储与列，旧清单、详情缓存与快照全部保留', () => {
    const pathname = tempDbPath();
    const legacy = new Database(pathname);
    createMigrationRunner(MIGRATIONS.slice(0, 2)).run(legacy);
    seedRepository(legacy);
    legacy.prepare('INSERT INTO detail_cache (repository_id, payload, fetched_at, source_updated_at) VALUES (1, ?, ?, ?)')
      .run('{"repositoryId":1,"fullName":"octo-demo/hello-world"}', '2026-09-26T12:00:00.000Z', null);
    legacy.prepare('INSERT INTO snapshot (repository_id, captured_at, day, stars, forks, open_issues, latest_release_tag, pushed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(1, '2026-09-26T12:00:00.000Z', '2026-09-26', 1284, 96, 23, 'v2.4.0', '2026-09-25T08:30:00.000Z');
    expect(legacy.pragma('user_version', { simple: true })).toBe(2);
    legacy.close();

    const db = open(pathname);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(tableNames(db)).toEqual(expect.arrayContaining([
      'access_context', 'detail_scope_state', 'observation_handoff', 'sync_task_target', 'cache_query_page',
    ]));

    // 旧资料保留：清单、详情缓存、快照均未被重写
    expect(db.prepare('SELECT full_name, stars FROM repository WHERE id = 1').get()).toEqual({ full_name: 'octo-demo/hello-world', stars: 1284 });
    expect((db.prepare('SELECT payload FROM detail_cache WHERE repository_id = 1').get() as { payload: string }).payload).toContain('octo-demo/hello-world');
    expect(db.prepare('SELECT COUNT(*) AS n FROM snapshot').get()).toEqual({ n: 1 });

    // 新列默认值：本地视图版本从 0 起，缓存身份从 schema 1 / 上下文 0 起
    expect(db.prepare('SELECT view_version FROM repository WHERE id = 1').get()).toEqual({ view_version: 0 });
    expect(db.prepare('SELECT schema_version, access_context_revision FROM detail_cache WHERE repository_id = 1').get()).toEqual({ schema_version: 1, access_context_revision: 0 });
    expect(db.prepare('SELECT revision FROM access_context WHERE id = 1').get()).toEqual({ revision: 0 });

    // 旧缓存不派生范围账本：范围行由所属 feature 初始化，默认从 unknown 起步
    expect(db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state').get()).toEqual({ n: 0 });
  });

  it('V3 已应用后重复打开不重复迁移', () => {
    const pathname = tempDbPath();
    open(pathname).close();
    const db = open(pathname);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['access_context', 'detail_scope_state']));
  });

  it('V4 升级：追加清单观察列且保留旧行，新列默认空 / 0', () => {
    const pathname = tempDbPath();
    const legacy = new Database(pathname);
    createMigrationRunner(MIGRATIONS.slice(0, 3)).run(legacy);
    seedRepository(legacy);
    expect(legacy.pragma('user_version', { simple: true })).toBe(3);
    legacy.close();

    const db = open(pathname);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    const columns = (db.pragma('table_info(repository)') as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['latest_tag', 'observation_json', 'activity_at', 'activity_kind', 'access_context_revision']));
    expect(db.prepare('SELECT full_name, stars, latest_tag, observation_json, activity_at, activity_kind, access_context_revision FROM repository WHERE id = 1').get()).toEqual({
      full_name: 'octo-demo/hello-world',
      stars: 1284,
      latest_tag: null,
      observation_json: null,
      activity_at: null,
      activity_kind: null,
      access_context_revision: 0,
    });
  });

  it('V5 升级：追加详情应用记录与视图版本表，保留旧行', () => {
    const pathname = tempDbPath();
    const legacy = new Database(pathname);
    createMigrationRunner(MIGRATIONS.slice(0, 4)).run(legacy);
    seedRepository(legacy);
    legacy.prepare('INSERT INTO detail_cache (repository_id, payload, fetched_at, source_updated_at) VALUES (1, ?, ?, NULL)')
      .run('{"repositoryId":1,"values":{"releases":[]}}', '2026-09-26T12:00:00.000Z');
    expect(legacy.pragma('user_version', { simple: true })).toBe(4);
    legacy.close();

    const db = open(pathname);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['detail_observation_apply', 'detail_view_state']));
    // 旧详情缓存与清单资料保留
    expect(db.prepare('SELECT full_name FROM repository WHERE id = 1').get()).toEqual({ full_name: 'octo-demo/hello-world' });
    expect(db.prepare('SELECT fetched_at FROM detail_cache WHERE repository_id = 1').get()).toEqual({ fetched_at: '2026-09-26T12:00:00.000Z' });
    // 视图版本从 0 起步；应用记录按 observation_id 幂等
    expect(db.prepare('SELECT view_version FROM detail_view_state WHERE repository_id = 1').get()).toBeUndefined();
    db.prepare('INSERT INTO detail_observation_apply (observation_id, repository_id, applied_at, access_context_revision, affected_scopes) VALUES (?, 1, ?, 0, ?)')
      .run('obs-1', '2026-09-26T12:00:00.000Z', '["commits"]');
    expect(() => db.prepare('INSERT INTO detail_observation_apply (observation_id, repository_id, applied_at, access_context_revision, affected_scopes) VALUES (?, 1, ?, 0, ?)')
      .run('obs-1', '2026-09-26T13:00:00.000Z', '["commits"]')).toThrow(/UNIQUE/);
  });

  it('V6 升级：追加完整详情成功时间列，旧行留空不冒充完整同步', () => {
    const pathname = tempDbPath();
    const legacy = new Database(pathname);
    createMigrationRunner(MIGRATIONS.slice(0, 5)).run(legacy);
    seedRepository(legacy);
    legacy.prepare('INSERT INTO detail_cache (repository_id, payload, fetched_at, source_updated_at, schema_version, access_context_revision) VALUES (1, ?, ?, NULL, 1, 0)')
      .run('{"repositoryId":1,"values":{"releases":[]}}', '2026-09-26T12:00:00.000Z');
    expect(legacy.pragma('user_version', { simple: true })).toBe(5);
    legacy.close();

    const db = open(pathname);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    // 旧缓存的完整时间未知：创建时刻不得冒充完整同步时间
    expect(db.prepare('SELECT fetched_at, complete_fetched_at FROM detail_cache WHERE repository_id = 1').get())
      .toEqual({ fetched_at: '2026-09-26T12:00:00.000Z', complete_fetched_at: null });
    // 新列可独立写入完整成功时间
    db.prepare('UPDATE detail_cache SET complete_fetched_at = ? WHERE repository_id = 1').run('2026-09-26T13:00:00.000Z');
    expect(db.prepare('SELECT complete_fetched_at FROM detail_cache WHERE repository_id = 1').get()).toEqual({ complete_fetched_at: '2026-09-26T13:00:00.000Z' });
  });

  it('迁移中途失败：该版本已写入的内容与 user_version 一起回滚', () => {
    const pathname = tempDbPath();
    const db = new Database(pathname);
    const runner = createMigrationRunner([
      (database) => database.exec('CREATE TABLE first_step (id INTEGER PRIMARY KEY)'),
      (database) => {
        database.exec('CREATE TABLE partial_step (id INTEGER PRIMARY KEY)');
        throw new Error('迁移中途失败');
      },
    ]);
    expect(() => runner.run(db)).toThrow('迁移中途失败');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(tableNames(db)).toContain('first_step');
    expect(tableNames(db)).not.toContain('partial_step');
    db.close();
  });

  it('仅暴露窄迁移接口时也回滚失败版本，修复后可重试', () => {
    const db = new Database(tempDbPath());
    opened.push(db);
    const narrow = {
      exec(sql: string): void { db.exec(sql); },
      pragma(source: string, options?: { simple?: boolean }): unknown { return db.pragma(source, options); },
    };
    const first = (database: typeof narrow): void => database.exec('CREATE TABLE first_step (id INTEGER PRIMARY KEY)');
    const failing = createMigrationRunner([first, (database) => {
      database.exec('CREATE TABLE partial_step (id INTEGER PRIMARY KEY)');
      throw new Error('窄接口迁移失败');
    }]);
    expect(() => failing.run(narrow)).toThrow('窄接口迁移失败');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(tableNames(db)).toContain('first_step');
    expect(tableNames(db)).not.toContain('partial_step');
    expect(db.inTransaction).toBe(false);

    createMigrationRunner([first, (database) => database.exec('CREATE TABLE partial_step (id INTEGER PRIMARY KEY)')]).run(narrow);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(tableNames(db)).toContain('partial_step');
    expect(db.inTransaction).toBe(false);
  });

  it('失败观察不覆盖上次成功信号：错误列与成功列分离', () => {
    const db = open(tempDbPath());
    seedRepository(db);
    db.prepare(
      `INSERT INTO detail_scope_state (repository_id, scope, cache_status, freshness, observed_fingerprint, synced_fingerprint, last_synced_at, last_checked_at)
       VALUES (1, 'commits', 'valid', 'fresh', 'fp-observed', 'fp-synced', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ).run();
    // 一次失败观察只允许写请求状态与错误列，成功信号保持原值
    db.prepare("UPDATE detail_scope_state SET check_status = 'error', last_check_error = 'network' WHERE repository_id = 1 AND scope = 'commits'").run();
    expect(db.prepare("SELECT observed_fingerprint, synced_fingerprint, last_synced_at, last_check_error FROM detail_scope_state WHERE repository_id = 1 AND scope = 'commits'").get())
      .toEqual({ observed_fingerprint: 'fp-observed', synced_fingerprint: 'fp-synced', last_synced_at: '2026-10-01T00:00:00.000Z', last_check_error: 'network' });
  });

  it('同步存储具备幂等与唯一约束；删除仓库级联清理', () => {
    const db = open(tempDbPath());
    seedRepository(db);

    db.prepare("INSERT INTO detail_scope_state (repository_id, scope) VALUES (1, 'overview')").run();
    expect(() => db.prepare("INSERT INTO detail_scope_state (repository_id, scope) VALUES (1, 'overview')").run()).toThrow(/UNIQUE/);

    db.prepare("INSERT INTO observation_handoff (observation_id, repository_id, detected_at, access_context_revision, change_set) VALUES ('obs-1', 1, '2026-10-06T08:00:00.000Z', 0, '{}')").run();
    expect(() => db.prepare("INSERT INTO observation_handoff (observation_id, repository_id, detected_at, access_context_revision, change_set) VALUES ('obs-1', 1, '2026-10-06T08:01:00.000Z', 0, '{}')").run()).toThrow(/UNIQUE/);

    db.prepare("INSERT INTO sync_task_target (task_id, repository_id, scope, kind, status, target_revision, baseline_fingerprint, access_context_revision, task_version, started_at) VALUES ('task-1', 1, 'builds', 'scope', 'running', 2, NULL, 0, 1, '2026-10-06T08:00:00.000Z')").run();
    expect(() => db.prepare("INSERT INTO sync_task_target (task_id, repository_id, scope, kind, status, target_revision, baseline_fingerprint, access_context_revision, task_version, started_at) VALUES ('task-1', 1, 'builds', 'scope', 'queued', 3, NULL, 0, 2, '2026-10-06T08:02:00.000Z')").run()).toThrow(/UNIQUE/);

    db.prepare("INSERT INTO cache_query_page (repository_id, scope, query_key, access_context_revision, schema_version, payload, saved_at) VALUES (1, 'commits', 'default|30', 0, 1, '[]', '2026-10-06T08:00:00.000Z')").run();
    expect(() => db.prepare("INSERT INTO cache_query_page (repository_id, scope, query_key, access_context_revision, schema_version, payload, saved_at) VALUES (1, 'commits', 'default|30', 0, 1, '[]', '2026-10-06T08:01:00.000Z')").run()).toThrow(/UNIQUE/);

    db.prepare('DELETE FROM repository WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM detail_scope_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM observation_handoff').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_task_target').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM cache_query_page').get()).toEqual({ n: 0 });
  });
});
