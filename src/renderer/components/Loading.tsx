import { Spinner } from './Spinner';

/**
 * 统一的加载中块（清单页与详情页共用）。
 * Spinner / 文案各自带一个类名，详情页首次抓取完成时按它们做"就地退出"（轻微缩小 / 上移）。
 */
export function Loading({ label }: { label: string }) {
  return (
    <div className="loading-panel flex items-center justify-center gap-2 rounded-lg border border-default bg-surface px-6 py-10 text-sm text-secondary">
      <Spinner className="loading-spinner h-4 w-4" />
      <span className="loading-text">{label}</span>
    </div>
  );
}
