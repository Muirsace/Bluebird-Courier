# 开发指南

## 🎛 技术栈

| 层 | 选型 |
|---|---|
| 🖥 桌面壳 | Electron 44（主进程 CJS + preload 沙箱 + contextIsolation） |
| ⚙ 主进程 | TypeScript、better-sqlite3（本地 SQLite） |
| 🎨 渲染进程 | React 18、Vite 8、Tailwind CSS 3（语义 Design Token + 双主题）、TanStack Query v5、Chart.js 4 |
| 🔬 测试 | Vitest 5（主进程 node 环境 + 渲染层 happy-dom） |
| 📦 打包 | electron-builder → Windows NSIS（x64） |

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

## 📑 更多文档

- [架构说明](architecture.md) · [抓取与 GitHub API](github-api.md) · [测试](testing.md)
- [`agents/`](agents/) —— 仓库工程约定：issue tracker（本地 Markdown）、triage 标签、领域文档规则、代码骨架与目录映射。
- `.agents/`、`skills-lock.json`、`.scratch/` 与根目录两份早期 UI 原型 HTML **仅本机保留，不入库**。

## 🗺 路线图与非目标

**路线图**

- **M1** 地基：骨架 + core + 令牌连通
- **M2** 核心链路端到端
- **M3** = v1：打包与人工验收——清单持久化、三条轻量信息、五类全量、快照当日不重复、错误降级不崩溃、5 仓库冷启动就绪 ≤ 8 秒、NSIS 独立安装。人工验收矩阵已就位（[`tests/manual-acceptance/`](../tests/manual-acceptance/README.md)）；安装包尚未生成（`release/` 未创建）
- **M4** = v1.1：Android 端（Kotlin + Jetpack Compose），另立 spec，按 v1 的数据结构与规则对齐

**非目标**

通知渠道；共享 / 多用户；事件流与已读状态；云同步或真服务端；监控模式（Watching / Starred 区分）；导出备份；以及原型中的 CI 流水线阶段动画、双轴大图表、Webhook 终端、AI 哨兵、模拟数据源与演示令牌、限流遥测仪表、告警铃铛。

---

---

← [返回 README](../README.md)
