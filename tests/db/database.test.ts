import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/main/core/db/database';

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
