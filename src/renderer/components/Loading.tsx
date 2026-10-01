import { Spinner } from './Spinner';

/**
 * 统一的加载中块（清单页与详情页共用）。
 * Spinner / 文案各自带一个类名，详情页首次抓取完成时按它们做"就地退出"（轻微缩小 / 上移）。
 */
export function Loading({ label, active = true }: { label: string; active?: boolean }) {
  return (
    <div role={active ? 'status' : undefined} aria-busy={active || undefined} aria-atomic={active || undefined}
      className="loading-panel state-loading flex items-center justify-center gap-2 rounded-md bg-surface-raised px-4 py-6 text-sm text-secondary">
      <Spinner className="loading-spinner h-4 w-4" />
      <span className="loading-text">{label}</span>
    </div>
  );
}
