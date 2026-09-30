import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/main/core/infra/database';
import type { CipherBox } from '../../src/main/core/infra/cipher';
import { createFacade } from '../../src/main/facade/facade';
import { createFetching } from '../../src/main/features/fetching/implementation';
import { createSettings } from '../../src/main/features/settings/implementation';
import { createWatchlist } from '../../src/main/features/watchlist/implementation';
import type { BluebirdCourierFacade } from '../../src/shared/types';
import { FakeGitHub } from './fake-github';
import { FakeClock, FakeCipherBox } from './fakes';

export interface Harness {
  db: Database.Database;
  github: FakeGitHub;
  cipher: CipherBox;
  clock: FakeClock;
  facade: BluebirdCourierFacade;
  /** 关闭并重新打开同一个数据库文件（模拟应用重启）。 */
  reopen(): Harness;
  destroy(): void;
}

/**
 * 用例门面测试台：临时文件真库 + 假 GitHub 适配器 + 假加密盒 + 固定时钟。
 * 默认时钟取本地正午，保证"本地日期"跨时区稳定（2026-09-26）。
 * 可用 `cipher` 注入真实加密盒以覆盖系统安全存储不可用的路径。
 */
export function createHarness(options: { now?: Date; cipher?: CipherBox } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-facade-'));
  const dbPath = path.join(dir, 'octo.db');
  const github = new FakeGitHub();
  const cipher = options.cipher ?? new FakeCipherBox();
  const clock = new FakeClock(options.now ?? new Date(2026, 8, 26, 12, 0, 0));

  let db = openDatabase(dbPath);
  let facade = createFacade({
    settings: createSettings({ db, cipher }),
    watchlist: createWatchlist({ db, clock }),
    fetching: createFetching({ github }),
  });

  const harness: Harness = {
    get db() {
      return db;
    },
    github,
    cipher,
    clock,
    get facade() {
      return facade;
    },
    reopen(): Harness {
      db.close();
      db = openDatabase(dbPath);
      facade = createFacade({
        settings: createSettings({ db, cipher }),
        watchlist: createWatchlist({ db, clock }),
        fetching: createFetching({ github }),
      });
      return harness;
    },
    destroy(): void {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}
