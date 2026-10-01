/**
 * happy-dom exposes WAAPI without a browser animation timeline. Use Motion's JS fallback,
 * and a browser-like RAF whose clock can also be advanced by Vitest fake timers.
 * Motion itself, AnimatePresence, keys, DOM identity and event handlers remain real.
 */
if (typeof window !== 'undefined') {
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: undefined });

  let nextFrame = 0;
  const frames = new Map<number, ReturnType<typeof setTimeout>>();
  const requestFrame = (callback: FrameRequestCallback): number => {
    const id = ++nextFrame;
    frames.set(id, setTimeout(() => {
      frames.delete(id);
      callback(performance.now());
    }, 16));
    return id;
  };
  const cancelFrame = (id: number): void => {
    const timer = frames.get(id);
    if (timer !== undefined) clearTimeout(timer);
    frames.delete(id);
  };
  globalThis.requestAnimationFrame = window.requestAnimationFrame = requestFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame = cancelFrame;
}
