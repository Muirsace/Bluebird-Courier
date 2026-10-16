# 测试

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

整机行为（Electron 壳、真实 GitHub 网络、窗口尺寸）仍由 [`tests/manual-acceptance/`](../tests/manual-acceptance/README.md) 的人工验收矩阵覆盖。

---

← [返回 README](../README.md)
