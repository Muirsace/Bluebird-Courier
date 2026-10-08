# 项目代码目录映射

本文是 `src/` 的具体落位说明。新增、修改、移动或删除代码时，先按本文选择目录和文件，再按 [`skeleton.md`](skeleton.md) 验证职责与依赖白名单。

本文的业务范围来自：

- `.archify/唯一业务流程图/candidate.json`
- `.archify/architecture-github-skeleton-20261002-000000/candidate.json`

当前映射以“青鸟信使 GitHub 仓库浏览桌面 App”为目标结构。业务流程分为 Token 设置、仓库清单、仓库详情、快照趋势四个 feature；feature 之间由 `facade` 编排。删除仓库和更换 Token 时涉及多个 feature 的本地资料，统一由 `facade` 编排，feature 不直接 import 其他 feature。

## 目录总览

```text
src/  # 应用源代码
├─ domain/  # 纯领域模型、端口和业务规则
│  ├─ types.ts  # 领域类型
│  ├─ ports.ts  # 领域端口
│  └─ rules/  # 无 I/O 的纯业务规则
│     ├─ repository-identity.ts  # 仓库标识规范化
│     ├─ repository-eligibility.ts  # 仓库加入资格判断
│     ├─ refresh-window.ts  # 刷新时间窗口判断
│     ├─ activity-sort.ts  # 活动时间排序
│     ├─ detail-cache-policy.ts  # 详情缓存策略
│     ├─ column-state.ts  # 详情栏目状态分类
│     ├─ failure-state.ts  # 失败后资料状态判断
│     └─ snapshot-retention.ts  # 快照日期保留规则
│
├─ shared/  # 跨进程契约和 IPC 常量
│  ├─ types.ts  # 跨进程请求、响应和桥接类型
│  └─ ipc.ts  # IPC 通道常量
│
├─ main/  # Electron 主进程代码
│  ├─ index.ts  # 唯一组合根
│  ├─ ipc.ts  # IPC 注册和 facade 转发
│  ├─ core/  # 可复用基础设施和平台适配
│  │  ├─ infra/  # 数据库、事务、加密、时钟、日志和锁
│  │  │  ├─ database.ts  # 本地数据库连接和通用查询
│  │  │  ├─ migrations.ts  # 数据库迁移
│  │  │  ├─ transaction.ts  # 事务控制
│  │  │  ├─ encryption.ts  # Token 加密和解密
│  │  │  ├─ clock.ts  # 系统时钟
│  │  │  ├─ logger.ts  # 结构化日志
│  │  │  └─ operation-lock.ts  # 批次和仓库并发锁
│  │  └─ adapters/  # GitHub 协议适配和响应转换
│  │     ├─ github-http-client.ts  # GitHub HTTPS 请求客户端
│  │     ├─ github-error-mapper.ts  # GitHub 错误归一化
│  │     ├─ github-token-adapter.ts  # Token 校验适配器
│  │     ├─ github-repository-adapter.ts  # 仓库和摘要适配器
│  │     ├─ github-detail-adapter.ts  # 详情栏目适配器
│  │     └─ shell-links.ts  # 平台外链适配器
│  ├─ features/  # 相互隔离的业务能力
│  │  ├─ repository-list/  # 仓库清单、轻量刷新和清单维护
│  │  │  ├─ contract/  # 仓库清单对外契约
│  │  │  │  ├─ types.ts  # 清单输入、输出和失败类型
│  │  │  │  ├─ service.ts  # 清单服务接口
│  │  │  │  └─ index.ts  # 契约统一导出
│  │  │  └─ implementation/  # 仓库清单内部流程和数据访问
│  │  │     ├─ create.ts  # 清单 feature 创建入口
│  │  │     ├─ service.ts  # 清单服务实现
│  │  │     ├─ repository-list-store.ts  # 清单和摘要存储
│  │  │     ├─ add-repository.ts  # 添加仓库和首次轻量抓取
│  │  │     ├─ list-repositories.ts  # 查询、搜索和排序清单
│  │  │     ├─ refresh-batch.ts  # 批次刷新、游标和批次锁
│  │  │     ├─ retry-repository.ts  # 清单或新增仓库重试
│  │  │     ├─ delete-repository.ts  # 删除清单记录；跨 feature 资料清理由 facade 编排
│  │  │     └─ repository-status.ts  # 归档、删除和改名状态
│  │  ├─ repository-detail/  # 仓库详情、缓存判定和栏目抓取
│  │  │  ├─ contract/  # 仓库详情对外契约
│  │  │  │  ├─ types.ts  # 详情、栏目和分页类型
│  │  │  │  ├─ service.ts  # 详情服务接口
│  │  │  │  └─ index.ts  # 契约统一导出
│  │  │  └─ implementation/  # 仓库详情内部流程和数据访问
│  │  │     ├─ create.ts  # 详情 feature 创建入口
│  │  │     ├─ service.ts  # 详情服务实现
│  │  │     ├─ detail-store.ts  # 详情缓存和栏目状态存储
│  │  │     ├─ open-detail.ts  # 打开详情和缓存判定
│  │  │     ├─ refresh-detail.ts  # 强制完整抓取
│  │  │     ├─ column-loader.ts  # 详情栏目队列加载
│  │  │     ├─ column-aggregator.ts  # 栏目结果聚合
│  │  │     └─ history-pagination.ts  # Commit、Issue、PR 分页
│  │  ├─ token-settings/  # Token 验证、更换和二次确认
│  │  │  ├─ contract/  # Token 设置对外契约
│  │  │  │  ├─ types.ts  # Token 输入和更换结果类型
│  │  │  │  ├─ service.ts  # Token 设置服务接口
│  │  │  │  └─ index.ts  # 契约统一导出
│  │  │  └─ implementation/  # Token 设置内部流程和数据访问
│  │  │     ├─ create.ts  # Token feature 创建入口
│  │  │     ├─ service.ts  # Token 服务实现
│  │  │     ├─ token-store.ts  # 加密 Token 存储
│  │  │     ├─ verify-token.ts  # Token 验证和保存
│  │  │     └─ replace-token.ts  # 二次确认和更换状态；清空由 facade 编排
│  │  └─ snapshot-trend/  # 摘要快照、保留策略和趋势查询
│  │     ├─ contract/  # 快照趋势对外契约
│  │     │  ├─ types.ts  # 快照和趋势类型
│  │     │  ├─ service.ts  # 快照趋势服务接口
│  │     │  └─ index.ts  # 契约统一导出
│  │     └─ implementation/  # 快照趋势内部流程和数据访问
│  │        ├─ create.ts  # 快照 feature 创建入口
│  │        ├─ service.ts  # 快照趋势服务实现
│  │        ├─ snapshot-store.ts  # 快照存储
│  │        ├─ record-snapshot.ts  # 写入当天最后一档
│  │        ├─ retention-runner.ts  # 执行 30 日保留清理
│  │        └─ trend-query.ts  # 查询 Star/Fork 趋势
│  └─ facade/  # 跨 feature 编排和结果组装
│     ├─ facade.ts  # 应用用例入口
│     └─ result-mappers.ts  # 转换为 shared 结果
│
├─ preload/  # 受限的 Electron contextBridge 桥接
│  └─ index.ts  # 暴露 BluebirdCourierBridge
│
└─ renderer/  # 页面、组件和展示映射
   ├─ index.html  # 渲染进程入口页面（vite root）
   ├─ styles.css  # 样式总入口（内联 styles/ 分域文件）
   ├─ assets/  # 品牌标记与图标资源
   ├─ pages/  # 页面级展示和路由入口
   │  ├─ App.tsx  # 页面路由、导航和界面级状态
   │  ├─ WatchlistPage.tsx  # 清单、搜索、刷新和排序
   │  ├─ DetailPage.tsx  # 仓库详情、Tab 与滚动协调
   │  └─ SettingsPage.tsx  # Token 设置入口
   ├─ components/  # 可复用界面组件
   │  ├─ detail/  # 详情表头、Tab 与各栏目组件
   │  ├─ watchlist/  # 清单行、新增表单和操作浮层
   │  ├─ shell/  # 桌面 / 单栏外壳与页面宿主
   │  └─ *.tsx  # 通用组件（加载、空态、错误条等）
   └─ lib/  # 桥接调用、格式化和展示辅助
      ├─ main.tsx  # 渲染进程挂载入口
      ├─ api.ts  # 调用 BluebirdCourierBridge 的唯一数据入口
      ├─ theme.tsx  # 主题 Provider 与偏好保存
      ├─ format.ts  # 时间、数量和状态格式化
      ├─ time.ts  # 相对时间与共享低频时钟
      ├─ errors.ts  # 错误文案映射
      ├─ app-layout.ts  # 布局模式判定
      ├─ app-scroll-root.ts  # 滚动归属解析
      ├─ motion.ts  # 动画预算常量
      ├─ detail-reveal.ts  # 详情揭示状态
      ├─ overlay-placement.ts  # 浮层定位
      ├─ trend.ts / release.ts  # 趋势与发版展示映射
      ├─ chart-theme.ts  # 图表主题
      ├─ external-link.ts  # 外链调用辅助
      ├─ repo-input.ts  # 新增输入展示辅助
      └─ window-chrome.ts  # 窗口控制覆盖层辅助

```

## `domain`

`domain` 是纯领域层，零平台依赖、零 I/O。它不依赖 `core`、`features`、`facade`、`shared`、Electron 或 UI 框架。

- `types.ts`：仓库标识、仓库摘要、仓库详情、栏目状态、失败状态、快照、趋势、分页和刷新批次等领域类型。
- `ports.ts`：GitHub Token 校验、仓库摘要、仓库详情、Token 存储、清单存储、详情存储、快照存储、时钟、事务和日志等端口。
- `rules/repository-identity.ts`：规范化 GitHub URL 与 `owner/repo`。
- `rules/repository-eligibility.ts`：判断仓库是否公开、是否重复、清单是否已达 50 个上限。
- `rules/refresh-window.ts`：判断普通回访是否落在 60 秒窗口内，以及全部刷新是否强制执行。
- `rules/activity-sort.ts`：使用代码活动时间与协作活动时间中较新的时间排序。
- `rules/detail-cache-policy.ts`：判断无缓存、实质变化、仅摘要变化和强制完整抓取。
- `rules/column-state.ts`：将规范化响应归类为成功、无内容、无权访问、抓取失败或首版暂不支持。
- `rules/failure-state.ts`：根据是否存在旧资料决定保留旧资料或显示空状态。
- `rules/snapshot-retention.ts`：实现同仓库同日只保留最后一档、保留最近 30 个自然日。

## `shared`

- `types.ts`：跨进程请求、响应、展示结果和 `BluebirdCourierBridge` 类型。这里可以携带 GitHub 平台字段。
- `ipc.ts`：IPC 通道常量。通道按用例命名，例如 `token.verify`、`repository.refreshAll`、`detail.history` 和 `snapshot.trend`。

## `main/core/infra`

基础设施只提供可替换技术能力，不包含 GitHub 业务判断，也不拥有任何 feature 的流程。

- `database.ts`：创建、关闭本地数据库并提供通用查询能力。
- `migrations.ts`：创建和升级本地表结构。
- `transaction.ts`：提供事务开始、提交和回滚。
- `encryption.ts`：加密和解密本地 Token。
- `clock.ts`：提供当前时间。
- `logger.ts`：记录请求、失败、限流和刷新批次日志。
- `operation-lock.ts`：提供按批次或仓库维度的并发锁。

具体的清单、详情、Token 和快照查询由各 feature 的 implementation 负责，因为 feature 拥有自己的数据访问和事务边界；这些 store 通过注入的 `core/infra` 能力访问本地资料库。本地资料库是唯一持久化出口，feature 不直接依赖具体数据库技术。

## `main/core/adapters`

- `github-http-client.ts`：封装 GitHub HTTPS 请求、超时、分页和认证头。
- `github-error-mapper.ts`：把网络、HTTP、Token 无效和限流响应转换成统一的领域错误。
- `github-token-adapter.ts`：实现 Token 校验端口。
- `github-repository-adapter.ts`：实现仓库公开性、仓库状态和轻量摘要获取。
- `github-detail-adapter.ts`：实现元数据、Release、Tag、Commit、Issue、PR、构建、README 和目录结构获取。
- `shell-links.ts`：校验 GitHub 外链目标并调用平台外链能力；这是 `core/adapters` 的平台外链适配器，不参与 GitHub REST 请求和业务流程编排。

适配器只做协议判断和响应形状转换，不决定缓存复用、旧资料保留或批次是否停止。

## `main/features/repository-list`

这个 feature 负责添加仓库、最多 50 个仓库、轻量刷新、清单排序、删除和仓库外部状态保留。

### `contract`

- `types.ts`：清单输入、输出、刷新结果、失败来源和仓库状态类型。
- `service.ts`：定义添加、查询、刷新、重试和删除接口。
- `index.ts`：只导出契约面。

### `implementation`

- `create.ts`：创建 feature 实例，是实现面的唯一创建入口。
- `service.ts`：实现契约并组织内部用例。
- `repository-list-store.ts`：保存和读取清单、摘要、活动时间、失败状态和仓库状态。
- `add-repository.ts`：校验仓库、创建“获取中”卡片并执行首次轻量抓取。
- `list-repositories.ts`：读取、搜索和按活动时间排序清单。
- `refresh-batch.ts`：实现启动刷新、全部刷新、60 秒窗口、批次游标和批次锁。
- `retry-repository.ts`：根据失败来源重试新增仓库或已有清单仓库。
- `delete-repository.ts`：删除仓库清单记录，并返回由 `facade` 编排详情资料与快照清理所需的结果。
- `repository-status.ts`：保留归档、删除、改名等 GitHub 状态并反馈给界面。

普通网络错误记录后继续批次；Token 无效或限流时停止后续请求。

## `main/features/repository-detail`

这个 feature 负责详情缓存判定、完整抓取、栏目状态聚合和历史分页。

- `contract/types.ts`：详情查询、详情结果、栏目状态和分页结果。
- `contract/service.ts`：定义打开详情、强制刷新和加载历史内容的接口。
- `contract/index.ts`：只导出契约面。
- `implementation/create.ts`：创建详情 feature。
- `implementation/service.ts`：组织打开、刷新和分页流程。
- `implementation/detail-store.ts`：保存详情缓存、栏目状态、错误信息和上次完整抓取时间。
- `implementation/open-detail.ts`：读取缓存并选择完整抓取或复用。
- `implementation/refresh-detail.ts`：执行用户明确要求的强制完整抓取。
- `implementation/column-loader.ts`：按栏目队列请求 GitHub 详情。
- `implementation/column-aggregator.ts`：聚合成功、无内容、无权、失败和暂不支持状态。
- `implementation/history-pagination.ts`：处理 Commit、Issue、PR 的继续加载。

部分栏目失败时保留旧资料；全部栏目都没有可展示内容时返回完整抓取失败。

## `main/features/token-settings`

这个 feature 负责首次 Token、验证、更换和二次确认；清空其他 feature 的本地资料由 `facade` 编排。

- `contract/types.ts`：Token 输入、验证结果、更换确认和取消结果。
- `contract/service.ts`：定义验证、开始更换、确认更换和取消更换接口。
- `contract/index.ts`：只导出契约面。
- `implementation/create.ts`：创建 Token feature。
- `implementation/service.ts`：组织 Token 设置流程。
- `implementation/token-store.ts`：读写加密 Token 和 Token 状态。
- `implementation/verify-token.ts`：调用 Token 校验端口，成功后保存 Token。
- `implementation/replace-token.ts`：维护二次确认和更换状态；不直接访问其他 feature 的存储，验证新 Token 成功后保存新 Token。

## `main/features/snapshot-trend`

这个 feature 负责每天最后一档快照、30 日保留和 Star/Fork 趋势。

- `contract/types.ts`：快照写入、趋势查询和趋势点类型。
- `contract/service.ts`：定义写入快照、执行保留策略和读取趋势接口。
- `contract/index.ts`：只导出契约面。
- `implementation/create.ts`：创建快照 feature。
- `implementation/service.ts`：组织写入、清理和查询流程。
- `implementation/snapshot-store.ts`：读写快照。
- `implementation/record-snapshot.ts`：写入同仓库当天最后一档。
- `implementation/retention-runner.ts`：清理超过 30 个自然日的快照。
- `implementation/trend-query.ts`：读取 Star/Fork 趋势，不补造缺失日期。

清单和详情feature不直接import快照feature。真实观察成功后由facade调用快照契约登记身份、持久顺序和意图；清单批次只提交此前已登记的观察，登记失败明确报告，不能晚到时补造顺序。缓存复用和本地读取不采样。删除仓库时，facade依次编排清单、详情和快照清理。更换Token先验证，再于token-settings事务原子保存密文、推进上下文并登记清理义务；随后facade编排清理，失败或重启继续恢复，完成清理不会再次推进上下文。

趋势按注入时钟保留30个本地自然日，同日观察以真实时间和持久序号仲裁。只读趋势窗口与持久内容版本分别表达；跨自然日游标绑定窗口身份，状态读取与页面重读同样校验，不通过伪造数据库版本处理时间变化。

## `main/facade`

- `facade.ts`：提供应用用例入口，编排仓库清单、仓库详情、Token 设置和快照趋势四个契约；负责删除仓库和更换 Token 时的跨 feature 资料清理，以及成功抓取后的快照写入。
- `result-mappers.ts`：把 feature 结果和领域结果转换成 `shared/types.ts` 的跨进程结果。

`facade` 不依赖 feature implementation，不创建基础设施，不访问数据库，不实现纯业务规则；它只调用已创建的 feature contract，并通过契约或注入的 domain port 完成跨 feature 协作。

## 进程边界

- `main/index.ts`：唯一组合根。创建基础设施、GitHub adapters、feature implementation、facade，并完成依赖注入。每个 feature 的 `implementation/create.ts` 必须由这里通过静态 named import 或 default import 获取可调用创建入口，并直接以函数调用表达式调用；其他文件不得创建 feature 实例。
- `main/ipc.ts`：只注册通道、转发参数、返回 facade 结果。
- `preload/index.ts`：只通过 `contextBridge` 暴露受限的 `window.bluebirdCourier`。
- `renderer/index.html` 与 `renderer/lib/main.tsx`：渲染进程入口页面与挂载。
- `renderer/pages/App.tsx`：页面路由和界面级状态。

`renderer` 通过 preload 桥接访问主进程，只依赖 `shared` 和允许的展示库。它不 import `main`、`domain`、Electron 主进程模块或 Node 后端模块。

## `renderer`

- `pages/App.tsx`：页面路由、导航方向与界面级状态（无 Router，视图状态内聚）。
- `pages/WatchlistPage.tsx`：清单、搜索、刷新、排序、新增与删除交互。
- `pages/DetailPage.tsx`：详情栏目、缓存提示、Tab 切换与滚动协调。
- `pages/SettingsPage.tsx`：Token配置、二次确认、已提交但待清理的恢复入口与主题设置区。
- `components/detail/`：详情表头（桌面 / 单栏）、Tab、概览与各栏目组件（含趋势）。
- `components/watchlist/`：清单行、侧栏行、新增表单、操作浮层与 Motion 包装。
- `components/shell/`：桌面 / 单栏外壳、页面宿主与侧栏头部。
- `components/*.tsx`：通用组件（加载、空态、错误条、主题选择器、过渡等）。
- `lib/main.tsx`：渲染进程挂载入口。
- `lib/api.ts`：读取 `window.bluebirdCourier` 的唯一数据入口。
- `lib/theme.tsx`：主题 Provider 与偏好保存。
- `lib/format.ts`、`lib/time.ts`：时间、数量、状态格式化与相对时间。
- `lib/errors.ts`：错误展示文案映射。
- `lib/app-layout.ts`、`lib/app-scroll-root.ts`：布局模式判定与滚动归属解析。
- `lib/detail-reveal.ts`、`lib/motion.ts`：详情揭示状态与动画预算常量。
- `lib/overlay-placement.ts`、`lib/repo-input.ts`、`lib/release.ts`：浮层定位、输入与发版展示辅助。
- `lib/trend.ts`、`lib/chart-theme.ts`：趋势数据映射与图表主题。
- `lib/external-link.ts`、`lib/window-chrome.ts`：外链调用与窗口控制覆盖层辅助。
- `styles/`、`styles.css`、`assets/`：分域样式、样式总入口与品牌资源。

## 实现顺序

1. 先定义 `domain/types.ts`、`domain/ports.ts` 和纯规则。
2. 定义 `shared/types.ts` 与 `shared/ipc.ts`。
3. 实现 `core/infra` 和 `core/adapters`。
4. 按 `repository-list`、`repository-detail`、`token-settings`、`snapshot-trend` 建立 contract 和 implementation。
5. 实现 `facade`，由它完成跨 feature 编排和结果组装。
6. 在 `main/index.ts` 创建实例并注入端口，再接入 IPC、preload 和 renderer。
完成条件是：每个新文件落在本文规定的层和 feature 内；feature 只通过自身 contract 对外；组合根是唯一实例创建入口；跨层依赖符合 `skeleton.md`。
