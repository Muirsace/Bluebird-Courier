import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NormalizedError, SettingsView } from '../../shared/types';
import { normalizeThemePreference, resolveEffectiveTheme, THEME_PREFERENCE_KEY } from '../../shared/theme';
import type { EffectiveTheme, ThemePreference } from '../../shared/theme';
import { getApi } from './api';

/** 主题状态的唯一来源：组件一律经 useTheme / useEffectiveTheme 读取，不自行 matchMedia。 */
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 偏好保存失败时的提示。 */
const SAVE_ERROR: NormalizedError = { kind: 'unknown', message: '主题保存失败，请稍后重试' };

function systemThemeNow(): EffectiveTheme {
  if (typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** 系统主题：preference=system 时它决定最终主题，强制模式下只是背景信息。 */
function useSystemTheme(): EffectiveTheme {
  const [theme, setTheme] = useState<EffectiveTheme>(systemThemeNow);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DARK_QUERY);
    const sync = (): void => setTheme(media.matches ? 'dark' : 'light');
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  return theme;
}

interface ThemeContextValue {
  preference: ThemePreference;
  effective: EffectiveTheme;
  saving: boolean;
  error: NormalizedError | null;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => getApi().getSettings(),
  });
  const savedPreference = normalizeThemePreference(
    settingsQuery.data?.preferences[THEME_PREFERENCE_KEY],
  );

  // 乐观值：切换立即生效；保存成功后交还给 settings 查询，失败则回滚到已保存值
  const [optimistic, setOptimistic] = useState<ThemePreference | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<NormalizedError | null>(null);

  const preference = optimistic ?? savedPreference;
  const systemTheme = useSystemTheme();
  const effective = resolveEffectiveTheme(preference, systemTheme);

  // 主题只体现在 <html data-theme>，配色全交给 CSS 变量
  useEffect(() => {
    document.documentElement.dataset.theme = effective;
  }, [effective]);

  const setPreference = useCallback(
    (next: ThemePreference): void => {
      setOptimistic(next);
      setSaving(true);
      setError(null);
      void (async () => {
        try {
          const view: SettingsView = await getApi().updateSettings({
            [THEME_PREFERENCE_KEY]: next,
          });
          queryClient.setQueryData(['settings'], view);
          setOptimistic(null);
        } catch {
          // 保存失败不能假装已经生效：回到已保存的偏好并报错
          setOptimistic(null);
          setError(SAVE_ERROR);
        } finally {
          setSaving(false);
        }
      })();
    },
    [queryClient],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, effective, saving, error, setPreference }),
    [preference, effective, saving, error, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return value;
}

/** 只关心最终主题的消费方（趋势图等）用它。 */
export function useEffectiveTheme(): EffectiveTheme {
  return useTheme().effective;
}
