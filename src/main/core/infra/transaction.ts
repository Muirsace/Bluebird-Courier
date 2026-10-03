/** 事务边界的窄接口，feature 无需知道数据库驱动。 */
export interface TransactionRunner {
  run<T>(work: () => T): T;
}

/** 将数据库事务函数包装为可注入能力。 */
export function createTransactionRunner(database: { transaction<T>(work: () => T): () => T }): TransactionRunner {
  return {
    run<T>(work: () => T): T {
      return database.transaction(work)();
    },
  };
}

/** 兼容直接传入 better-sqlite3 事务函数的工厂。 */
export function transaction<T>(database: { transaction(work: () => T): () => T }, work: () => T): T {
  return database.transaction(work)();
}
