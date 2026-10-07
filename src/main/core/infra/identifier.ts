import { randomUUID } from 'node:crypto';

/** 可替换的技术标识生成能力；具体实现由组合根选择。 */
export function createIdentifierGenerator(): () => string {
  return () => randomUUID();
}
