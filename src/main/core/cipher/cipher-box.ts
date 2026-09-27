/** 加密盒：访问令牌加密后才落库（setting 表）。 */
export interface CipherBox {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

/** Electron safeStorage 的最小结构（生产实现用），测试用假加密盒替代。 */
export interface SafeStorageLike {
  /** 系统钥匙串是否可用；不可用时禁止落库（不降级为明文）。 */
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(payload: Buffer): string;
}

/** 系统安全存储不可用：拒绝以明文保存访问令牌，需由调用方向用户明示。 */
export class SecureStorageUnavailableError extends Error {
  constructor() {
    super('系统安全存储不可用');
    this.name = 'SecureStorageUnavailableError';
  }
}

const PREFIX = 'ss:';

/** 生产实现：交给操作系统钥匙串（Electron safeStorage）。 */
export function createSafeStorageCipherBox(safeStorage: SafeStorageLike): CipherBox {
  return {
    encrypt(plain: string): string {
      if (!safeStorage.isEncryptionAvailable()) throw new SecureStorageUnavailableError();
      return PREFIX + safeStorage.encryptString(plain).toString('base64');
    },
    decrypt(payload: string): string {
      return safeStorage.decryptString(Buffer.from(payload.slice(PREFIX.length), 'base64'));
    },
  };
}
