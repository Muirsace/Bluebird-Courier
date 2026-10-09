import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Detail, Glance } from '../../shared/types';
import { getApi } from '../lib/api';
import { resolveAppScrollRoot } from '../lib/app-scroll-root';
import { useDetailReveal } from '../lib/detail-reveal';
import { mergeSummary, useDetailView } from '../lib/detail-view';
import { DETAIL_REVEAL_MOTION, DETAIL_REVEAL_TOTAL_MS } from '../lib/motion';
import { ErrorBar } from '../components/ErrorBar';
import { CompactRepositoryContext } from '../components/CompactRepositoryContext';
import { Loading } from '../components/Loading';
import { WorkspaceMessage } from '../components/StateMessage';
import { describeError } from '../lib/errors';
import { BuildTab } from '../components/detail/BuildTab';
import { CommitTab } from '../components/detail/CommitTab';
import { DetailTabs, TAB_DISPLAY_SCOPES, TAB_READ_SCOPES } from '../components/detail/DetailTabs';
import type { DetailTabId } from '../components/detail/DetailTabs';
import { IssuesTab } from '../components/detail/IssuesTab';
import { LocalReadMore } from '../components/detail/LocalReadMore';
import { OverviewTab } from '../components/detail/OverviewTab';
import { ReleaseTab } from '../components/detail/ReleaseTab';
import { RepositoryHeader } from '../components/detail/RepositoryHeader';
import { RevealItem } from '../components/detail/RevealItem';
import { TrendTab } from '../components/detail/TrendTab';
import type { ScopePaging } from '../lib/detail-view';

interface DetailPageProps {
  /** Presentation/lifecycle from App; Sticky observer roots follow actual DOM ownership. */
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

/**
 * 最新主进程 Summary：详情自带 Glance 与清单 Query 的 L1 取 fetchedAt 较新的一个。
 * 后台采样或详情提交后主进程会给出更新的摘要，较旧的 L1 不能把它覆盖回去；
 * 首屏还没有任何详情内容时保持 undefined，表头继续用占位符（揭示语义不变）。
 */
function newerSummary(detailRepo: Glance | null, listEntry: Glance | undefined): Glance | null {
  if (!detailRepo) return null;
  if (!listEntry) return detailRepo;
  const detailAt = detailRepo.fetchedAt ? Date.parse(detailRepo.fetchedAt) : Number.NaN;
  const listAt = listEntry.fetchedAt ? Date.parse(listEntry.fetchedAt) : Number.NaN;
  if (Number.isNaN(listAt)) return Number.isNaN(detailAt) ? mergeSummary(detailRepo, listEntry) : mergeSummary(listEntry, detailRepo);
  if (Number.isNaN(detailAt)) return mergeSummary(detailRepo, listEntry);
  // 同毫秒以最新清单查询事实为准，明确 null 不会被旧详情 tag 盖回。
  return detailAt > listAt ? mergeSummary(listEntry, detailRepo) : mergeSummary(detailRepo, listEntry);
}

function TabPanel({
  tab,
  detail,
  incompleteIssueScope,
  issuesDisabled,
  pullsDisabled,
}: {
  tab: DetailTabId;
  detail: Detail;
  incompleteIssueScope: boolean;
  issuesDisabled: boolean;
  pullsDisabled: boolean;
}) {
  // 外链目标只需要 owner/name，一律取自接口回来的规范值
  const { owner, name } = detail.repository;
  switch (tab) {
    case 'releases':
      return <ReleaseTab releases={detail.releases} owner={owner} name={name} />;
    case 'commits':
      return <CommitTab commits={detail.commits} owner={owner} name={name} />;
    case 'issues':
      return (
        <IssuesTab issues={detail.issues} pullRequests={detail.pullRequests} owner={owner} name={name}
          incomplete={incompleteIssueScope} issuesDisabled={issuesDisabled} pullsDisabled={pullsDisabled} />
      );
    case 'build':
      return <BuildTab build={detail.build} owner={owner} name={name} />;
    case 'trend':
      return <TrendTab trend={detail.trend} />;
    default:
      return <OverviewTab detail={detail} incompleteIssueScope={incompleteIssueScope} issuesDisabled={issuesDisabled} pullsDisabled={pullsDisabled} />;
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
  // 详情内部导航：默认概览
  const [activeTab, setActiveTab] = useState<DetailTabId>('overview');
  const confirmScopes = TAB_DISPLAY_SCOPES[activeTab];
  /** 当前 Tab 需要读取的本地范围：内容版本变化与换 Tab 都只读这些，其他范围的有效窗口原样保留。 */
  const readScopes = TAB_READ_SCOPES[activeTab];

  /**
   * 最新主进程 Summary：只读清单 Query 的 L1（enabled:false 只订阅、不自行触发读取），
   * 与详情自带的 Glance 取较新的一个——Stars / Forks 靠它更新，不依赖强制抓取详情。
   */
  const listQuery = useQuery({
    queryKey: ['repositories'],
    queryFn: () => getApi().listRepositories(),
    enabled: false,
    networkMode: 'always',
  });
  const listEntry = listQuery.data?.find((item) => item.id === repositoryId);
  const view = useDetailView({ repositoryId, readScopes, confirmScopes });
  const repository = useMemo(
    () => newerSummary(view.detail?.repository ?? null, listEntry) ?? undefined,
    [listEntry, view.detail],
  );
  const summaryFetchedAt = repository?.fetchedAt ?? view.summaryFetchedAt;

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
      { root: resolveAppScrollRoot(sentinel).element, threshold: [0, 1] },
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
    }, { root: resolveAppScrollRoot(sentinel).element });
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

  const detail = view.detail;
  const detailError = view.error;
  /** 当前 Tab 里已按页读取、需要给出翻页入口的范围（概览元数据不可翻页）。 */
  const paging = readScopes
    .filter((scope) => scope !== 'overview')
    .map((scope) => view.paging[scope])
    .filter((item): item is ScopePaging => item !== undefined);

  // 首次抓取的揭示窗口。首帧就有数据（缓存命中）直接算 ready，所以只播一次；
  // 强制重新抓取时旧数据一直都在，阶段早已离开 loading，也不会重播。
  const reveal = useDetailReveal(detail !== null, DETAIL_REVEAL_TOTAL_MS, workspace);
  // App 按 repositoryId 重挂详情。只在挂载首帧已有全量缓存时播工作区切换；
  // 冷缓存的数据到达继续走原有揭示，不能在 loading → ready 时补整页入场、带着表头再动一次。
  const [hasDetailOnMount] = useState(() => detail !== null);
  const cachedWorkspaceSwitch = workspace && workspaceRepoSwitch && hasDetailOnMount;
  /** 真·首次加载中：没有任何可展示内容时才是整页 Loading。 */
  const pending = view.loading;

  return (
    <div className="detail-page space-y-4" data-workspace={workspace}
      data-workspace-switch={cachedWorkspaceSwitch || undefined}
      data-workspace-enter={cachedWorkspaceSwitch || undefined}>
      {/*
        表头与它的哨兵同属一个定位容器：哨兵的落点由 CSS 按顶部栏实测高度从这块区域的下沿往上量，
        所以包装层只提供包含块，不参与视觉（表头仍是这一个，没有复制）。
      */}
      <div className="repo-context-scope">
        <RepositoryHeader
          presentation={workspace ? 'desktop' : 'narrow'}
          fullName={fullName}
          repository={repository}
          summaryFetchedAt={summaryFetchedAt}
          detailFetchedAt={view.detailFetchedAt}
          busy={view.busy}
          revealing={reveal === 'revealing'}
          onBack={onBack}
          onRefetch={view.forceRefresh}
        />
        <span ref={repoContextSentinelRef} aria-hidden="true" className="repo-context-sentinel" />
      </div>

      {detail && detailError ? (
        <ErrorBar
          error={detailError}
          summary="重新抓取失败"
          onGoSettings={onGoSettings}
          action={{ label: '重试', onClick: view.forceRefresh, disabled: view.busy }}
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
                  <CompactRepositoryContext presentation="desktop" fullName={fullName} visible={repositoryContextVisible} />
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
                后台内容替换期间旧数据仍然有效：不灰化、不遮罩，只由表头的按钮与「正在更新…」表态。
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
                <TabPanel tab={activeTab} detail={detail} incompleteIssueScope={view.partial.issuesAndPr === true}
                  issuesDisabled={view.columns.issues?.status === 'unsupported'} pullsDisabled={view.columns.pullRequests?.status === 'unsupported'} />
              </div>
              {/* 有界本地读取只覆盖了若干页：给出上一页 / 下一页，不把当前一页当成完整列表。 */}
              {paging.length > 0 ? (
                <div className="mt-3">
                  <LocalReadMore pages={paging} onPage={view.goPage} />
                </div>
              ) : null}
            </div>
          </div>
        ) : pending ? null : (
          <WorkspaceMessage title={detailError ? '加载仓库详情失败' : '暂无全量信息'}
            description={detailError ? describeError(detailError) : '请点击「重新抓取」'}
            announcement={detailError ? 'alert' : undefined}>
            <button type="button" className="state-action" aria-label="重新抓取仓库详情"
              onClick={view.forceRefresh} disabled={view.busy}>重新抓取</button>
            {detailError?.kind === 'access_token_invalid' ? (
              <button type="button" className="state-action" onClick={onGoSettings}>去设置</button>
            ) : null}
          </WorkspaceMessage>
        )}
      </div>
    </div>
  );
}
