import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { THEME_PREFERENCES } from '../../shared/types';
import type { ThemePreference } from '../../shared/types';
import { useTheme } from '../lib/theme';

const LABELS: Record<ThemePreference, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

/** 主题选择：三档分段控件，切换即保存（没有额外的「保存主题」按钮）。 */
export function ThemeSelector() {
  const { preference, initialized, error, setPreference } = useTheme();
  const controlRef = useRef<HTMLDivElement>(null);
  const [sliderReady, setSliderReady] = useState(false);

  const positionSlider = useCallback((): void => {
    const control = controlRef.current;
    const active = control?.querySelector<HTMLButtonElement>(
      `[data-theme-option="${preference}"]`,
    );
    if (!control || !active) return;

    const controlRect = control.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    control.style.setProperty('--theme-slider-x', `${activeRect.left - controlRect.left}px`);
    control.style.setProperty('--theme-slider-width', `${activeRect.width}px`);
  }, [preference]);

  useLayoutEffect(() => {
    positionSlider();
    if (initialized) setSliderReady(true);
  }, [initialized, positionSlider]);

  useEffect(() => {
    const control = controlRef.current;
    if (!control) return;

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(positionSlider);
      observer.observe(control);
      control.querySelectorAll('button[data-theme-option]').forEach((button) => observer.observe(button));
      return () => observer.disconnect();
    }

    window.addEventListener('resize', positionSlider);
    return () => window.removeEventListener('resize', positionSlider);
  }, [positionSlider]);

  return (
    <div className="settings-row">
      <span id="theme-label" className="settings-row-label text-sm text-secondary">
        主题
      </span>
      <div className="settings-row-control min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div
            ref={controlRef}
            role="group"
            aria-labelledby="theme-label"
            data-selected-theme={preference}
            className="theme-segmented-control theme-segmented-track"
          >
            <span
              className="theme-segment-slider"
              data-ready={sliderReady ? 'true' : 'false'}
              aria-hidden="true"
            />
            {THEME_PREFERENCES.map((value) => {
              const active = value === preference;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  data-theme-option={value}
                  data-button-motion="compact"
                  onClick={() => setPreference(value)}
                  className={`theme-segment-button ${
                    active
                      ? 'text-accent'
                      : 'text-secondary hover:text-primary active:text-primary'
                  }`}
                >
                  {LABELS[value]}
                </button>
              );
            })}
          </div>
        </div>
        <p className="settings-theme-description mt-2 text-xs text-muted">
          跟随系统时，Windows 切换深色 / 浅色会立即反映到青鸟信使。
        </p>
        {error ? (
          <div className="settings-inline-status settings-theme-error mt-2" role="alert">
            <span aria-hidden="true" className="shrink-0 font-medium">⚠</span>
            <span className="min-w-0 break-words">{error.message}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
