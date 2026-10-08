import type { DetailScope } from '../../../shared/types';
import type { ScopePaging } from '../../lib/detail-view';

const SCOPE_LABELS: Record<DetailScope, string> = {
  overview: '概览',
  releases: '发版',
  commits: '提交',
  issuesAndPr: 'Issue & PR',
  builds: '构建',
  readme: 'README',
  tree: '目录树',
  trends: '趋势',
};

const PAGING_BUTTON_CLASS =
  'inline-flex h-7 items-center rounded-md border border-default px-2 text-xs text-primary transition-colors duration-150 ease-out hover:bg-surface-hover active:bg-surface-active disabled:cursor-not-allowed disabled:opacity-50';

interface LocalReadMoreProps {
  /** 有界本地读取按页推进的范围状态。 */
  pages: readonly ScopePaging[];
  onPage: (scope: DetailScope, direction: -1 | 1) => void;
}

/**
 * 有界本地读取的分页入口：本地只按页读回一段，不把这一段当成完整列表。
 * 换版后旧游标失效会重新从首页读；这里只表达"当前读到第几页、还有没有下一页"。
 */
export function LocalReadMore({ pages, onPage }: LocalReadMoreProps) {
  if (pages.length === 0) return null;
  return (
    <div className="detail-local-read-more flex flex-col gap-2">
      {pages.map((paging) => (
        <div key={paging.scope} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>
            {SCOPE_LABELS[paging.scope]} 已读取本地第 {paging.page} 页
            {paging.hasNext ? '，本地还有更多内容。' : '（本地内容的最后一页）。'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-button-motion="compact"
              onClick={() => onPage(paging.scope, -1)}
              disabled={!paging.hasPrev}
              aria-label={`${SCOPE_LABELS[paging.scope]} 上一页`}
              className={PAGING_BUTTON_CLASS}
            >
              上一页
            </button>
            <button
              type="button"
              data-button-motion="compact"
              onClick={() => onPage(paging.scope, 1)}
              disabled={!paging.hasNext}
              aria-label={`${SCOPE_LABELS[paging.scope]} 下一页`}
              className={PAGING_BUTTON_CLASS}
            >
              下一页
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
