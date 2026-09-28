// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveChartPalette } from '../../src/renderer/lib/chart-theme';
import { useEffectiveTheme } from '../../src/renderer/lib/theme';
import { ThemeSelector } from '../../src/renderer/components/ThemeSelector';
import type { RenderResult, StubHandle, StubOptions } from './helpers';
import {
  appliedTheme,
  bodyText,
  click,
  createStub,
  makeGlance,
  menu,
  navButton,
  pressEscape,
  renderApp,
  renderNode,
  repoActionsButton,
  repoOpenButton,
  repoRows,
  resetSystemTheme,
  segmentedButton,
  setSystemTheme,
  settle,
  settleOverlayClose,
} from './helpers';

const REPO = 'octocat/Hello-World';

let handle: StubHandle;
let view: RenderResult | null = null;

async function mount(options: StubOptions = {}): Promise<void> {
  handle = createStub({
    ...options,
    repositories: options.repositories ?? [makeGlance(1, REPO)],
  });
  view = await renderApp(handle);
  await settle();
}

/** 进入设置页（主题选择器在那里）。 */
async function openSettings(): Promise<void> {
  await click(navButton('设置'));
  await settle();
}

/** 探针：把「当前主题 + 图表调色」渲染成文本，验证图表配色确实随主题重算。 */
function PaletteProbe() {
  const theme = useEffectiveTheme();
  const palette = resolveChartPalette(theme);
  return <span data-testid="palette">{`${theme}|${palette.star}|${palette.fork}`}</span>;
}

beforeEach(() => {
  resetSystemTheme();
  delete document.documentElement.dataset.theme;
});

afterEach(async () => {
  if (view) {
    await view.unmount();
    view = null;
  }
  resetSystemTheme();
  delete document.documentElement.dataset.theme;
});

describe('主题 · preference 与 effective', () => {
  it('默认偏好是 system：跟随系统主题', async () => {
    await mount();
    expect(appliedTheme()).toBe('light');

    setSystemTheme('dark');
    await settle();
    expect(appliedTheme()).toBe('dark');

    setSystemTheme('light');
    await settle();
    expect(appliedTheme()).toBe('light');
  });

  it('切「深色」立即生效并保存偏好', async () => {
    await mount();
    await openSettings();

    expect(segmentedButton('跟随系统')?.getAttribute('aria-pressed')).toBe('true');

    await click(segmentedButton('深色'));
    await settle();

    expect(appliedTheme()).toBe('dark');
    expect(handle.calls.updateSettings).toBe(1);
    expect(handle.settingsPatches[0]).toEqual({ theme: 'dark' });
    expect(handle.preferences.theme).toBe('dark');
    expect(segmentedButton('深色')?.getAttribute('aria-pressed')).toBe('true');
    expect(segmentedButton('跟随系统')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('强制深色后系统切浅色也不跟随', async () => {
    await mount();
    await openSettings();
    await click(segmentedButton('深色'));
    await settle();

    setSystemTheme('light');
    await settle();
    expect(appliedTheme()).toBe('dark');
  });

  it('强制浅色后系统切深色也不跟随', async () => {
    await mount();
    await openSettings();
    await click(segmentedButton('浅色'));
    await settle();
    expect(appliedTheme()).toBe('light');

    setSystemTheme('dark');
    await settle();
    expect(appliedTheme()).toBe('light');
  });

  it('从强制模式切回「跟随系统」后重新跟随系统', async () => {
    await mount({ preferences: { theme: 'dark' } });
    expect(appliedTheme()).toBe('dark');

    await openSettings();
    await click(segmentedButton('跟随系统'));
    await settle();
    expect(handle.preferences.theme).toBe('system');

    setSystemTheme('light');
    await settle();
    expect(appliedTheme()).toBe('light');
  });

  it('库里是非法主题值时按 system 处理', async () => {
    await mount({ preferences: { theme: 'neon' } });
    expect(appliedTheme()).toBe('light');

    setSystemTheme('dark');
    await settle();
    expect(appliedTheme()).toBe('dark');
  });

  it('保存失败：回滚到已保存偏好并显示错误，不假装已保存', async () => {
    await mount({ preferences: { theme: 'light' }, settingsSaveFails: true });
    await openSettings();
    expect(appliedTheme()).toBe('light');

    await click(segmentedButton('深色'));
    await settle();

    expect(appliedTheme()).toBe('light');
    expect(segmentedButton('浅色')?.getAttribute('aria-pressed')).toBe('true');
    expect(bodyText()).toContain('主题保存失败');
  });

  it('主题切换不触发任何抓取', async () => {
    await mount();
    const before = { ...handle.calls };

    await openSettings();
    await click(segmentedButton('深色'));
    await settle();
    await click(segmentedButton('浅色'));
    await settle();

    expect(handle.calls.fetchDetail).toBe(before.fetchDetail);
    expect(handle.calls.refreshGlance).toBe(before.refreshGlance);
    expect(handle.calls.listRepositories).toBe(before.listRepositories);
  });
});

describe('主题 · 图表配色', () => {
  it('主题切换后图表配色随之重算（同一次挂载内，无需重进页面）', async () => {
    handle = createStub({ preferences: { theme: 'light' } });
    view = await renderNode(
      handle,
      <div>
        <ThemeSelector />
        <PaletteProbe />
      </div>,
    );
    await settle();

    const probe = (): string =>
      view?.container.querySelector('[data-testid="palette"]')?.textContent ?? '';
    const light = probe();
    expect(light.startsWith('light|')).toBe(true);

    await click(segmentedButton('深色'));
    await settle();

    const dark = probe();
    expect(dark.startsWith('dark|')).toBe(true);
    expect(dark).not.toBe(light);
  });

  it('浅色与深色的图表配色是两套非空色值', () => {
    const light = resolveChartPalette('light');
    const dark = resolveChartPalette('dark');
    for (const palette of [light, dark]) {
      for (const value of Object.values(palette)) expect(value.length).toBeGreaterThan(0);
    }
    expect(light.star).not.toBe(dark.star);
    expect(light.fork).not.toBe(dark.fork);
    expect(light.grid).not.toBe(dark.grid);
  });
});

describe('双主题 · 关键界面可用性', () => {
  it('浅色下清单 / 详情 / Tabs / Popover 照常可用，且不存在硬编码调色板类', async () => {
    await mount({ preferences: { theme: 'light' } });
    expect(appliedTheme()).toBe('light');
    expect(repoRows()).toHaveLength(1);

    await click(repoOpenButton(REPO));
    await settle();
    expect(document.querySelector('[role="tablist"]')).not.toBeNull();

    await click(
      [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (tab) => tab.textContent?.trim() === '发版',
      ),
    );
    await settle();
    expect(bodyText()).toContain('发版');

    await click(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '← 返回监控清单',
      ),
    );
    await settle();
    await click(repoActionsButton(REPO));
    await settle();
    expect(menu()).not.toBeNull();
    await pressEscape();
    await settleOverlayClose();
    expect(menu()).toBeNull();

    // 迁移完成的护栏：业务组件不再直接写 slate-* / emerald-*
    expect(document.body.innerHTML).not.toMatch(/slate-|emerald-/);
  });

  it('主题按钮是真 button，且 aria-pressed 反映当前选中', async () => {
    await mount({ preferences: { theme: 'light' } });
    await openSettings();

    const darkButton = segmentedButton('深色');
    expect(darkButton?.tagName).toBe('BUTTON');
    expect(darkButton?.getAttribute('type')).toBe('button');
    expect(darkButton?.getAttribute('aria-pressed')).toBe('false');
    expect(segmentedButton('浅色')?.getAttribute('aria-pressed')).toBe('true');

    await click(darkButton);
    await settle();
    expect(appliedTheme()).toBe('dark');
    expect(segmentedButton('深色')?.getAttribute('aria-pressed')).toBe('true');
  });
});
