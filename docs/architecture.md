# 架构说明

## 🏗 分层总览

**主进程三层 + 唯一门面**，渲染进程只做 UI，全部数据经 preload 白名单 IPC 进出：

```
渲染进程 (React)
   │  window.bluebirdCourier.*  ← 12 个白名单 IPC 通道 (octo:xxx)：11 个用例门面 + 1 个受控外链
preload (contextBridge)
   │
facade  ← 用例边界，渲染层唯一入口；错误在此归一
   │
features  ← 用例片段 + 全部 SQL：repository-list / repository-detail / token-settings / snapshot-trend
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

## 🔗 受控外链的安全边界

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

## 🗂 项目结构

`src/` 各目录与文件的职责见 [`agents/directory-map.md`](agents/directory-map.md)，层职责与依赖白名单见 [`agents/skeleton.md`](agents/skeleton.md)。

## 📚 领域词汇

全项目（代码、测试、文档、提交信息）统一使用以下词汇，不漂移到同义词：

**监控清单（watchlist）** · **监控仓库（repository）** · **更新（update）** · **更新类别（category）** · **轻量信息（glance）** · **全量信息（detail）** · **最近动态时间（last activity）** · **历史快照（snapshot）** · **趋势（trend）** · **访问令牌（PAT）** · **抓取（fetch）**

---

← [返回 README](../README.md)
