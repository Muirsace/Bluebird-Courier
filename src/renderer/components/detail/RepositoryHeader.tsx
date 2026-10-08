import type { Glance } from '../../../shared/types';
import type { LayoutMode } from '../../lib/app-layout';
import { DesktopRepositoryHeader } from './DesktopRepositoryHeader';
import { NarrowRepositoryHeader } from './NarrowRepositoryHeader';
import { RepositoryIdentity, RepositoryActions, RepositoryMetrics } from './RepositoryHeaderParts';

interface RepositoryHeaderProps {
  presentation: LayoutMode;
  /** 仓库全名：接口数据回来前的保底标题。 */
  fullName: string;
  repository: Glance | undefined;
  /** 最近一次真实摘要检查时间（取最新主进程 Summary）。 */
  summaryFetchedAt: string | null;
  /** 最近一次完整详情成功提交时间；null 表示尚未完整同步。 */
  detailFetchedAt: string | null;
  /** 强制同步或后台任务进行中。 */
  busy: boolean;
  /** 首次抓取完成后的揭示窗口：指标值从 `—` 交叉淡化到真实值。 */
  revealing: boolean;
  onBack: () => void;
  onRefetch: () => void;
}

/** Shared repository data and actions; each presentation owns its layout DOM. */
export function RepositoryHeader({ presentation, fullName, repository, summaryFetchedAt, detailFetchedAt, busy, revealing, onBack, onRefetch }: RepositoryHeaderProps) {
  // 数据回来前仍使用清单全名，标题与外链目标使用同一份规范值。
  const displayName = repository?.fullName ?? fullName;
  const [owner = '', name = ''] = displayName.split('/');
  const slots = {
    identity: <RepositoryIdentity displayName={displayName} owner={owner} name={name}
      headingLevel={presentation === 'desktop' ? 'h2' : 'h1'}
      summaryFetchedAt={summaryFetchedAt} detailFetchedAt={detailFetchedAt} busy={busy} />,
    actions: <RepositoryActions displayName={displayName} owner={owner} name={name} busy={busy} onRefetch={onRefetch} />,
    metrics: <RepositoryMetrics repository={repository} revealing={revealing} summaryFetchedAt={summaryFetchedAt} />,
  };

  return presentation === 'desktop'
    ? <DesktopRepositoryHeader {...slots} />
    : <NarrowRepositoryHeader {...slots} onBack={onBack} />;
}
