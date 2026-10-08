/**
 * 清单共享的低频时钟：所有行订阅同一个分钟级定时器，tick 只更新展示用的"现在"，
 * 不触发任何 bridge / 网络调用。首个订阅创建定时器，最后一个订阅卸载时释放。
 */
import { useSyncExternalStore } from 'react';

/** 可见清单的刷新节奏：相对时间按分钟展示，低频即可。 */
const TICK_MS = 60_000;

const listeners = new Set<() => void>();
let timer: number | null = null;
let nowMs = Date.now();

function tick(): void {
  nowMs = Date.now();
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    // 首个订阅先把缓存的"现在"追到当前时间；订阅后 React 会比对快照并重绘。
    nowMs = Date.now();
    timer = window.setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

function readNow(): number {
  return nowMs;
}

/** 展示用"现在"：随共享时钟按分钟更新；多个组件共用同一个定时器。 */
export function useDisplayNow(): number {
  return useSyncExternalStore(subscribe, readNow);
}
