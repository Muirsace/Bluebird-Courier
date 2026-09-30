import type { Clock } from '../../src/main/core/infra/clock';
import type { CipherBox } from '../../src/main/core/infra/cipher';

/** 可拨动的测试时钟。 */
export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(date: Date): void {
    this.current = date;
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** 假加密盒：密文不包含明文（base64 + 前缀），可逆。 */
export class FakeCipherBox implements CipherBox {
  encrypt(plain: string): string {
    return `enc:${Buffer.from(plain, 'utf8').toString('base64')}`;
  }
  decrypt(payload: string): string {
    return Buffer.from(payload.slice('enc:'.length), 'base64').toString('utf8');
  }
}
