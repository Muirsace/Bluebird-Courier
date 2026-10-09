# 青鸟信使 Bluebird Courier

产品中文名为 **青鸟信使**，英文名为 **Bluebird Courier**。

> 本地优先的 GitHub 仓库监控桌面应用：把关注的仓库放进监控清单，一眼看出"有没有新东西"，并让指标趋势随使用自然积累。

数据全部留在本机，打开即用、关闭即停，不留后台进程。Windows 先行（Electron）。

- **要构建、改代码或发版** → [开发](#-开发)

---

# 🗒 目录

- [📖 这是什么](#-这是什么)
- [📦 安装](#-安装)
- [🔑 首次启动：配置访问令牌](#-首次启动配置访问令牌)
- [📋 日常使用](#-日常使用)
- [💥 出错时会怎样](#-出错时会怎样)
- [🔒 数据与隐私](#-数据与隐私)
- [🖥 窗口与后台行为](#-窗口与后台行为)

**开发**

- [🔧 技术栈](#-技术栈)
- [🏗 架构](#-架构)
- [📌 前置要求](#-前置要求)
- [🏁 快速开始](#-快速开始)
- [🐛 Windows 启动故障排查](#-windows-启动故障排查)
- [🌐 抓取与 GitHub API](#-抓取与-github-api)
- [🗂 项目结构](#-项目结构)
- [🔬 测试](#-测试)
- [💾 打包](#-打包)
- [📚 领域词汇](#-领域词汇)
- [📑 文档与工具](#-文档与工具)
- [🗺 路线图与非目标](#-路线图与非目标)

---

# 📖 这是什么

用户关注着一批 GitHub 开源仓库，想知道它们出了新版本没有、最近在改什么、议题多不多、构建还健康吗。现状只能挨个打开 GitHub 人肉翻，既看不出"哪几个仓库有更新"，也回看不到指标随时间的变化。

本项目把这件事收进一个桌面 App：**监控清单 → 轻量信息 → 全量信息 → 按日历史快照 → 趋势**。

# 📦 安装

⚠️ **目前还没有正式发布的安装包**（仓库里 `release/` 尚未生成），所以现阶段只有一条实际路径：自己构建。构建需要先按 [开发](#-开发) 把环境装好，然后：

```bash
npm install
npm run dist
```

产物是 Windows 安装器，位于 `release/`。特点：**非一键安装**（会走安装向导）、**可自选安装目录**。安装后双击启动即可——Electron 运行时已打包进安装器，**不需要另装 Node.js**。

# 🔑 首次启动：配置访问令牌

**访问令牌（PAT）用于GitHub网络检查和同步**。首次没有本地资料时进入设置页；已有清单、详情和趋势时，无令牌也可离线查看。

1. 到 [GitHub Settings → Tokens](https://github.com/settings/tokens) 生成一个个人访问令牌（读取公开仓库数据即可）。
2. 粘贴进设置页的输入框，点「保存并验证」。
3. 保存前会调用 `GET /user` 验证，**验证通过才落库**；失败会给出明确提示。

令牌用操作系统钥匙串（Electron `safeStorage`）加密后存本机，明文不落库、不写日志。设置页的「显示 / 隐藏」只作用于你当前输入的值——**已保存的令牌不会回显**，主进程不提供取回明文的通道。

更换已有令牌须二次确认。新令牌验证成功后，与访问上下文和清理意图一起提交，再清理旧资料；失败或取消保留原资料。若令牌已经生效但清理失败，设置页提供「重试清理」，无需重新输入令牌，重启也会恢复清理。

# 🎨 外观与主题

设置页的「外观」分组里可以三选一：

| 选项 | 行为 |
|---|---|
| **跟随系统**（默认） | Windows 切换深色 / 浅色时青鸟信使立即跟随，无需重启 |
| 浅色 | 强制浅色，系统切深色也不影响 |
| 深色 | 强制深色，系统切浅色也不影响 |

- 选择**即时生效、即时保存**，没有额外的「保存主题」按钮；保存失败会就地报错并回滚选择，不会假装已生效。
- 偏好存在本地数据库的 `setting` 表（`pref:theme`），重启后保留。
- 首屏不闪：窗口创建前主进程已把偏好交给 Electron（`nativeTheme.themeSource`），渲染层在 HTML 解析阶段就定好主题。
- 两套主题共用一份语义配色（surface / border / text / accent / 状态色 / 图表色），组件不判断深浅，只写语义；趋势图会随主题立即重绘。

# 📋 日常使用

## 🎯 监控清单（轻量信息）

清单页是应用首页：标题右侧显示**当前监控仓库数量**，下面是「添加仓库」操作组与「全部刷新」。

- 输入 `owner/repo`、GitHub 网址或 `git@github.com:owner/name` 均可加入。**加入前会先真实抓取验证**，不存在或无权访问的仓库不会入列。
- 重复添加会被拒收（大小写不敏感）。
- 每张仓库卡片三层信息：**仓库全名**（第一层级）→ **Stars / 最近活动 / 最新版本**（第二层级，最近 7 天有活动的「最近活动」会高亮）→ **抓取于 …**（第三层级，弱化文字）。
- 点卡片主区域（或键盘 Tab 选中后按 Enter / Space）进入该仓库详情。
- 卡片右上角 `···` 是操作入口，**删除不再常驻在卡片上**：`···` → 从监控清单移除 → 轻量确认框（取消 / Esc / 点外部都能退出，确认时才出现红色按钮）。这只会停止在青鸟信使中监控，不会删除 GitHub 仓库。
- 启动时自动抓取一次；之后用「全部刷新」手动刷新整份清单。
- **刷新不会让已有数据“变灰”**：卡片照常可读，只有刷新按钮转圈、卡片抓取时间后显示「· 正在更新…」。刷新失败时旧列表继续显示，只多一条错误条。
- **清单数据在 60 秒内视为新鲜**：窗口切回前台、在清单与详情之间来回切换都**不会**自动重抓；超过 60 秒后重进清单只会后台重读一次本地库（不消耗配额）。需要新数据时点「全部刷新」。

## 📊 全量信息（五类更新）

**顶级入口只有两个：监控清单、设置**；仓库详情是监控清单的下一层——点开清单里任意一行进入，页头用「← 返回监控清单」退回。

详情页第一屏是仓库表头：仓库名、摘要检查时间、完整详情同步时间、重新抓取按钮，以及四条核心指标（Stars / Forks / 最近活动 / 最新版本）。未知时间显示未检查或未完整同步。表头之下是六个二级 Tab，默认停在**概览**：

| Tab | 展示内容 |
|---|---|
| 概览 | 构建状态（高权重）、最近 5 条发版、最近 5 条提交、Issue / PR 摘要（都为空时只给一行紧凑提示）、趋势摘要（紧凑 sparkline） |
| 🏷 发版 | 本地已保存的发版列表，按页读取：标签（可点开GitHub发版页）→ 类型徽章 → 发布日期，标题只在它不等于标签时另起一行 |
| 📝 提交 | 本地已保存的提交列表，按页读取：消息在前（超长一行截断，悬停看全文），作者 · 相对时间 · SHA次之，SHA等宽弱色且可点开 |
| 💬 Issue & PR | 顶部计数摘要 + 分为「议题」「合并请求」两个子区；每行以文字徽章 `Issue` / `PR` 标明类型，状态（开启 / 已关闭）同样是文字，`#编号` 可点开对应页面；有正文时在元信息下方显示正文摘要 |
| 🏗 构建 | 最近一次构建：状态徽章（构建通过 / 构建失败 / 构建中 / 无结论 / 无构建）、工作流名、完成时间、原始结论，有 Actions 地址时给「在 GitHub 查看 ↗」 |
| 📈 趋势 | Stars与Forks两张**各自独立Y轴**的图 + 时间范围7D / 30D |

概览与各Tab使用本地保存的范围数据；切Tab和本地翻页不产生GitHub请求。首屏缺省每范围30条，单次读取最多200条，更多内容通过版本游标续读。

**打开先展示本地缓存，再按需后台同步**。每次导航都表达打开意图，由主进程根据已保存的变化和范围状态决定复用、验证或同步；Stars/Forks变化只更新摘要。左侧「检查更新」不会全量下载所有未查看仓库；「重新抓取」是独立强制命令。后台任务期间只轮询轻量本地状态，收到新版本才读取当前范围，失败保留可展示的旧内容。非活动展示缓存约60秒后回收，再次进入先读取磁盘缓存；焦点或重连不会自行发起GitHub全量抓取。

## 🏷 发版类型与提交层级

- **只标 alpha / beta / rc**：tag 里明确写着 `rc` / `rc1` / `beta` / `beta2` / `alpha` 这类词时，才显示 `RC`（蓝）/ `Beta`、`Alpha`（黄）徽章。
- **不标 Stable**：本应用只保存 tag、标题、发布日期，没有 GitHub 的 prerelease / draft 字段。普通版本号不代表稳定，nightly / canary / snapshot / dev 更不能当成正式版——所以**一律不显示** Stable，宁可不标也不标错。
- **提交**：消息是第一视觉层，超长消息一行截断（悬停显示完整内容），作者与相对时间次之，7 位 SHA 等宽弱色放行末（点它打开 GitHub 上的该次提交）。
- **Issue / PR**：类型（Issue / PR）与状态（开启 / 已关闭）都用文字表达，不靠颜色区分；`#编号` 是外链入口；正文保留换行显示，过长内容截断并可悬停查看全文。
- **日期表达只有两种**：会变动的时间（最近活动、提交时间、构建完成时间）用相对时间（`2 天前`）；固定发生过一次的时间（发版日期）用绝对短日期（`2026-09-24`）。趋势横轴用 `MM-DD`。同一个列表里不混用。

## 📈 历史快照与趋势

- **只有真实网络观察成功才记档**；同仓库同自然日采用最后一档真实事实。相同内容不伪造新的采样时间或展示版本，本地缓存读取不采样。
- 没有的值（比如无发版）记空；抓取失败不记档。
- **趋势拆成两张图**：Stars 与 Forks 数量级差很多，共用一套刻度会让 Forks 贴在底部，所以各画一张、各用各的纵轴，纵轴按各自数据范围自适应。
- 每张图上方给**当前值**与**变化量**（`+142` / `-12` / `0`），变化量后面是记录范围：窗口被真实数据填满才写「过去 7 天」，否则只承认实际记录到的天数（「已记录 2 天」）。
- **至少要有 2 个点才出图**：0 条显示「暂无趋势数据…」，1 条显示「已有首次记录…」，都**不会**显示 `+0`（那会让人以为整个时间范围都有数据）。
- 当前保留30个本地自然日（含今天），7D / 30D是**纯本地过滤**，不产生GitHub请求；90D扩展尚未交付。采样写入失败时保留真实意图，重启有界补偿，旧上下文、过期或损坏意图不回填。

## 🔗 在 GitHub 打开（受控外链）

应用里的 GitHub 实体都能一键跳到对应的原始页面。**渲染层永远拿不到"打开任意链接"的能力**，也永远不会让青鸟信使窗口自己导航过去。

| 入口 | 打开的目标 |
|---|---|
| 清单里的 `···` 菜单 → 在 GitHub 打开 | `https://github.com/{owner}/{name}` |
| 详情页表头 → 在 GitHub 打开 ↗ | 同上 |
| 发版行的 Tag | `…/releases/tag/{tag}`（tag 整体 encode，`release/v1.0` 不会变成两层路径） |
| 提交行的 7 位 SHA | `…/commit/{sha}`（传完整 SHA） |
| 议题 / 合并请求行的 `#编号` | `…/issues/{n}` 与 `…/pull/{n}` |
| 构建 Tab 的「在 GitHub 查看 ↗」 | `…/{owner}/{name}/actions/runs/{id}`（接口给出地址；主进程校验它属于当前仓库和单次 run） |

**安全边界**：渲染层只说"要打开哪个实体"，URL 由主进程拼。Build 是唯一携带接口 `html_url` 的目标，但同时带上当前仓库身份；主进程只从严格匹配的 Actions run 路径中提取 run id，再构造规范 URL。

```
渲染层外链控件 → getApi().openGitHubExternal(target)     ← Build 额外带 owner/name + API html_url，其余目标只带实体字段
   → preload 唯一窄口（contextBridge 只有这一个方法，没有 shell / openExternal / 任意通道）
   → IPC octo:openGitHubExternal
   → 主进程 shell-links：构造 URL + 再次校验（最终信任边界）
   → shell.openExternal(url)                              ← 系统默认浏览器
```

- **只放行 `https:` + host 恰为 `github.com`**：`http:`、`file:`、`data:`、`javascript:`、自定义协议、其他域名、`github.com.evil.example` 这类前缀伪装、非默认端口、URL 内嵌凭据一律拒绝。
- **Build 只允许当前仓库的 Actions run**：路径必须是 `/{owner}/{name}/actions/runs/{positive-id}`，owner/name 与当前仓库匹配；`/settings`、`/issues/1`、Actions 根路径、额外路径、query 与 fragment 都拒绝。
- **owner / name 逐段校验字符集**（`[A-Za-z0-9._-]`，且不许是 `.` / `..`），所以拼不出 `../` 之类的路径逃逸；SHA 只认十六进制，编号只认正整数。
- **非法目标连 `shell` 都不碰**：主进程直接返回 `invalid_target`。打开失败返回 `open_failed`，界面**就地报错**（清单菜单保持展开、详情页在按钮旁给提示），不假装成功。
- **外链不产生任何抓取**：点任何一个入口都不会增加 GitHub 请求。
- **没有任何额外权限**：没有 `webview`、没有 `window.open` 转发、没有外部协议注册；`openExternal` 只在 `src/main/core/adapters/shell-links.ts` 这一处被调用。

# 💥 出错时会怎样

应用**不会因为抓取失败清空界面**，一律是「保留上次数据 + 顶部错误条」。错误被归成五类：

| 情况 | 你会看到 |
|---|---|
| 🔑 令牌失效 | 提示更换令牌，并给出「去设置」按钮 |
| ⏳ 被限流 | 提示等待恢复，并显示预计恢复时间 |
| 🚫 仓库不存在 / 无权访问 | 明确提示，且不会把坏条目留在清单里 |
| 📡 网络失败 / 请求超时 | 提示检查网络后重试 |
| ❓ 其他 | 通用失败提示 |

另外，令牌失效或限流会**中止整批抓取**，不会对后面每个仓库重复报同一个错；其他仓库的失败则逐条标注仓库名。

应用**启动失败**（如数据库文件损坏、数据目录不可写）会弹出系统错误框并指明日志目录，不会静默退出。

# 🔒 数据与隐私

- 所有数据只在本机，**不上传任何服务器**；断网也能翻看已有内容。
- 数据库：`<userData>/octo.db`（Windows 下的应用数据目录为 `%APPDATA%\Bluebird-Courier`；SQLite）。
- 日志：`<userData>/logs/octo.log`（追加写入，写日志失败被静默吞掉，不影响业务）。
- 访问令牌：存数据库 `setting` 表的 `access_token` 键，值为加密密文（`ss:` 前缀 + base64）。若系统安全存储不可用，**保存会直接失败并报明原因，绝不降级为明文**。
- 各人各自安装、各用自己的令牌与清单，互不干扰。

# 🖥 窗口与后台行为

- 普通窗口，**无托盘、无开机自启**。
- 关闭即停，**不留后台进程**。
- **同时只跑一个实例**：重复启动不会开出第二个窗口，而是把已有窗口切到前台——避免两个进程写同一个本地数据库。
- **没有后台定时任务**：快照的"每天一档"由你触发的抓取产生，不会在后台悄悄跑。

---

# 🔧 开发

## 🎛 技术栈

| 层 | 选型 |
|---|---|
| 🖥 桌面壳 | Electron 44（主进程 CJS + preload 沙箱 + contextIsolation） |
| ⚙ 主进程 | TypeScript、better-sqlite3（本地 SQLite） |
| 🎨 渲染进程 | React 18、Vite 8、Tailwind CSS 3（语义 Design Token + 双主题）、TanStack Query v5、Chart.js 4 |
| 🔬 测试 | Vitest 5（主进程 node 环境 + 渲染层 happy-dom） |
| 📦 打包 | electron-builder → Windows NSIS（x64） |

## 🏗 架构

**主进程三层 + 唯一门面**，渲染进程只做 UI，全部数据经 preload 白名单 IPC 进出：

```
渲染进程 (React)
   │  window.bluebirdCourier.*  ← 12 个白名单 IPC 通道 (octo:xxx)：11 个用例门面 + 1 个受控外链
preload (contextBridge)
   │
facade  ← 用例边界，渲染层唯一入口；错误在此归一
   │
features  ← 用例片段 + 全部 SQL：watchlist / fetching / snapshots / settings / repo-input
   │
core      ← infra 基础设施 + adapters 平台适配器
```

要点：

- **依赖方向单向**：`core` 不依赖 `features`，`features` 之间不互相引用，`facade` 是唯一用例边界（测试也只测这个边界）。
- **契约在 `src/shared/`**：`types.ts` 定义跨进程契约与 `BluebirdCourierFacade`，`ipc.ts` 定义通道常量；preload 内联通道字面量并用字面量类型锁定，与主进程漂移即编译报错。
- **门面之外只有一条受控旁路**：外链不是用例（不碰数据库、不碰 GitHub），因此不进 `BluebirdCourierFacade`——它在 `src/main/core/adapters/shell-links.ts` 单独实现，`BluebirdCourierBridge = BluebirdCourierFacade & ExternalLinkBridge`，preload 也只多暴露这一个方法。
- **全依赖注入**：`createFacade({ db, github, cipher, clock, logger })`——GitHub 适配器、加密盒、时钟、日志都可替换，这也是测试得以完全离线的原因。
- **无推送**：全部为 `ipcMain.handle` 请求/响应，没有 `webContents.send` 主动推送。主题因此**不新增通道**：主进程把偏好交给 Electron（`nativeTheme.themeSource`），渲染层从已有 `getSettings` 读偏好、用 `prefers-color-scheme` 感知系统变化。
- **时间统一 UTC ISO8601 存储**，展示层转相对时间；`snapshot.day` 用本地日期做去重键。
- **渲染层配色走语义 Token**：`styles.css` 里 `--color-*` 存 RGB 通道（浅色在 `:root`、深色在 `[data-theme='dark']`），`tailwind.config.js` 映射成 `bg-surface` / `text-muted` / `border-default` / `bg-accent-solid` 等语义类。组件不写 `dark:` 前缀、不出现具体色号；图表色（`--chart-*`）由 `resolveChartPalette` 读取后交给 Chart.js。
- **全量数据不落库**：只有轻量展示字段与每日快照持久化。

## 📌 前置要求

- **Node.js 22.12+ 或 24.x**（由 electron 44 的 `>=22.12`、better-sqlite3 13 的 `>=22`、vitest 5 的 `^22.12 || ^24 || >=26` 共同约束）与 npm
- Windows（打包目标为 NSIS x64）；开发启动在 macOS / Linux 上亦可（better-sqlite3 提供各平台预编译二进制）

## 🏁 快速开始

```bash
npm install        # 安装依赖（含 Electron 二进制，首次约 100MB；网络受限时需自备代理）

npm start          # 构建主进程 + 渲染进程，然后启动 Electron
npm run typecheck  # 全量类型检查
npm test           # 构建主进程后跑 Vitest
npm run dist       # 打包 Windows NSIS 安装包到 release/
```

开发时也可单独执行 `npm run build:main` / `npm run build:renderer`。

`dist/` 不入库，而 `package.json` 的 `main` 指向 `dist/main/main/index.js`——所以全新克隆后必须先构建才能 `electron .`（`npm start` 已包含这一步）。依赖装好后没有 `postinstall` 步骤，better-sqlite3 直接用包内自带的预编译二进制，**无需** Visual Studio / node-gyp 工具链。

**提示**：仓库没有配 `dev` 脚本。主进程支持开发模式（读 `process.env.VITE_DEV_SERVER_URL`，Vite dev 端口固定 5173），但没有脚本去拉起它，所以日常开发就是走 `npm start` 的全量构建。

## 🐛 Windows 启动故障排查

**启动即崩、无输出退出（0x80000003）** —— 病因是 Electron 目录的完整性标签被降为 `Low`。确认：

```bash
icacls node_modules\electron\dist        # 显示 Low 即确诊
```

修复：

```bash
icacls node_modules\electron\dist /setintegritylevel "(OI)(CI)Medium" /T /C
```

完成判据：`node_modules\electron\dist\electron.exe --version` 能打印版本号。重装 Electron 或环境重写标签后可能复发，重跑同一条命令即可。Chromium 沙箱保持开启，**不要**用 `--no-sandbox` 绕过。

另外，**agent 执行沙箱内 Electron GUI 起不来**（`app.whenReady()` 不触发、GUI 输出捕获不可靠）属环境限制而非应用故障，启动验证要在普通终端里跑。

## 🌐 抓取与 GitHub API

所有请求打向 `https://api.github.com`，统一带请求头：`Authorization: Bearer <PAT>`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: bluebird-courier`。

| 场景 | 端点 | 调用次数 |
|---|---|---|
| 🔑 令牌校验 | `GET /user` | 1 |
| 🎯 轻量信息 | 仓库元信息、latest release及HEAD/tag/最近协作信号 | 随已检查来源和失败预算变化 |
| 🏷 发版 | `GET /repos/{full_name}/releases`及必要的tag来源 | 按分页预算 |
| 📝 提交 | `GET /repos/{full_name}/commits` | 按分页预算 |
| 💬 议题与合并请求 | `GET /repos/{full_name}/issues`、`/pulls`等对应来源 | 按组合来源和分页预算 |
| 🏗 构建状态 | `GET /repos/{full_name}/actions/runs`与已跟踪运行 | 按窗口和跟踪预算 |
| 📄 README文件清单 | `GET /repos/{full_name}/contents` | 常规抓取保留路径/文件清单，未下载正文、未接页面展示 |
| 📈 星标趋势 | **不调接口** | 0（读本机历史快照） |

要点：

- 请求数取决于目标范围、实际来源、分页、窗口重启和预算，不能固定声明为每仓库4次。清单「检查更新」、打开意图、强制命令和本地状态读取分别计数；本地读取不请求GitHub。
- 常规详情抓取包含概览、发版/标签、提交、Issue/PR、构建和README文件清单；目录树不请求，也不阻止完整同步时间更新。旧目录树资料保留，但不会因其过期、失败或待续读自动重新下载。
- 已检测的源版本必须被实际回包覆盖，代码和README可绑定目标SHA；版本缺失或不匹配会保留待同步状态。稳定发版目标必要时额外检查`latest`，并交付真实取得的发版内容。
- 构建按预算检查近期运行与已知未完成运行，续扫进度在本地保存；工作流名、链接和时间也参与变化比较。只读新鲜度按验证有效期派生，不联网或延长验证时间。
- 仓库元信息明确关闭Issue/PR时跳过该来源并显示“未启用”；功能复开会重新查证。未知能力下的403/404仍作为真实失败，保留已有内容，不冒充空结果。
- `/releases/latest` 的 **404 被吞掉、视为「无发版」**，不算错误。
- **限流不做主动探测**，只在出错时反应式判定：`429`，或 `403` 且 `x-ratelimit-remaining: 0`，或响应带 `retry-after`；恢复时间优先取 `x-ratelimit-reset`（epoch 秒）。
- 清单批量抓取**并发 5**（`GLANCE_CONCURRENCY`）；令牌失效 / 限流会**中止后续波次**且同类错误只上报一次。
- **单次请求 10 秒超时**（`AbortSignal.timeout`），超时按「网络失败」上报，不会让界面无限期停在「抓取中」。
- 网络失败保留资料并提供重试；验证发现变化时可在同次打开中安排有界后继任务。本地观察交接和采样失败有持久恢复进度，历史续读有版本游标。ETag、周期校验、优先级完善和配额设置仍属于后续阶段。
- 构建结论归一：`null` → `none`（无构建）、`conclusion` 未出 → `pending`、`success` → `success`、`failure` / `timed_out` / `action_required` / `startup_failure` → `failure`、其余 → `neutral`。

## 🗂 项目结构

```
src/
├─ domain/                  领域类型、端口与纯规则
│  ├─ types.ts
│  ├─ ports.ts
│  └─ rules/
├─ main/
│  ├─ index.ts            唯一组合根：infra → adapters → features → facade → ipc → window
│  ├─ ipc.ts              白名单通道注册（偏好落库后同步 nativeTheme）
│  ├─ facade/             只编排 feature contract + 错误归一
│  ├─ features/           每个 feature 分 contract / implementation
│  └─ core/
│     ├─ infra/           database / cipher / clock / logger
│     └─ adapters/        GitHub / 外链 / theme 平台适配
├─ preload/index.ts       contextBridge 暴露 window.bluebirdCourier
├─ renderer/              React UI：App + pages/ + components/ + lib/
│  ├─ components/         ExternalLinkButton（唯一的外链控件）
│  └─ lib/                api / errors / time（时间展示）/ format（千分位）/ trend（趋势计算）
│                         / release（tag 分类）/ external-link / chart-theme / theme
└─ shared/                跨进程契约：types.ts + ipc.ts

tests/                    Vitest 测试（facade/ 门面集成、db/、main/ 外链守卫、preload/、renderer/ DOM 交互、helpers/、manual-acceptance/）
docs/adr/                 架构决策记录
docs/agents/              仓库工程约定（domain / issue-tracker / triage-labels）
.agents/                  第三方 Agent 技能集（本机保留，不入库）
.scratch/                 本地 issue tracker 与 v1 spec（本机保留，不入库）
```

## 🔬 测试

```bash
npm test   # = build:main + vitest run
```

**策略：以门面集成测试为主，另有两个适配器的窄缝直测**（`core/infra/database` 的建表与迁移、`core/adapters/github-http-client` 与 GitHub 响应适配器的请求层）、preload 构建产物，以及渲染层的 DOM 交互测试。门面用例只断言返回值与数据库落档，不测内部调用顺序、私有状态与 UI 结构。

| 组件 | 真/假 |
|---|---|
| SQLite | ✅ **真**（`os.tmpdir()` 下的临时文件库，顺带验证建表与迁移） |
| 用例门面 `BluebirdCourierFacade` | ✅ **真**（跨进程契约） |
| GitHub 网络层 | 🎭 假（录制 fixtures，含限流 / 401 / 404 / 网络 / 未知错误） |
| 加密盒、时钟 | 🎭 假（可逆 base64；时钟默认本地正午，保证跨时区稳定）。令牌保存用例另注入**真实加密盒**，覆盖系统安全存储不可用 |

覆盖：数据库建表与升级迁移（含 WAL 与 busy_timeout）、令牌校验保存（含系统安全存储不可用）、清单增删与输入归一、门面入参守卫（错型入参不穿出引擎错误）、轻量抓取、抓取落库的事务原子性、全量五类与构建结论归一、快照日档去重、错误归一与降级、请求超时、主题偏好归一（非法值回退 system）。

另有一个特殊回归测试 `tests/preload/preload-sandbox.test.ts`：直接执行编译产物 `dist/main/preload/index.js`，用沙箱 `require` 白名单（`electron/events/timers/url`）复现 Electron ≥20 的限制，断言通道名与 `src/shared/ipc.ts` 逐字一致，并断言网关里**没有** `openExternal` / `shell` / `execute` / `send` 这类通用能力。

外链守卫单测 `tests/main/shell-links.test.ts` 覆盖每条 URL 构造规则与拒绝矩阵（http / 其他域名 / `javascript:` / `file:` / `data:` / 前缀伪装域名 / 非默认端口 / URL 内嵌凭据 / 路径逃逸 / 非十六进制 SHA / 非法编号 / 未知 kind，以及 Build 的错误仓库、非 Actions run 路径、非法 run id、额外路径、query / fragment），并断言**非法目标绝不调用注入的 `open`**、打开失败如实回报 `open_failed`。

**渲染层交互测试**（`tests/renderer/`，文件头 `@vitest-environment happy-dom`）覆盖四组契约。清单侧：仓库数量、点击卡片进详情、`···` 菜单不会误触进详情、菜单开关与 Esc / 外部点击关闭、移除确认 Popover 的取消与确认、移除失败保留仓库并可重试、刷新期间与刷新失败时缓存列表仍在、读取失败不误显示空态、空态只在真实 0 仓库时出现、互动不额外触发全量抓取。主题与设置侧：默认跟随系统、三档切换与偏好落库、保存失败回滚并报错、非法值回退 system、强制模式不跟随系统变化、系统主题运行时切换即时生效、主题切换不触发任何抓取、图表配色随主题重算、浅色下清单/详情/Popover 照常可用且不含硬编码调色板类、令牌状态与保存/测试连接行为。数据表达侧：趋势的空态 / 积累态 / 两点以上、乱序快照仍按时间计算、变化量与范围文案、7D/30D 本地过滤与90D未交付说明、Stars 与 Forks 各一张图各一条线、发版 tag 分类（rc/alpha/beta 识别与 nightly/canary/snapshot 不误判）、标题与 tag 重复时去重、提交消息截断与 SHA 层级、Issue/PR 计数与文字类型徽章、切 Tab/切范围/切主题都不增加抓取次数。外链侧：菜单两项的顺序与分隔、点菜单外链只调一次窄接口且不进详情、目标是仓库 / 发版 / 提交 / 议题 / 合并请求 / 构建各自的形状、打开失败就地报错（菜单保持展开、详情不打断）且可重试、外链控件都是真 `button`、点击任何入口都不增加 `fetchDetail`。断言对象是 DOM 结构与门面调用计数（`role` / `aria-*` / 可见文案 / `data-theme`）与传给 Chart.js 的配置，不依赖具体色值。

整机行为（Electron 壳、真实 GitHub 网络、窗口尺寸）仍由 [`tests/manual-acceptance/`](tests/manual-acceptance/README.md) 的人工验收矩阵覆盖。

## 💾 打包

```bash
npm run dist   # = build + electron-builder --win nsis
```

配置见 `electron-builder.yml`：

- `appId: com.octo.monitor`（升级身份保持不变），`productName: 青鸟信使`；Windows 可执行文件名为 `青鸟信使.exe`，安装器与快捷方式统一使用“青鸟信使”。
- 固定应用图标（白底圆角方块 + 折纸蓝鸟）来自 `resources/icons/bluebird-app.svg` / `.ico`，运行时 PNG 随主进程资源打包；应用内 mark 位于 `src/renderer/assets/`，保持主题适配（浅色界面用深蓝 mark，深色界面用亮蓝 mark）。
- 开发与安装版本统一使用 `%APPDATA%\Bluebird-Courier` 数据目录，应用不再读取旧产品目录；浏览器状态、数据库和已加密访问令牌都存于新目录。
- 目标：Windows **NSIS x64**，输出到 `release/`
- `oneClick: false` + `allowToChangeInstallationDirectory: true` → 走安装向导、可自选安装目录
- 打包内容包含 `dist/**` + `package.json`，并通过 `extraResources` 放入主进程使用的应用 PNG 图标。

## 📚 领域词汇

全项目（代码、测试、文档、提交信息）统一使用 [`CONTEXT.md`](CONTEXT.md) 的词汇表，不漂移到同义词：

**监控清单（watchlist）** · **监控仓库（repository）** · **更新（update）** · **更新类别（category）** · **轻量信息（glance）** · **全量信息（detail）** · **最近动态时间（last activity）** · **历史快照（snapshot）** · **趋势（trend）** · **访问令牌（PAT）** · **抓取（fetch）**

## 📑 文档与工具

- [`CONTEXT.md`](CONTEXT.md) —— 领域词汇表（含每条的 Avoid 词）。
- [`docs/adr/`](docs/adr/) —— 架构决策记录。ADR-0001 记录**双栈决策**：v1 Windows 用 Electron，v1.1 Android 用 Kotlin + Jetpack Compose，两端业务逻辑各写一遍、以 v1 spec 对齐（**Kotlin 端目前仅为规划，尚未实现**）。
- [`docs/agents/`](docs/agents/) —— 仓库工程约定：issue tracker（本地 Markdown）、triage 标签、领域文档规则。
- `.agents/`（第三方 Agent 技能集）、`skills-lock.json`（其锁文件）与 `.scratch/`（本地 issue tracker 与 v1 spec）—— **仅本机保留，不入库**。
- 根目录 `github_pulse_repository_monitor.html` 与 `octo_nexus_github_personal_center.html` 是**早期 UI 原型**（单文件 HTML + CDN，只有界面没有数据链路），其可用 UI 资产被 v1 复用；这两个文件**不入库**，仅本机保留。

## 🗺 路线图与非目标

**路线图**

- **M1** 地基：骨架 + core + 令牌连通
- **M2** 核心链路端到端
- **M3** = v1：打包与人工验收——清单持久化、三条轻量信息、五类全量、快照当日不重复、错误降级不崩溃、5 仓库冷启动就绪 ≤ 8 秒、NSIS 独立安装。人工验收矩阵已就位（[`tests/manual-acceptance/`](tests/manual-acceptance/README.md)）；安装包尚未生成（`release/` 未创建）
- **M4** = v1.1：Android 端（Kotlin + Jetpack Compose），另立 spec，按 v1 的数据结构与规则对齐

**非目标**

通知渠道；共享 / 多用户；事件流与已读状态；云同步或真服务端；监控模式（Watching / Starred 区分）；导出备份；以及原型中的 CI 流水线阶段动画、双轴大图表、Webhook 终端、AI 哨兵、模拟数据源与演示令牌、限流遥测仪表、告警铃铛。

---

## 📜 许可

私有项目（`private: true`，UNLICENSED）。
