import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from './clock';

/** 主进程日志端口；时间由组合根注入，便于测试和统一事件时间。 */
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: unknown, context?: Record<string, unknown>): void;
}

export interface StructuredLogger extends Logger {
  request(message: string, context?: Record<string, unknown>): void;
  failure(message: string, error?: unknown, context?: Record<string, unknown>): void;
  rateLimit(message: string, context?: Record<string, unknown>): void;
  batch(message: string, context?: Record<string, unknown>): void;
}

export const silentLogger: StructuredLogger = {
  info() {},
  error() {},
  request() {},
  failure() {},
  rateLimit() {},
  batch() {},
};

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 创建结构化文件日志；日志目录无法创建时立即抛错，由组合根展示启动失败。 */
export function createFileLogger(logDirectory: string, clock: Clock): StructuredLogger;
export function createFileLogger(logDirectory: string): StructuredLogger;
export function createFileLogger(logDirectory: string, clock?: Clock): StructuredLogger {
  const file = path.join(logDirectory, 'octo.log');
  const time = clock ?? { now: () => new Date() };
  fs.mkdirSync(logDirectory, { recursive: true });
  const write = (level: string, message: string, context?: Record<string, unknown>, error?: unknown): void => {
    const fields = context === undefined ? '' : ` ${stringify(context)}`;
    const details = error === undefined ? '' : ` ${stringify(error)}`;
    const line = `[${time.now().toISOString()}] ${level} ${message}${fields}${details}\n`;
    fs.appendFileSync(file, line, 'utf8');
  };
  return {
    info: (message, context) => write('INFO', message, context),
    error: (message, error, context) => write('ERROR', message, context, error),
    request: (message, context) => write('REQUEST', message, context),
    failure: (message, error, context) => write('FAILURE', message, context, error),
    rateLimit: (message, context) => write('RATE_LIMIT', message, context),
    batch: (message, context) => write('BATCH', message, context),
  };
}
