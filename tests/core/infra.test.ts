import { describe, expect, it } from 'vitest';
import { createSafeStorageCipherBox, InvalidCiphertextError } from '../../src/main/core/infra/encryption';
import { createOperationLock } from '../../src/main/core/infra/operation-lock';
import { openDatabase } from '../../src/main/core/infra/database';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('主进程基础设施公开行为', () => {
  it('仅解密支持的密文版本并拒绝错误前缀', () => {
    const cipher = createSafeStorageCipherBox({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (value) => value.toString('utf8'),
    });
    const encrypted = cipher.encrypt('token');
    expect(encrypted).toMatch(/^ss:v1:/);
    expect(cipher.decrypt(encrypted)).toBe('token');
    expect(() => cipher.decrypt('ss:token')).toThrow(InvalidCiphertextError);
  });

  it('同一资源锁按获取顺序执行，且异常后允许后续操作', async () => {
    const lock = createOperationLock();
    const events: string[] = [];
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const first = lock.runExclusive('repo:1', async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
    });
    const second = lock.runExclusive('repo:1', () => { events.push('second'); });
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    unblock();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    await expect(lock.runExclusive('repo:1', () => { throw new Error('失败'); })).rejects.toThrow('失败');
    await expect(lock.runExclusive('repo:1', () => '恢复')).resolves.toBe('恢复');
  });

  it('数据库迁移补齐详情缓存、栏目状态、批次游标、锁表与同步记账存储', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-core-'));
    const database = openDatabase(path.join(directory, 'app.db'));
    try {
      const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        'detail_cache', 'detail_column', 'refresh_batch', 'operation_lock',
        'access_context', 'detail_scope_state', 'observation_handoff', 'sync_task_target', 'cache_query_page',
      ]));
      expect(database.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(3);
    } finally {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
