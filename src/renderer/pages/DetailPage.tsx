import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Detail, DetailResult } from '../../shared/types';
import { getApi } from '../lib/api';
import { useDetailReveal } from '../lib/detail-reveal';
import { DETAIL_REVEAL_MOTION, DETAIL_REVEAL_TOTAL_MS } from '../lib/motion';
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
import { RevealItem } from '../components/detail/RevealItem';
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
      return <BuildTab build={detail.build} owner={owner} name={name} />;
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
  /**
   * 记下"这一次 Tab 切换要播内容进场"。
   *
   * 首次揭示那一屏的内容由 Section 错峰带进来，不该再叠一层 tab-panel-enter；
   * 也不能靠"揭示期间抑制这条动画"来做——抑制规则一旦失效，已经挂载的面板会当场
   * 从 opacity 0 重播一次进场（实测就是内容展开后闪一下）。面板按 activeTab 重挂，
   * 所以只要在切 Tab 那一刻记下结论，首屏永远不播。
   *
   * 选中态没变就整个返回：首屏 tabContentSwitched 还是 null，若照直写下去，
   * 点一下当前的「概览」就会把它翻成 'overview'，给已挂载的面板补上类名、重播一次进场。
   */
  const [tabContentSwitched, setTabContentSwitched] = useState<DetailTabId | null>(null);
  const selectTab = useCallback(
    (id: DetailTabId): void => {
      if (id === activeTab) return;
      setTabContentSwitched(id);
      setActiveTab(id);
    },
    [activeTab],
  );

  const fetchedDetail = detailQuery.data?.detail ?? null;
  const keptDetail = lastDetail && lastDetail.id === repositoryId ? lastDetail.detail : null;
  const detail = fetchedDetail ?? keptDetail;
  const fetchError = detailQuery.data?.error ?? null;
  const repository = detail?.repository;

  // 首次抓取的揭示窗口。首帧就有数据（缓存命中）直接算 ready，所以只播一次；
  // 手动重新抓取时旧数据一直都在，阶段早已离开 loading，也不会重播。
  const reveal = useDetailReveal(detail !== null, DETAIL_REVEAL_TOTAL_MS);
  /** 真·抓取中：刷新时旧数据仍在，这里不算 pending，表头与内容都保持原样。 */
  const pending = detailQuery.isPending && !detail;

  return (
    <div className="space-y-4">
      <RepositoryHeader
        fullName={fullName}
        repository={repository}
        fetching={detailQuery.isFetching}
        revealing={reveal === 'revealing'}
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

      {/*
        揭示容器：Loading 与真内容在这一个位置上换手。
        数据一到，Loading 卡就脱离文档流原地淡出，真内容同一帧挂载、按 Section 错峰进入——
        页面高度该多高就是多高，不做整页高度补间，也不会出现"空白一帧"。
      */}
      <div className="detail-reveal" data-reveal={reveal}>
        {pending || reveal === 'revealing' ? (
          <div className="detail-loading-slot" data-state={pending ? 'visible' : 'exiting'}>
            <Loading label="正在抓取全量信息…" />
          </div>
        ) : null}

        {detail ? (
          <div className="space-y-4">
            <RevealItem
              delayMs={DETAIL_REVEAL_MOTION.tabsDelayMs}
              durationMs={DETAIL_REVEAL_MOTION.tabsMs}
              shiftPx={DETAIL_REVEAL_MOTION.tabsShiftPx}
            >
              <DetailTabs active={activeTab} onChange={selectTab} />
            </RevealItem>
            {/*
              刷新期间旧数据仍然有效：不灰化、不遮罩，只由表头的按钮与「正在更新…」表态。
              key 只认 activeTab：数据更新不会换节点，也就不会把这一屏内容重新播一遍进场；
              内容进场动画也只属于真正切过 Tab 的那一屏（见 selectTab）。
            */}
            <div
              key={activeTab}
              role="tabpanel"
              id={`detail-panel-${activeTab}`}
              aria-labelledby={`detail-tab-${activeTab}`}
              className={tabContentSwitched === activeTab ? 'tab-panel-enter' : undefined}
            >
              <TabPanel tab={activeTab} detail={detail} />
            </div>
          </div>
        ) : pending ? null : (
          <div className="rounded-lg border border-dashed border-strong bg-surface/50 px-6 py-10 text-center text-sm text-muted">
            暂无全量信息，请点击「重新抓取」
          </div>
        )}
      </div>
    </div>
  );
}
