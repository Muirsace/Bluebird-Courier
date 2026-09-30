import fs from 'node:fs';
import path from 'node:path';

/** 极简日志：主进程写本地文件，测试用静默实现。 */
export interface Logger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export const silentLogger: Logger = {
  info() {},
  error() {},
};

export function createFileLogger(logDirectory: string): Logger {
  const file = path.join(logDirectory, 'octo.log');
  const write = (level: string, message: string, detail?: string): void => {
    const line = `[${new Date().toISOString()}] ${level} ${message}${detail ? ` ${detail}` : ''}\n`;
    try {
      fs.mkdirSync(logDirectory, { recursive: true });
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      // 日志失败不应影响业务
    }
  };
  return {
    info: (message) => write('INFO', message),
    error: (message, error) => write('ERROR', message, error === undefined ? undefined : String(error)),
  };
}
