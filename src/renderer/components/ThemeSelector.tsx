import { THEME_PREFERENCES } from '../../shared/theme';
import type { ThemePreference } from '../../shared/theme';
import { useTheme } from '../lib/theme';
import { Spinner } from './Spinner';

const LABELS: Record<ThemePreference, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

/** 主题选择：三档分段控件，切换即保存（没有额外的「保存主题」按钮）。 */
export function ThemeSelector() {
  const { preference, saving, error, setPreference } = useTheme();

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span id="theme-label" className="text-sm text-secondary">
          主题
        </span>
        <div
          role="group"
          aria-labelledby="theme-label"
          aria-busy={saving}
          className="inline-flex h-9 items-center rounded-md border border-default bg-surface-raised p-0.5"
        >
          {THEME_PREFERENCES.map((value) => {
            const active = value === preference;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setPreference(value)}
                className={`h-8 rounded px-3 text-sm transition-colors duration-150 ease-out ${
                  active
                    ? 'bg-surface font-medium text-accent active:bg-surface-active'
                    : 'text-secondary hover:bg-surface-hover hover:text-primary active:bg-surface-active'
                }`}
              >
                {LABELS[value]}
              </button>
            );
          })}
        </div>
        {saving ? (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Spinner className="h-3.5 w-3.5" />
            保存中…
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error.message}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted">
        跟随系统时，Windows 切换深色 / 浅色会立即反映到青鸟信使。
      </p>
    </div>
  );
}
