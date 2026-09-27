# 代码骨架

OCTO 的分层骨架:各层职责、目标目录、结构调整的执行顺序。新代码按**职责分工**归位;模块搬迁按**落地顺序**执行。本文只定义 `src/` 与 `tests/` 的骨架。

## 职责速览

1. domain:业务规则、类型、端口
2. core:基础设施 + adapter
3. features:业务能力
4. facade:跨能力编排
5. shared:通信契约
6. renderer:展示

## 职责分工

| 层 | 负责 | 不负责 | 关键产物 |
|---|---|---|---|
| **domain** | 业务内核:领域类型、业务规则、端口声明。**唯一业务内核依赖源——自身依赖空集,允许外层按需依赖** | I/O、框架、平台词汇(含字段命名) | `types` / `ports` / 规则纯函数 |
| **features** | 一个业务能力的内部流程、数据访问、**本 feature 流程的事务所有权**、本 feature 的迁移片段;在流程内**应用** domain 规则;外部平台能力经 facade 装配或 domain port 注入获得 | 定义领域规则、静态调用其他 feature、依赖具体平台 adapter | 流程 `*.ts` + `schema.ts` |
| **facade** | 跨能力编排、能力注入接线、契约结果组装 | 领域规则、持久化机制;**不接触 db 与基础设施模块**(基础能力由组合根绑定进 feature 能力) | `createFacade(...)`——接收装配好的能力;用例门面 `OctoFacade`,方法数量以契约为准 |
| **core/infra** | 基础设施件:db 连接与 pragma、**总迁移器**、加密盒、时钟、日志。准入:无业务含义、多处复用、稳定生命周期、可替换 | 业务含义 | 可替换实现 |
| **core/adapters** | 平台协议转换:允许平台协议转换判断(端点、请求头、404→`null`、原始值携带、超时),实现 domain 端口 | 定义领域规则(归一等业务判断一律调 domain 的函数) | `GitHubPort` 的适配器 |
| **shared** | 跨进程契约:门面结果类型、IPC 通道常量(数量以契约为准)、偏好键、外链契约;**转出** domain 类型;契约扩展(`BuildView` 等) | 行为 | `types` / `ipc` / `settings-keys` |
| **preload** | `window.octo` 白名单暴露,以 `OctoBridge` 为限 | 通用能力(shell / ipcRenderer / 任意通道) | 桥接 |
| **renderer** | 展示:页面、组件、文案映射、格式化、图表配置;仅无业务含义的展示纯函数 | 业务判断(判断结果经契约携带) | `pages/` `components/` `lib/` |
| **shell-links** | 门面外唯一受控旁路:目标 → URL 构造/校验 → `shell.openExternal` | **三禁**:访问数据库、调用 feature、调用 GitHub | `openGitHubExternal` |
| **index(组合根)** | 装配:core → **基础能力绑定进 feature 能力** → 汇总迁移片段 → facade → ipc → theme → window | 业务逻辑 | 唯一组装点,唯一可全依赖 |

跨能力协作的两种形态:

- **能力注入**(写协作,如 `SnapshotRecorder`,接口在 domain、facade 接线):**事务所有权归发起流程的 feature;被注入能力只提供参与当前事务的原子操作。**
- **facade 组装**(读协作,如 `Detail` = fetching 五类值 + snapshots 趋势摘要)。

## 目录骨架

```
src/
├─ domain/                        业务内核。零依赖、零 I/O、零平台词汇
│  ├─ types.ts                    Glance(lastActivityAt / openIssueCount) / Detail /
│  │                              ReleaseItem(kind) / CommitItem / IssueItem / PullRequestItem /
│  │                              BuildInfo{status, name, finishedAt, sourceUrl} / BuildStatus /
│  │                              Snapshot / TrendView / ErrorKind / NormalizedError
│  ├─ ports.ts                    GitHubPort + SnapshotRecorder(唯一 feature 间能力端口)
│  ├─ repo-input.ts               输入归一:owner/name 解析、大小写不敏感
│  ├─ errors.ts                   错误五类归一(含限流反应式判定)
│  ├─ release.ts                  发版 tag 分类(只标 alpha/beta/rc)
│  ├─ trend.ts                    趋势计算:范围摘要、变化量、记录天数、state 判定
│  ├─ build.ts                    构建结论归一(→ BuildStatus)
│  ├─ snapshot-day.ts             日档去重键(本地日期)
│  └─ theme.ts                    主题偏好归一(非法值回退 system)、effective 判定
│
├─ shared/                        跨进程契约(可引用并转出 domain 类型)
│  ├─ types.ts                    OctoFacade + 用例结果类型(AccessTokenResult / AddRepositoryResult /
│  │                              RefreshGlanceResult / DetailResult / SettingsView)+
│  │                              BuildView = BuildInfo & { rawStatus }(平台原文,适配器携带)+
│  │                              外链契约(GitHubExternalTarget / OpenExternalResult /
│  │                              ExternalLinkBridge / OctoBridge)
│  ├─ ipc.ts                      IPC 通道常量(数量以契约为准)
│  └─ settings-keys.ts            偏好键常量(pref:theme 等)
│
├─ main/
│  ├─ index.ts                    组合根:装配 core → 绑定基础能力到 features → 汇总迁移片段 → facade → ipc → theme → window
│  ├─ ipc.ts                      通道注册(纯接线)
│  ├─ theme.ts                    主题偏好 → nativeTheme.themeSource
│  ├─ shell-links.ts              受控旁路(三禁;import 白名单受测试锁定)
│  │
│  ├─ core/
│  │  ├─ infra/                   基础设施件(无业务含义、多处复用、稳定生命周期、可替换)
│  │  │  ├─ db/database.ts        连接、WAL、busy_timeout(不含表结构)
│  │  │  ├─ db/migrator.ts        总迁移器:版本表、顺序应用、失败回滚
│  │  │  ├─ cipher/cipher-box.ts  safeStorage 加密盒
│  │  │  ├─ clock.ts              时钟
│  │  │  └─ logging/logger.ts     文件日志
│  │  └─ adapters/                平台协议转换:允许协议层判断;领域规则由 domain 定义、此处调用
│  │     └─ github/http-github.ts 实现 domain 的 GitHubPort;端点、404→null、rawStatus 携带
│  │
│  ├─ features/                   用例切片:内部流程 + 数据访问 + 事务所有权;无静态互引
│  │  ├─ watchlist/               watchlist.ts(增删查、重复拒绝)+ schema.ts
│  │  ├─ fetching/                fetching.ts(抓取编排 + glance 落库事务;注入 SnapshotRecorder)+ schema.ts
│  │  ├─ snapshots/               snapshots.ts(记档/读档,以原子操作参与调用方事务;实现 SnapshotRecorder;
│  │  │                           套用 domain 趋势规则)+ schema.ts
│  │  └─ settings/                settings.ts(偏好与令牌密文读写)+ schema.ts
│  │
│  └─ facade/                     facade.ts:跨能力编排、注入接线、契约组装(零规则、零基础设施)
│
├─ preload/                       contextBridge 暴露 window.octo(以 OctoBridge 为限)
└─ renderer/                      只依赖 shared + 展示库(react / chart.js)
   ├─ pages/                      WatchlistPage / DetailPage / SettingsPage
   ├─ components/                 通用件 + watchlist/ + detail/(ExternalLinkButton 唯一外链控件)
   └─ lib/                        api / external-link / errors(文案) / time(展示) /
                                  format / chart-theme / theme(context)
                                  —— 仅无业务含义的展示纯函数

tests/                            测试骨架与 seam 一一对应
├─ architecture/                  依赖方向骨架测试(import 白名单)
├─ domain/                        纯规则直测,零 fake
├─ facade/                        门面集成(接口即测试面)
├─ db/ core/                      适配器窄缝直测(总迁移器、http 请求层)
├─ main/ preload/ renderer/       外链守卫 / 沙箱产物 / DOM 交互
└─ manual-acceptance/             人工验收
```

依赖方向:`domain ← shared ← preload`;`domain ← core ← features ← facade ← ipc/index`;`renderer → shared`。**domain 是唯一业务内核依赖源,自身依赖空集;允许外层按需依赖。**

import 白名单(`tests/architecture/` 逐条断言):

```
domain        → (空)
core/infra    → 技术依赖
core/adapters → domain(仅实现端口)+ 技术依赖
features      → domain + core/infra
facade        → features + domain
preload       → shared
renderer      → shared + 展示库(react / chart.js)
shell-links   → shared/types + electron + node
index(组合根)  → 全部(唯一组装点)
```

外部平台能力进入 features 只有两条通道:**facade 装配**、**domain port 注入**;features 的 import 止于 `core/infra`,facade 全程不接触 db。

## 落地顺序(实现时遵从)

每步**行为不变**;`npm run typecheck` 与 `npm test` 通过才算一步完成,`tests/facade/` 全程绿色是回归基线。

1. **建立 domain** —— 建 `src/domain/` 空层,立边界。完成判据:**行为不变**——`npm run typecheck` 与 `npm test` 的结果与迁移前一致。
2. **搬迁类型** —— `shared/types.ts` 的领域类型移入 `domain/types.ts`;`BuildInfo` 按平台中立命名重塑为 `{status, name, finishedAt, sourceUrl}`,平台原文进 `shared` 的 `BuildView.rawStatus`;字段改名 `pushedAt → lastActivityAt`、`openIssues → openIssueCount`。完成判据:`shared/types.ts` 只剩契约与 domain 转出,测试全绿。
3. **搬迁端口** —— `GitHubPort` 进 `domain/ports.ts`;声明 `SnapshotRecorder`(唯一 feature 间能力端口)。完成判据:core/adapters 经 domain 端口实现,测试全绿。
4. **搬迁 adapter** —— `core/github/http-github.ts` → `core/adapters/github/`;`core/infra/` 分区;总迁移器 `core/infra/db/migrator.ts` 就位。完成判据:`tests/db/` 与 `tests/core/` 随路径就绪,测试全绿。
5. **拆 feature** —— 各 feature 落 `schema.ts` 迁移片段;snapshots 独立并实现 `SnapshotRecorder`;fetching 去掉对 snapshots 的静态依赖、改注入接线;feature 能力工厂化,基础能力由组合根绑定、facade 收装配好的能力;domain 规则归位(repo-input / errors / release / trend / build / snapshot-day / theme)。完成判据:features 间零 import,features 与 facade 均不 import 平台 adapter 与 db 模块,`tests/facade/` 全绿。
6. **增加 architecture tests** —— `tests/architecture/` 断言 import 白名单与 shell-links 三禁。完成判据:每条白名单有断言,且对每条断言故意违反一次能红。
