import { describe, expect, it } from 'vitest';
import {
  chooseOverlayPlacement,
  overlayMaxWidth,
  TRIGGER_GAP,
  VIEWPORT_SAFE_GAP,
} from '../../src/renderer/lib/overlay-placement';
import type { OverlayTriggerRect } from '../../src/renderer/lib/overlay-placement';

/**
 * 浮层定位策略是纯几何，单独测：DOM 测量留在组件里，这里只回答
 * "往上还是往下、最多能多高、最多能多宽"。数值全部按 1152×1000 视口手算。
 */
const WIDE = { viewportWidth: 1152, viewportHeight: 1000 };

function trigger(top: number, bottom: number, right = 1100): OverlayTriggerRect {
  return { top, bottom, right };
}

describe('浮层定位策略 · 间距常量', () => {
  it('触发器间距 8px、视口安全边距 12px', () => {
    expect(TRIGGER_GAP).toBe(8);
    expect(VIEWPORT_SAFE_GAP).toBe(12);
  });
});

describe('浮层定位策略 · 上下翻转', () => {
  it('下方放得下：贴在触发器下方', () => {
    const result = chooseOverlayPlacement({
      triggerRect: trigger(100, 132),
      overlayHeight: 200,
      ...WIDE,
    });

    expect(result.placement).toBe('bottom');
    // 1000 - 132 - 12（safe gap）- 8（trigger gap）
    expect(result.maxHeight).toBe(848);
  });

  it('下方放不下、上方放得下：自动翻到上方（窗口底部那张卡片）', () => {
    const result = chooseOverlayPlacement({
      triggerRect: trigger(940, 972),
      overlayHeight: 220,
      ...WIDE,
    });

    expect(result.placement).toBe('top');
    // 940 - 12 - 8
    expect(result.maxHeight).toBe(920);
  });

  it('上方放不下、下方放得下：仍然留在下方（不是只要上方小就翻）', () => {
    const result = chooseOverlayPlacement({
      triggerRect: trigger(100, 132),
      overlayHeight: 800,
      ...WIDE,
    });

    expect(result.placement).toBe('bottom');
    expect(result.maxHeight).toBe(848);
  });

  it('上下都放不下：选空间更大的一侧并限高（下方更大）', () => {
    const result = chooseOverlayPlacement({
      triggerRect: trigger(400, 432),
      overlayHeight: 800,
      ...WIDE,
    });

    // spaceBelow = 556，spaceAbove = 388 → 下方更大
    expect(result.placement).toBe('bottom');
    expect(result.maxHeight).toBe(548);
  });

  it('上下都放不下：选空间更大的一侧并限高（上方更大）', () => {
    const result = chooseOverlayPlacement({
      triggerRect: trigger(700, 732),
      overlayHeight: 800,
      ...WIDE,
    });

    // spaceBelow = 256，spaceAbove = 688 → 上方更大
    expect(result.placement).toBe('top');
    expect(result.maxHeight).toBe(680);
  });

  it('高到超过整个视口也不会给出负数高度', () => {
    const result = chooseOverlayPlacement({
      triggerRect: trigger(2, 998),
      overlayHeight: 4000,
      ...WIDE,
    });

    expect(result.maxHeight).toBe(0);
  });
});

describe('浮层定位策略 · 宽度', () => {
  it('右对齐触发器：左侧仍留出 safe gap', () => {
    expect(overlayMaxWidth(trigger(100, 132, 1100), 1152)).toBe(1088);
  });

  it('视口比触发器余量更窄时以视口为准（480px 也不横向溢出）', () => {
    expect(overlayMaxWidth(trigger(100, 132, 1000), 480)).toBe(456);
  });

  it('触发器贴着左边缘时宽度下限是 0，不会是负数', () => {
    expect(overlayMaxWidth(trigger(100, 132, 20), 480)).toBe(8);
    expect(overlayMaxWidth(trigger(100, 132, -50), 480)).toBe(0);
  });

  it('placement 结果里带着同一条宽度上限', () => {
    const result = chooseOverlayPlacement({
      triggerRect: trigger(100, 132),
      overlayHeight: 200,
      ...WIDE,
    });

    expect(result.maxWidth).toBe(1088);
  });
});
