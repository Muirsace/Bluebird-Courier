import type { LayoutMode } from '../lib/app-layout';

interface CompactRepositoryContextProps {
  /** The upstream host selects presentation; Narrow retains its original markup. */
  presentation?: LayoutMode;
  /** 当前正在浏览的仓库全名（App 的 selected，进详情那一刻就确定）。 */
  fullName: string;
  /** Repository Header 已经滚出视口：由页面顶部接管当前仓库身份。 */
  visible: boolean;
}

/**
 * App Header 里的「当前仓库」上下文。
 *
 * Repository Header 滚走后它接管仓库身份，滚回顶部时交还给页面里的那块表头——
 * 信息层级因此始终是「App → 当前仓库 → 当前视图」，仓库名不挤进 Tabs 那一行。
 *
 * 只做展示：不是按钮也不是链接，没有 tabIndex，也不承担任何操作。
 * 容器始终占位（宽度交给 flex 分配，与可见性无关），所以显隐只影响 opacity 与 X 位移，
 * 品牌、右侧导航与顶部栏高度都不会被推动一下；长名字单行省略，完整名走 title。
 *
 * 最大宽度按断点收窄（窄屏优先让给导航，名字进一步省略），不是靠动画宽度做的收放。
 */
export function CompactRepositoryContext({ fullName, visible, presentation = 'narrow' }: CompactRepositoryContextProps) {
  const [owner, name] = fullName.split('/');
  return (
    <div
      className={`compact-repo-context flex min-w-0 items-center gap-2 max-w-[9rem] sm:max-w-[15rem] lg:max-w-[22rem]${presentation === 'desktop' ? ' desktop-compact-repo-context' : ''}`}
      data-visible={visible ? 'true' : 'false'}
      aria-hidden={visible ? undefined : 'true'}
    >
      <span aria-hidden="true" className="compact-repo-context-divider" />
      {presentation === 'desktop' ? (
        <span className="desktop-compact-identity" title={fullName} aria-label={fullName}>
          <span className="desktop-compact-name font-mono">{name}</span>
          <span className="desktop-compact-owner" title={owner}>· {owner}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate font-mono text-sm font-medium text-secondary" title={fullName} aria-label={fullName}>
          {name} <span className="text-muted">· {owner}</span>
        </span>
      )}
    </div>
  );
}
