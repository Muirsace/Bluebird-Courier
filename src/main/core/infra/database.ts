import Database from 'better-sqlite3';
import { createMigrationRunner, type MigrationDatabase } from './migrations';

/** 暂时保留驱动实例类型以兼容旧 feature；新 feature 应只依赖数据库窄端口。 */
export type LocalDatabase = Database.Database;

function tableExists(database: MigrationDatabase, table: string): boolean {
  const rows = database.pragma(`table_info(${table})`) as Array<{ name?: unknown }>;
  return Array.isArray(rows) && rows.length > 0;
}

/** 为旧库补列。列名与定义来自源码常量，不接受外部输入。 */
function ensureColumns(database: MigrationDatabase, table: string, columns: Record<string, string>): void {
  const existing = new Set(
    (database.pragma(`table_info(${table})`) as Array<{ name?: unknown }>).map((column) => column.name),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function migrationV1(database: MigrationDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS repository (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL UNIQUE,
      added_at TEXT NOT NULL,
      stars INTEGER,
      forks INTEGER,
      open_issues INTEGER,
      pushed_at TEXT,
      latest_release_tag TEXT,
      fetched_at TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
      captured_at TEXT NOT NULL,
      day TEXT NOT NULL,
      stars INTEGER,
      forks INTEGER,
      open_issues INTEGER,
      latest_release_tag TEXT,
      pushed_at TEXT,
      UNIQUE(repository_id, day)
    );
    CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_repository_day ON snapshot(repository_id, day);
  `);
  ensureColumns(database, 'repository', {
    owner: 'TEXT',
    name: 'TEXT',
    full_name: 'TEXT',
    added_at: 'TEXT',
    stars: 'INTEGER',
    forks: 'INTEGER',
    open_issues: 'INTEGER',
    pushed_at: 'TEXT',
    latest_release_tag: 'TEXT',
    fetched_at: 'TEXT',
  });
}

function migrationV2(database: MigrationDatabase): void {
  if (!tableExists(database, 'repository')) migrationV1(database);
  ensureColumns(database, 'repository', {
    code_activity_at: 'TEXT',
    collaboration_activity_at: 'TEXT',
    repository_status: "TEXT NOT NULL DEFAULT 'active'",
    status_detail: 'TEXT',
    last_error_kind: 'TEXT',
    last_error_message: 'TEXT',
    last_success_at: 'TEXT',
    last_attempt_at: 'TEXT',
    detail_fetched_at: 'TEXT',
  });
  database.exec(`
    CREATE TABLE IF NOT EXISTS detail_cache (
      repository_id INTEGER PRIMARY KEY REFERENCES repository(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      source_updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS detail_column (
      repository_id INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
      column_name TEXT NOT NULL,
      state TEXT NOT NULL,
      payload TEXT,
      error_kind TEXT,
      error_message TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(repository_id, column_name)
    );
    CREATE TABLE IF NOT EXISTS refresh_batch (
      id TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      stop_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS operation_lock (
      lock_key TEXT PRIMARY KEY,
      acquired_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshot_captured_at ON snapshot(captured_at);
    CREATE INDEX IF NOT EXISTS idx_repository_activity ON repository(code_activity_at, collaboration_activity_at);
  `);
}

function migrationV3(database: MigrationDatabase): void {
  // 同步记账存储：只追加，不改写 V1/V2；旧缓存内容保留，缺少源基线的范围由默认值从 unknown 起步。
  ensureColumns(database, 'repository', {
    view_version: 'INTEGER NOT NULL DEFAULT 0',
  });
  ensureColumns(database, 'detail_cache', {
    schema_version: 'INTEGER NOT NULL DEFAULT 1',
    access_context_revision: 'INTEGER NOT NULL DEFAULT 0',
  });
  database.exec(`
    CREATE TABLE IF NOT EXISTS access_context (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    INSERT OR IGNORE INTO access_context (id, revision, updated_at) VALUES (1, 0, NULL);

    CREATE TABLE IF NOT EXISTS detail_scope_state (
      repository_id INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      cache_status TEXT NOT NULL DEFAULT 'missing',
      freshness TEXT NOT NULL DEFAULT 'unknown',
      check_status TEXT NOT NULL DEFAULT 'idle',
      sync_status TEXT NOT NULL DEFAULT 'idle',
      detected_revision INTEGER NOT NULL DEFAULT 0,
      synced_revision INTEGER NOT NULL DEFAULT 0,
      important_revision INTEGER NOT NULL DEFAULT 0,
      viewed_revision INTEGER NOT NULL DEFAULT 0,
      dirty_reasons TEXT NOT NULL DEFAULT '[]',
      observed_fingerprint TEXT,
      synced_fingerprint TEXT,
      last_checked_at TEXT,
      last_synced_at TEXT,
      last_check_error TEXT,
      last_sync_error TEXT,
      PRIMARY KEY (repository_id, scope)
    );

    CREATE TABLE IF NOT EXISTS observation_handoff (
      observation_id TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
      detected_at TEXT NOT NULL,
      access_context_revision INTEGER NOT NULL,
      change_set TEXT NOT NULL,
      applied_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_task_target (
      task_id TEXT NOT NULL,
      repository_id INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      target_revision INTEGER NOT NULL,
      baseline_fingerprint TEXT,
      access_context_revision INTEGER NOT NULL,
      task_version INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      PRIMARY KEY (task_id, scope)
    );

    CREATE TABLE IF NOT EXISTS cache_query_page (
      repository_id INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      query_key TEXT NOT NULL,
      access_context_revision INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      cursor TEXT,
      next_cursor TEXT,
      has_more INTEGER NOT NULL DEFAULT 0,
      saved_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, scope, query_key)
    );

    CREATE INDEX IF NOT EXISTS idx_observation_handoff_pending ON observation_handoff(applied_at);
    CREATE INDEX IF NOT EXISTS idx_sync_task_recovery ON sync_task_target(status);
    CREATE INDEX IF NOT EXISTS idx_cache_query_page_saved ON cache_query_page(saved_at);
  `);
}

function migrationV4(database: MigrationDatabase): void {
  // 清单观察存储：只追加，不改写 V1～V3；旧行 observation_json 为空、范围从下一次成功观察起步。
  ensureColumns(database, 'repository', {
    /** 无 Release 时的 Tag 兜底展示值（此前仅存在领域读取里，从未落列）。 */
    latest_tag: 'TEXT',
    /** 最近一次成功观察的完整快照（含 CheckedSignal 状态与活动候选）；失败不覆盖。 */
    observation_json: 'TEXT',
    /** 统一活动结果（显示与排序同源）。 */
    activity_at: 'TEXT',
    activity_kind: 'TEXT',
    /** 该行观察所属的访问上下文版本；跨上下文的旧观察不参与比较或回填。 */
    access_context_revision: 'INTEGER NOT NULL DEFAULT 0',
  });
}

function migrationV5(database: MigrationDatabase): void {
  // 详情侧观察应用与本地视图版本：只追加，不改写 V1～V4。
  database.exec(`
    ALTER TABLE detail_scope_state ADD COLUMN access_context_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE snapshot ADD COLUMN access_context_revision INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS detail_observation_apply (
      observation_id TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
      applied_at TEXT NOT NULL,
      access_context_revision INTEGER NOT NULL,
      affected_scopes TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS detail_view_state (
      repository_id INTEGER PRIMARY KEY REFERENCES repository(id) ON DELETE CASCADE,
      view_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_detail_observation_apply_repo ON detail_observation_apply(repository_id);
    CREATE INDEX IF NOT EXISTS idx_observation_handoff_repo_context ON observation_handoff(repository_id, access_context_revision, detected_at) WHERE applied_at IS NULL;
    CREATE TABLE IF NOT EXISTS snapshot_view_state (
      repository_id INTEGER PRIMARY KEY REFERENCES repository(id) ON DELETE CASCADE,
      view_version INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/**
 * 完整详情成功时间与旧库兼容：只追加，不改写 V1～V5。
 * `fetched_at` 保留为缓存身份/创建时间；`complete_fetched_at` 单独记录"最近一次全部远端范围完整覆盖"的时间，
 * 旧行留空表示未知，不把创建时刻冒充完整同步时间。
 */
function migrationV6(database: MigrationDatabase): void {
  ensureColumns(database, 'detail_cache', {
    complete_fetched_at: 'TEXT',
  });
}

/**
 * 真实采样意图存储：只追加，不改写 V1～V6。
 *
 * 一次真实观察先在此登记"待写入的快照事实"（稳定身份 = 仓库 + 观察时间），再把快照真正写进
 * `snapshot` 并在同一事务内删除该意图；写入失败时意图保留，供重启后补偿。意图只保存观察值、
 * 观察时间与访问上下文，不含访问令牌，也不承载任何业务淘汰规则。
 */
function migrationV7(database: MigrationDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_pending (
      identity TEXT PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
      access_context_revision INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshot_pending_created ON snapshot_pending(created_at);
  `);
}

/**
 * 有界恢复的公平性与隔离：只追加，不改写 V1～V7。
 *
 * - `observation_handoff.quarantined_at`：隔离结构中不可修复的交接记录，避免坏前缀每次重放都
 *   从头占用预算、永久饿死其后的有效观察；可重试失败不写此列，仍保持待交接。
 * - `snapshot_pending_cursor`：记录采样补偿已处理到的行位置，使有界补偿可以越过瞬时失败前缀、
 *   并在走到队尾后回到起点重试此前失败的意图；不含任何业务规则。
 */
function migrationV8(database: MigrationDatabase): void {
  ensureColumns(database, 'observation_handoff', {
    quarantined_at: 'TEXT',
  });
  database.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_pending_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_rowid INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO snapshot_pending_cursor (id, last_rowid) VALUES (1, 0);
  `);
}

/** 来源身份与持久排序、交接恢复进度；只追加，不改写 V1～V8。 */
function migrationV9(database: MigrationDatabase): void {
  database.exec(`
    CREATE TABLE snapshot_observation (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      identity TEXT NOT NULL UNIQUE,
      repository_id INTEGER NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL
    );
    ALTER TABLE snapshot ADD COLUMN observation_sequence INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE snapshot ADD COLUMN observation_at TEXT;
    UPDATE snapshot SET observation_at = captured_at;
    ALTER TABLE snapshot_pending ADD COLUMN observation_sequence INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE observation_replay_cursor (
      queue_key INTEGER PRIMARY KEY,
      last_rowid INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/** 有界范围验证的续扫进度独立于成功基线；只追加V10，不改已有迁移。 */
function migrationV10(database: MigrationDatabase): void {
  database.exec('ALTER TABLE detail_scope_state ADD COLUMN verification_progress TEXT');
}

/** 按版本递增，保持旧数据库可重复打开。 */
export const MIGRATIONS = [migrationV1, migrationV2, migrationV3, migrationV4, migrationV5, migrationV6, migrationV7, migrationV8, migrationV9, migrationV10] as const;
export const migrationRunner = createMigrationRunner(MIGRATIONS);

/** 生产唯一入口：委托给迁移执行器，内容与 user_version 的原子提交由 runner 保证。 */
export function runMigrations(database: MigrationDatabase): void {
  migrationRunner.run(database);
}

export function openDatabase(pathname: string): LocalDatabase {
  const database = new Database(pathname);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  runMigrations(database);
  return database;
}
