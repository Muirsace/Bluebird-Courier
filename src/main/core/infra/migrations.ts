/** 数据库迁移执行器的公共窄接口。 */
export type Migration = (database: MigrationDatabase) => void;

export interface MigrationDatabase {
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

export interface MigrationRunner {
  run(database: MigrationDatabase): void;
}

interface TransactionalMigrationDatabase extends MigrationDatabase {
  transaction<T>(work: () => T): () => T;
}

function supportsTransactions(database: MigrationDatabase): database is TransactionalMigrationDatabase {
  return 'transaction' in database && typeof (database as { transaction?: unknown }).transaction === 'function';
}

/**
 * 按版本顺序执行迁移，失败时由调用方接收异常并终止启动。
 * 每个版本的内容与 user_version 递增在同一事务内提交：
 * 迁移中途失败时，该版本已写入的表 / 列与版本号一起回滚，
 * 数据库停留在上一个成功版本，可修复后重试。
 */
export function createMigrationRunner(migrations: readonly Migration[]): MigrationRunner {
  return {
    run(database: MigrationDatabase): void {
      const current = Number(database.pragma('user_version', { simple: true }) ?? 0);
      if (!Number.isInteger(current) || current < 0) throw new Error('SQLite user_version 无效');
      for (let version = current; version < migrations.length; version += 1) {
        const migration = migrations[version];
        if (!migration) continue;
        const apply = (): void => {
          migration(database);
          database.pragma(`user_version = ${version + 1}`);
        };
        if (supportsTransactions(database)) {
          database.transaction(apply)();
        } else {
          // 窄接口不暴露驱动事务方法时，仍用 SQL 保证迁移与版本号原子提交。
          database.exec('BEGIN IMMEDIATE');
          try {
            apply();
            database.exec('COMMIT');
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
        }
      }
    },
  };
}
