/** 可注入的令牌加密能力。对外只暴露领域无关的窄接口。 */
export interface CipherBox {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

/** Electron safeStorage 所需的最小结构，便于测试替换。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(payload: Buffer): string;
}

export class SecureStorageUnavailableError extends Error {
  constructor() {
    super('系统安全存储不可用');
    this.name = 'SecureStorageUnavailableError';
  }
}

export class InvalidCiphertextError extends Error {
  constructor() {
    super('访问令牌密文格式无效');
    this.name = 'InvalidCiphertextError';
  }
}

const PREFIX = 'ss:v1:';
const ORIGINAL_PREFIX = 'ss:';

/** 使用系统钥匙串加密；安全存储不可用时拒绝回退到明文。 */
export function createSafeStorageCipherBox(safeStorage: SafeStorageLike): CipherBox {
  return {
    encrypt(plain: string): string {
      if (typeof plain !== 'string' || plain.length === 0) throw new TypeError('访问令牌不能为空');
      if (!safeStorage.isEncryptionAvailable()) throw new SecureStorageUnavailableError();
      const encrypted = safeStorage.encryptString(plain);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new InvalidCiphertextError();
      return PREFIX + encrypted.toString('base64');
    },
    decrypt(payload: string): string {
      if (typeof payload !== 'string') throw new InvalidCiphertextError();
      // 既有数据库使用 ss: 标识；读取时保留其格式，写入仍统一采用当前版本。
      const prefix = payload.startsWith(PREFIX) ? PREFIX : payload.startsWith(ORIGINAL_PREFIX) ? ORIGINAL_PREFIX : null;
      if (prefix === null) throw new InvalidCiphertextError();
      const encoded = payload.slice(prefix.length);
      if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new InvalidCiphertextError();
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length === 0 || bytes.toString('base64') !== encoded) throw new InvalidCiphertextError();
      try {
        const plain = safeStorage.decryptString(bytes);
        if (!plain) throw new InvalidCiphertextError();
        return plain;
      } catch (error) {
        if (error instanceof InvalidCiphertextError) throw error;
        throw new InvalidCiphertextError();
      }
    },
  };
}

export { PREFIX as CIPHERTEXT_PREFIX };
