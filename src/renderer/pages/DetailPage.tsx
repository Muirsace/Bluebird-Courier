import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Detail, DetailResult } from '../../shared/types';
import { getApi } from '../lib/api';
import { ErrorBar } from '../components/ErrorBar';
import { Loading } from '../components/Loading';
import { BuildTab } from '../components/detail/BuildTab';
import { CommitTab } from '../components/detail/CommitTab';
import { DetailTabs } from '../components/detail/DetailTabs';
import type { DetailTabId } from '../components/detail/DetailTabs';
import { IssuesTab } from '../components/detail/IssuesTab';
import { OverviewTab } from '../components/detail/OverviewTab';
import { ReleaseTab } from '../components/detail/ReleaseTab';
import { RepositoryHeader } from '../components/detail/RepositoryHeader';
import { TrendTab } from '../components/detail/TrendTab';

interface DetailPageProps {
  repositoryId: number;
  fullName: string;
  onBack: () => void;
  onGoSettings: () => void;
}

function TabPanel({ tab, detail }: { tab: DetailTabId; detail: Detail }) {
  // 外链目标只需要 owner/name，一律取自接口回来的规范值
  const { owner, name } = detail.repository;
  switch (tab) {
    case 'releases':
      return <ReleaseTab releases={detail.releases} owner={owner} name={name} />;
    case 'commits':
      return <CommitTab commits={detail.commits} owner={owner} name={name} />;
    case 'issues':
      return <IssuesTab issues={detail.issues} pullRequests={detail.pullRequests} owner={owner} name={name} />;
    case 'build':
      return <BuildTab build={detail.build} />;
    case 'trend':
      return <TrendTab trend={detail.trend} />;
    default:
      return <OverviewTab detail={detail} />;
  }
}

export function DetailPage({ repositoryId, fullName, onBack, onGoSettings }: DetailPageProps) {
  const detailQuery = useQuery({
    queryKey: ['detail', repositoryId],
    queryFn: async (): Promise<DetailResult> => {
      try {
        return await getApi().fetchDetail(repositoryId);
      } catch {
        return { detail: null, error: { kind: 'unknown', message: '抓取全量信息失败，请稍后重试' } };
      }
    },
    // 详情是全应用唯一会打 GitHub 网络、且带副作用的查询（一次抓取 = 4 次 API 调用 + 写当日快照）。
    // 所以它不进任何自动重取通道：只有首次进入（无缓存）和用户点「重新抓取」才真正请求。
    // gcTime 必须一并放开，否则缓存 5 分钟被回收后再进入会被当成"首次进入"而重抓。
    // 切 Tab 只是同一个查询实例内的本地状态，不产生任何请求。
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // 抓取失败时保留上一次成功加载的全量信息（按仓库归属，切换仓库时不串数据）
  const [lastDetail, setLastDetail] = useState<{ id: number; detail: Detail } | null>(null);
  useEffect(() => {
    const detail = detailQuery.data?.detail;
    if (detail) setLastDetail({ id: repositoryId, detail });
  }, [detailQuery.data, repositoryId]);

  // 详情内部导航：默认概览
  const [activeTab, setActiveTab] = useState<DetailTabId>('overview');

  const fetchedDetail = detailQuery.data?.detail ?? null;
  const keptDetail = lastDetail && lastDetail.id === repositoryId ? lastDetail.detail : null;
  const detail = fetchedDetail ?? keptDetail;
  const fetchError = detailQuery.data?.error ?? null;
  const repository = detail?.repository;

  return (
    <div className="space-y-4">
      <RepositoryHeader
        fullName={fullName}
        repository={repository}
        fetching={detailQuery.isFetching}
        onBack={onBack}
        onRefetch={() => void detailQuery.refetch()}
      />

      {fetchError ? <ErrorBar error={fetchError} onGoSettings={onGoSettings} /> : null}
      {detailQuery.isError ? (
        <ErrorBar
          error={{ kind: 'unknown', message: '全量信息加载失败，请稍后重试' }}
          onGoSettings={onGoSettings}
          action={{ label: '重试', onClick: () => void detailQuery.refetch() }}
        />
      ) : null}

      {detailQuery.isPending && !detail ? (
        <Loading label="正在抓取全量信息…" />
      ) : detail ? (
        <>
          <DetailTabs active={activeTab} onChange={setActiveTab} />
          {/* 刷新期间旧数据仍然有效：不灰化、不遮罩，只由表头的按钮与「正在更新…」表态 */}
          <div
            role="tabpanel"
            id={`detail-panel-${activeTab}`}
            aria-labelledby={`detail-tab-${activeTab}`}
          >
            <TabPanel tab={activeTab} detail={detail} />
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-strong bg-surface/50 px-6 py-10 text-center text-sm text-muted">
          暂无全量信息，请点击「重新抓取」
        </div>
      )}
    </div>
  );
}
