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

/** 按版本递增，保持旧数据库可重复打开。 */
export const MIGRATIONS = [migrationV1, migrationV2] as const;
export const migrationRunner = createMigrationRunner(MIGRATIONS);

export function runMigrations(database: MigrationDatabase): void {
  const current = Number(database.pragma('user_version', { simple: true }) ?? 0);
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const migration = MIGRATIONS[version];
    if (!migration) continue;
    if ('transaction' in database && typeof (database as { transaction?: unknown }).transaction === 'function') {
      const connection = database as MigrationDatabase & { transaction<T>(work: () => T): () => T };
      connection.transaction(() => {
        migration(connection);
        connection.pragma(`user_version = ${version + 1}`);
      })();
    } else {
      migration(database);
      database.pragma(`user_version = ${version + 1}`);
    }
  }
}

export function openDatabase(pathname: string): LocalDatabase {
  const database = new Database(pathname);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  runMigrations(database);
  return database;
}
