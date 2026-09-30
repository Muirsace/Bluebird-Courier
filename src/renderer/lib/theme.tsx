import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NormalizedError, SettingsView, EffectiveTheme, ThemePreference } from '../../shared/types';
import { THEME_PREFERENCE_KEY } from '../../shared/types';
import { getApi } from './api';

/** 主题状态的唯一来源：组件一律经 useTheme / useEffectiveTheme 读取，不自行 matchMedia。 */
const DARK_QUERY = '(prefers-color-scheme: dark)';

function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

function resolveEffectiveTheme(preference: ThemePreference, systemTheme: EffectiveTheme): EffectiveTheme {
  return preference === 'system' ? systemTheme : preference;
}

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
  initialized: boolean;
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
  const [error, setError] = useState<NormalizedError | null>(null);
  const requestIdRef = useRef(0);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());

  const preference = optimistic ?? savedPreference;
  const systemTheme = useSystemTheme();
  const effective = resolveEffectiveTheme(preference, systemTheme);

  // 主题只体现在 <html data-theme>，配色全交给 CSS 变量
  useEffect(() => {
    document.documentElement.dataset.theme = effective;
  }, [effective]);

  const setPreference = useCallback(
    (next: ThemePreference): void => {
      // Selecting the current value is a true no-op: no state, persistence, or theme side effect.
      if (next === preference) return;

      const requestId = ++requestIdRef.current;
      setOptimistic(next);
      setError(null);
      // Queue writes in selection order. Theme application stays immediate, while a delayed older
      // IPC response can neither overwrite the latest query value nor leave an older preference last.
      const save = persistenceQueueRef.current.then(() =>
        getApi().updateSettings({ [THEME_PREFERENCE_KEY]: next }),
      );
      persistenceQueueRef.current = save.then(
        () => undefined,
        () => undefined,
      );

      void save.then(
        (view: SettingsView) => {
          if (requestIdRef.current !== requestId) return;
          queryClient.setQueryData(['settings'], view);
          setOptimistic(null);
        },
        () => {
          if (requestIdRef.current !== requestId) return;
          // 保持现有语义：保存失败回滚到最近一次已保存的偏好并显示错误。
          setOptimistic(null);
          setError(SAVE_ERROR);
        },
      );
    },
    [preference, queryClient],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, effective, initialized: settingsQuery.isSuccess, error, setPreference }),
    [preference, effective, settingsQuery.isSuccess, error, setPreference],
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
