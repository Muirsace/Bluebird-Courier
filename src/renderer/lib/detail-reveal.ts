import { useEffect, useLayoutEffect, useState } from 'react';
import { prefersReducedMotion } from './motion';

/**
 * 详情揭示的三个阶段。语义是"数据有没有到位"，不是"动画播到第几帧"：
 *
 * - loading：还没有全量信息（抓取中，或首次抓取失败后停在原地）。
 * - revealing：数据已经到了、正在播进入动效。此时界面已经是完整的真数据，可交互。
 * - ready：揭示窗口结束。之后任何数据更新都不再重播。
 */
export type DetailRevealPhase = 'loading' | 'revealing' | 'ready';

/**
 * 首次「无数据 → 有数据」这一跳要不要播揭示动效。
 *
 * 只有真正经历过 Loading 的那一次才播：首帧就有数据（缓存命中）直接算 ready，
 * 所以重进同一个仓库、手动重新抓取、切 Tab、换主题都不会补播一次。
 * 数据到达时在 paint 前就切到 revealing，否则会先闪一帧最终态再回到起点。
 */
export function useDetailReveal(hasDetail: boolean, revealMs: number): DetailRevealPhase {
  const [phase, setPhase] = useState<DetailRevealPhase>(() => (hasDetail ? 'ready' : 'loading'));

  useLayoutEffect(() => {
    if (!hasDetail || phase !== 'loading') return;
    setPhase(prefersReducedMotion() ? 'ready' : 'revealing');
  }, [hasDetail, phase]);

  useEffect(() => {
    if (phase !== 'revealing') return;
    const timer = window.setTimeout(() => setPhase('ready'), revealMs);
    return () => window.clearTimeout(timer);
  }, [phase, revealMs]);

  return phase;
}
