/** 数据库迁移执行器的公共窄接口。 */
export type Migration = (database: MigrationDatabase) => void;

export interface MigrationDatabase {
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

export interface MigrationRunner {
  run(database: MigrationDatabase): void;
}

/** 按版本顺序执行迁移，失败时由调用方接收异常并终止启动。 */
export function createMigrationRunner(migrations: readonly Migration[]): MigrationRunner {
  return {
    run(database: MigrationDatabase): void {
      const current = Number(database.pragma('user_version', { simple: true }) ?? 0);
      if (!Number.isInteger(current) || current < 0) throw new Error('SQLite user_version 无效');
      for (let version = current; version < migrations.length; version += 1) {
        const migration = migrations[version];
        if (!migration) continue;
        migration(database);
        database.pragma(`user_version = ${version + 1}`);
      }
    },
  };
}
