/** 可替换的并发锁能力；锁只表达互斥，不包含刷新业务规则。 */
export interface OperationLock {
  runExclusive<T>(key: string, work: () => Promise<T> | T): Promise<T>;
}

/** 进程内按 key 串行执行，应用退出后不会留下无法清理的锁文件。 */
export function createOperationLock(): OperationLock {
  const tails = new Map<string, Promise<void>>();
  return {
    async runExclusive<T>(key: string, work: () => Promise<T> | T): Promise<T> {
      if (typeof key !== 'string' || key.length === 0) throw new TypeError('锁键不能为空');
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      tails.set(key, previous.then(() => current));
      await previous;
      try {
        return await work();
      } finally {
        release();
        if (tails.get(key) === current) tails.delete(key);
      }
    },
  };
}
