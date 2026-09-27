import { Spinner } from './Spinner';

/** 统一的加载中块（清单页与详情页共用）。 */
export function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-default bg-surface px-6 py-10 text-sm text-secondary">
      <Spinner />
      {label}
    </div>
  );
}
