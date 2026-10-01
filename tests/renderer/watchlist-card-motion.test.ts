import { describe, expect, it } from 'vitest';
import { cardLayoutTransition, cardVariants } from '../../src/renderer/components/watchlist/card-motion';
import { readRendererStyles } from './support/styles';

describe('Watchlist card motion ownership', () => {
  it('preserves the approved enter and exit trajectories as tweens', () => {
    const variants = cardVariants(false);
    expect(variants.enter).toEqual({
      opacity: [0, 1, 1], y: [-8, 1, 0], scale: [0.985, 1.004, 1],
      transition: { type: 'tween', duration: 0.26, times: [0, 0.68, 1], ease: [0.22, 1, 0.36, 1] },
    });
    expect(variants.exit).toEqual({
      opacity: [1, 1, 0], y: [0, 1, -6], scale: [1, 0.998, 0.985],
      transition: { type: 'tween', duration: 0.15, times: [0, 0.22, 1], ease: [0.4, 0, 1, 1] },
    });
    expect(cardLayoutTransition(false)).toEqual({ type: 'tween', duration: 0.22, ease: [0.22, 1, 0.36, 1] });
    expect(cardLayoutTransition(true)).toEqual({ type: 'tween', duration: 0.2, ease: [0.4, 0, 1, 1] });
  });

  it('uses final transforms immediately and only a 40ms opacity exit with reduced motion', () => {
    const variants = cardVariants(true);
    expect(variants.enter).toEqual({ opacity: 1, y: 0, scale: 1, transition: { type: 'tween', duration: 0 } });
    expect(variants.exit).toEqual({
      opacity: 0, y: 0, scale: 1, transition: { type: 'tween', duration: 0.04, ease: 'linear' },
    });
  });

  it('CSS retains color highlight and pressed feedback without legacy card/layout animations', () => {
    const css = readRendererStyles();
    for (const name of ['repo-card-enter', 'repo-card-exit', 'repo-card-fade-out', 'repo-slot-expand', 'repo-slot-collapse', 'data-motion']) {
      expect(css).not.toContain(name);
    }
    const highlight = css.match(/@keyframes repo-card-highlight\s*\{[\s\S]*?\n\}/)?.[0];
    expect(highlight).toContain('border-color:');
    expect(highlight).toContain('background-color:');
    expect(highlight).not.toMatch(/transform:|opacity:|scale:|translate:/);
    expect(css).toContain('.repo-row:has([data-row-activator]:active)');
    expect(css).toContain(".repo-row-slot[data-highlight-only='true']");
  });
});
