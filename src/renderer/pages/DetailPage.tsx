import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Detail, DetailResult } from '../../shared/types';
import { getApi } from '../lib/api';
import { appScrollRoot } from '../lib/app-layout';
import { useDetailReveal } from '../lib/detail-reveal';
import { DETAIL_REVEAL_MOTION, DETAIL_REVEAL_TOTAL_MS } from '../lib/motion';
import { ErrorBar } from '../components/ErrorBar';
import { CompactRepositoryContext } from '../components/CompactRepositoryContext';
import { Loading } from '../components/Loading';
import { WorkspaceMessage } from '../components/StateMessage';
import { describeError } from '../lib/errors';
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
  /** 由 App 现有响应式状态决定；单栏保留完整的页面导航。 */
  workspace: boolean;
  workspaceRepoSwitch?: boolean;
  repositoryContextVisible: boolean;
  repositoryId: number;
  fullName: string;
  /** 上报 Repository Header 是否已滚出视口，由 App 同步当前宿主中的 Compact Context。 */
  onRepositoryContextChange: (visible: boolean) => void;
  onBack: () => void;
  onGoSettings: () => void;
}

/** 焦点在可编辑控件里：那里 Esc 的语义是"取消本次输入"，不该被当成导航。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
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

export function DetailPage({
  workspace,
  workspaceRepoSwitch = false,
  repositoryContextVisible,
  repositoryId,
  fullName,
  onRepositoryContextChange,
  onBack,
  onGoSettings,
}: DetailPageProps) {
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
   * Repository Header 是否已经滚出视口 → 顶部栏要不要接管"当前仓库"。
   *
   * 哨兵是横贯表头的一张极窄色带（位置由 CSS 按顶部栏实测高度算）：它整体离开视口顶端，
   * 说明表头不仅越了界、还多走了约 10px；它重新完整进来，说明表头还剩约 4px 就要露头。
   * 中间那 6px 保持现状——这就是迟滞区间，临界点上下轻滚不会反复闪。
   * threshold [0, 1] 让一个观察器同时给出两个边界，不需要监听滚动、也不需要第二个阈值。
   */
  const repoContextSentinelRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const sentinel = repoContextSentinelRef.current;
    // 没有布局引擎（测试环境）时不装观察器：顶部栏保持不接管
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    let live = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!live) return;
        const entry = entries[0];
        if (!entry) return;
        if (entry.intersectionRatio === 0) onRepositoryContextChange(true);
        else if (entry.intersectionRatio === 1) onRepositoryContextChange(false);
      },
      { root: appScrollRoot(sentinel), threshold: [0, 1] },
    );
    observer.observe(sentinel);
    return () => { live = false; observer.disconnect(); };
  }, [onRepositoryContextChange, workspace]);
  /**
   * Tabs 吸附态。吸附线是"顶部栏下沿"，所以哨兵放在吸附线正上方一个顶部栏高度处：
   * 它越过视口顶端的那一刻，正好就是 Tabs 抵达吸附线的那一刻。
   * IntersectionObserver 只在穿越时回调，不做逐帧监听。
   *
   * 切 Tab 要不要重置纵向滚动，判据就是这里的真实吸附状态——不是 `scrollY > 某个阈值`。
   */
  const tabsSentinelRef = useRef<HTMLSpanElement>(null);
  const [tabsStuck, setTabsStuck] = useState(false);

  useLayoutEffect(() => {
    const sentinel = tabsSentinelRef.current;
    // 没有布局引擎（测试环境）时不装观察器：stuck 恒为 false，不影响语义与 ARIA
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    let live = true;
    const observer = new IntersectionObserver((entries) => {
      if (!live) return;
      const entry = entries[0];
      if (!entry) return;
      setTabsStuck(!entry.isIntersecting);
    }, { root: appScrollRoot(sentinel) });
    observer.observe(sentinel);
    return () => { live = false; observer.disconnect(); };
  }, [workspace]);

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

  /** 当前 Tab 内容的起点：已吸附时切 Tab 的滚动落点就是它。 */
  const tabContentTopRef = useRef<HTMLDivElement>(null);

  /**
   * 这一次切 Tab 要不要把内容起点滚到位？取决于**用户触发切换那一刻** Tabs 是否已经吸附。
   *
   * 必须在 setActiveTab 之前记下来：新旧 Tab 的高度可能差很多，commit 之后浏览器会重排，
   * 新 Tab 更矮时还会把 scrollY 直接夹掉，那时再读 tabsStuck 已经不是触发切换时的状态了。
   */
  const resetTabScrollRef = useRef(false);
  const previousLayoutRef = useRef(workspace);
  useLayoutEffect(() => {
    if (previousLayoutRef.current === workspace) return;
    previousLayoutRef.current = workspace;
    setTabsStuck(false);
    onRepositoryContextChange(false);
    setTabContentSwitched(null);
    resetTabScrollRef.current = false;
  }, [workspace, onRepositoryContextChange]);

  const selectTab = useCallback(
    (id: DetailTabId): void => {
      if (id === activeTab) return;
      setTabContentSwitched(id);
      resetTabScrollRef.current = tabsStuck;
      setActiveTab(id);
    },
    [activeTab, tabsStuck],
  );

  /**
   * 已吸附时切 Tab：把内容起点落到 Sticky Tabs 下沿（偏移由 .detail-tab-content-anchor 的
   * scroll-margin-top 给出），新 Tab 从自己的开头显示，而不是继承旧 Tab 的深度位置。
   *
   * 未吸附时（页面还在顶部 / 只是轻微滚动）什么都不做：scrollY 原地不动，Repository Header
   * 与 Tabs 继续待在原处——用户没往下滚，切个 Tab 不该把它们主动送出视口。
   *
   * 标记读过立刻清掉，之后任何重渲染（数据更新 / 主题 / resize）都不会再滚一次；首屏它本来
   * 就是 false，所以 mount 也不会误滚。必须是 layout effect：晚一帧用户就会先看见新内容
   * 停在旧深度上，再被拽到起点。
   */
  useLayoutEffect(() => {
    if (!resetTabScrollRef.current) return;
    resetTabScrollRef.current = false;
    tabContentTopRef.current?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
  }, [activeTab]);

  /**
   * Esc = 点「← 返回监控清单」：共用同一个 onBack，所以返回动画与清单滚动恢复全部一致。
   *
   * 挂在 window 而不是 document：冒泡路径上 document 先于 window，浮层（现有几处都挂在
   * document 上）永远先拿到 Esc；它们消费掉这次按键后 preventDefault，这里据此让路——
   * 优先级不依赖两者谁先注册。
   */
  useEffect(() => {
    // 常驻 Sidebar 的工作区不承担“返回父页”导航；单栏仍复用原来的 Back / Esc 路径。
    if (workspace) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented || event.isComposing) return;
      if (isEditableTarget(event.target)) return;
      onBack();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack, workspace]);

  const fetchedDetail = detailQuery.data?.detail ?? null;
  const keptDetail = lastDetail && lastDetail.id === repositoryId ? lastDetail.detail : null;
  const detail = fetchedDetail ?? keptDetail;
  const fetchError = detailQuery.data?.error ?? null;
  const detailError = fetchError ?? (detailQuery.isError
    ? { kind: 'unknown' as const, message: '全量信息加载失败，请稍后重试' }
    : null);
  const repository = detail?.repository;

  // 首次抓取的揭示窗口。首帧就有数据（缓存命中）直接算 ready，所以只播一次；
  // 手动重新抓取时旧数据一直都在，阶段早已离开 loading，也不会重播。
  const reveal = useDetailReveal(detail !== null, DETAIL_REVEAL_TOTAL_MS, workspace);
  /** 真·抓取中：刷新时旧数据仍在，这里不算 pending，表头与内容都保持原样。 */
  const pending = detailQuery.isPending && !detail;

  return (
    <div className="detail-page space-y-4" data-workspace={workspace}
      data-workspace-switch={workspace && workspaceRepoSwitch || undefined}
      data-workspace-enter={workspace && workspaceRepoSwitch && detail !== null || undefined}>
      {/*
        表头与它的哨兵同属一个定位容器：哨兵的落点由 CSS 按顶部栏实测高度从这块区域的下沿往上量，
        所以包装层只提供包含块，不参与视觉（表头仍是这一个，没有复制）。
      */}
      <div className="repo-context-scope">
        <RepositoryHeader
          presentation={workspace ? 'desktop' : 'narrow'}
          fullName={fullName}
          repository={repository}
          fetching={detailQuery.isFetching}
          revealing={reveal === 'revealing'}
          onBack={onBack}
          onRefetch={() => void detailQuery.refetch()}
        />
        <span ref={repoContextSentinelRef} aria-hidden="true" className="repo-context-sentinel" />
      </div>

      {detail && detailError ? (
        <ErrorBar
          error={detailError}
          summary="重新抓取失败"
          onGoSettings={onGoSettings}
          action={{ label: '重试', onClick: () => void detailQuery.refetch(), disabled: detailQuery.isFetching }}
        />
      ) : null}

      {/*
        揭示容器：Loading 与真内容在这一个位置上换手。
        数据一到，Loading 卡就脱离文档流原地淡出，真内容同一帧挂载、按 Section 错峰进入——
        页面高度该多高就是多高，不做整页高度补间，也不会出现"空白一帧"。
      */}
      <div className="detail-reveal" data-reveal={reveal}>
        {/*
          吸附哨兵：绝对定位、不占位，因此不会给 space-y-4 多塞一个子项、也不会挪动 Tabs。
          它的位置由 CSS 按顶部栏实测高度算（吸附线正上方一个顶部栏高度）。
        */}
        <span ref={tabsSentinelRef} aria-hidden="true" className="detail-tabs-sentinel" />

        {pending || reveal === 'revealing' ? (
          <div className="detail-loading-slot" data-state={pending ? 'visible' : 'exiting'} aria-hidden={!pending}>
            <Loading label="正在加载仓库详情…" active={pending} />
          </div>
        ) : null}

        {detail ? (
          <div className="space-y-4">
            <RevealItem
              className="detail-tabs-sticky"
              delayMs={DETAIL_REVEAL_MOTION.tabsDelayMs}
              durationMs={DETAIL_REVEAL_MOTION.tabsMs}
              shiftPx={DETAIL_REVEAL_MOTION.tabsShiftPx}
            >
              {workspace ? (
                <div className="workspace-repo-context" data-visible={repositoryContextVisible}>
                  <CompactRepositoryContext fullName={fullName} visible={repositoryContextVisible} />
                </div>
              ) : null}
              <DetailTabs active={activeTab} onChange={selectTab} stuck={tabsStuck} />
            </RevealItem>
            {/*
              内容起点：切 Tab 的滚动落点。它只是给滚动定位用的普通 div（没有 role / tabIndex），
              不是第二套语义——tabpanel 还是同一个，aria-controls / aria-labelledby 关系不变。
            */}
            <div ref={tabContentTopRef} className="detail-tab-content-anchor detail-content-responsive">
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
          </div>
        ) : pending ? null : (
          <WorkspaceMessage title={detailError ? '加载仓库详情失败' : '暂无全量信息'}
            description={detailError ? describeError(detailError) : '请点击「重新抓取」'}
            announcement={detailError ? 'alert' : undefined}>
            <button type="button" className="state-action" aria-label="重新抓取仓库详情"
              onClick={() => void detailQuery.refetch()} disabled={detailQuery.isFetching}>重新抓取</button>
            {detailError?.kind === 'access_token_invalid' ? (
              <button type="button" className="state-action" onClick={onGoSettings}>去设置</button>
            ) : null}
          </WorkspaceMessage>
        )}
      </div>
    </div>
  );
}
