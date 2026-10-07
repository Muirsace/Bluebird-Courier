import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createIdentifierGenerator } from '../../src/main/core/infra/identifier';
import { openDatabase } from '../../src/main/core/infra/database';
import type { CipherBox } from '../../src/main/core/infra/encryption';
import { createFacade } from '../../src/main/facade/facade';
import { createRepositoryList } from '../../src/main/features/repository-list/implementation/create';
import { createRepositoryDetail } from '../../src/main/features/repository-detail/implementation/create';
import { createTokenSettings } from '../../src/main/features/token-settings/implementation/create';
import { createSnapshotTrend } from '../../src/main/features/snapshot-trend/implementation/create';
import type { RepositoryListService } from '../../src/main/features/repository-list/contract';
import type { TokenSettingsService } from '../../src/main/features/token-settings/contract';
import type { BluebirdCourierFacade } from '../../src/shared/types';
import { FakeGitHub } from './fake-github';
import { FakeClock, FakeCipherBox } from './fakes';

export interface Harness {
  db: Database.Database;
  github: FakeGitHub;
  cipher: CipherBox;
  clock: FakeClock;
  facade: BluebirdCourierFacade;
  /** feature 服务实例（facade 尚未暴露的用例用它们直接验证，如待交接读取与访问上下文推进）。 */
  repositoryList: RepositoryListService;
  tokenSettings: TokenSettingsService;
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
  let repositoryList!: RepositoryListService;
  let tokenSettings!: TokenSettingsService;
  let facade!: BluebirdCourierFacade;
  const build = (): void => {
    tokenSettings = createTokenSettings({ db, cipher, github });
    repositoryList = createRepositoryList({ db, clock, github,
      accessContext: { currentRevision: () => tokenSettings.accessContextRevision() }, nextObservationId: createIdentifierGenerator(),
    });
    facade = createFacade({
      repositoryList,
      github,
      repositoryDetail: createRepositoryDetail({
        db,
        github,
        clock,
        repositoryById: (repositoryId) => repositoryList.findById(repositoryId),
      }),
      tokenSettings,
      snapshotTrend: createSnapshotTrend({ db, clock }),
    });
  };
  build();

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
    get repositoryList() {
      return repositoryList;
    },
    get tokenSettings() {
      return tokenSettings;
    },
    reopen(): Harness {
      db.close();
      db = openDatabase(dbPath);
      build();
      return harness;
    },
    destroy(): void {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}
