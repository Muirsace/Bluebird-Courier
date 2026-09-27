# OCTO 仓库监控器 · UI/UX 修改顺序

> 目标：在不破坏现有功能与数据链路的前提下，按“信息架构 → 交互 → 布局 → 组件 → 主题 → 视觉精修”的顺序推进 UI/UX 重构，避免先做视觉美化后因页面结构调整造成返工。

## 实施状态

三列含义：**实现** = 代码已落地；**自动验证** = 有可回归的自动化断言（`npm test` / `npm run typecheck` / `npm run build`）；**人工验收** = 需要人在真机 Electron 里跑。自动化通过不等于人工验收完成。

| Phase | 内容 | 实现 | 自动验证 | 人工验收 |
|---|---|---|---|---|
| 1 | 信息架构（顶级导航 + 详情页下沉） | ✅ 2026-09-27 | ✅ 渲染层断言 | ⏳ TC-01～TC-04 |
| 2 | 仓库详情页（表头 + 六个 Tab + 概览） | ✅ 2026-09-27 | ✅ 渲染层断言 | ⏳ TC-05～TC-14 |
| 3 | 监控清单（卡片层级 + `···` 菜单 + 工具栏） | ✅ 2026-09-27（搜索/排序仅预留布局） | ✅ 渲染层断言 | ⏳ TC-25～TC-38 |
| 4 | 数据状态与刷新 UX | 🔶 清单侧完成、详情侧完成；逐行刷新状态未做 | ✅ 渲染层断言 | ⏳ TC-20～TC-22、TC-29～TC-31 |
| 5 | 危险操作统一（移除确认 Popover） | ✅ 2026-09-27 | ✅ 渲染层断言 | ⏳ TC-32～TC-36 |
| 6 | 设计 Token | ✅ 2026-09-27 | ✅ 语义类护栏断言 | ⏳ TC-39～TC-40 |
| 7 | System / Light / Dark | ✅ 2026-09-27 | ✅ 偏好/effective/图表断言 | ⏳ TC-41～TC-48 |
| 8 | 设置页重构 | ✅ 2026-09-27 | ✅ 渲染层断言 | ⏳ TC-49～TC-52 |
| 9 | 趋势图重构（Stars / Forks 独立图 + 变化量 + 7D/30D/90D） | ✅ 2026-09-27 | ✅ 渲染层断言 + 浏览器像素实测 | ⏳ TC-53～TC-59 |
| 10 | Release / Commit / Issue / PR 数据表达 | ✅ 2026-09-27（Stable 标记**不做**：domain 无 prerelease 字段，只认 alpha/beta/rc） | ✅ 渲染层断言 + 浏览器实测 | ⏳ TC-60～TC-68 |
| 11 | 构建状态组件 | 🔶 徽章语义与概览置顶已做；外链通道未建立 | ✅ 渲染层断言 | ⏳ TC-10 |
| 12 | 公共组件 | 🔶 已提取 ThemeSelector / SettingSection / 详情与清单的列表组件；Button / Card 等未统一 | — | — |
| 13 | 桌面布局 / 响应式 | 🔶 内容宽度 1152px、换行与横向滚动已就位 | ✅ 浏览器实测 | ⏳ TC-23、TC-24、TC-38 |
| 14A | Visual Foundation | ✅ 2026-09-27 | ✅ typecheck / 200 tests / build | ✅ Light / Dark 截图复核完成 |
| 14B | Interaction & Micro Polish | ✅ 2026-09-27 | ✅ typecheck / 204 tests / build | ✅ Renderer 交互与响应式截图记录；Windows Electron Reduce Motion Smoke 留在 Full Manual Acceptance |

---

## 总体原则

1. **先改信息架构，再改视觉。**
2. **先解决“怎么用”，再解决“好不好看”。**
3. **保持现有功能行为稳定，不因 UI 重构修改业务语义。**
4. **所有新增页面与组件从一开始就考虑浅色 / 深色双主题。**
5. **桌面端优先，兼顾小窗口响应式。**
6. **减少 GitHub API 的隐式抓取，刷新行为必须可预测。**
7. **错误态、空态、加载态、缓存态必须明确区分。**

---

# Phase 1 · 信息架构重构

## 1. 顶级导航调整

当前：

- 监控清单
- 全量信息
- 设置

调整为：

- **监控清单**
- **设置**

“全量信息”不再作为顶级导航入口。

### 新的页面关系

```text
监控清单
  └─ 仓库详情
      ├─ 概览
      ├─ 发版
      ├─ 提交
      ├─ Issue & PR
      ├─ 构建
      └─ 趋势

设置
```

### 仓库详情导航

进入仓库后使用：

```text
← 监控清单

deepseek-ai/deepseek-harness
```

或：

```text
监控清单 / deepseek-ai/deepseek-harness
```

### 验收目标

- 未选择仓库时，不再出现不可用的“全量信息”顶级导航。
- 用户能明确理解“仓库详情属于监控清单的下一层”。
- 顶部导航结构更简单。

---

# Phase 2 · 仓库详情页重构

这是整个 UI/UX 重构中优先级最高的页面。

## 2.1 建立详情页顶部 Summary

顶部展示：

- 仓库名
- 上次成功抓取时间
- GitHub 外链
- 手动重新抓取按钮

核心指标建议：

```text
236,929
Stars

28,484
Forks

2 天前
最近活动

dsh-v0.1.7-rc.2
最新版本
```

### 目标

用户进入详情页后，在第一屏就能判断：

- 仓库最近有没有活动
- 最新版本是什么
- Stars / Forks 当前规模
- 最近构建是否正常

---

## 2.2 详情页改为 Tab 结构

使用：

```text
概览 | 发版 | 提交 | Issue & PR | 构建 | 趋势
```

默认打开 **概览**。

### 概览页仅展示摘要

建议包含：

- 最新 Release
- 最近 3～5 条 Commit
- Issue / PR 状态摘要
- 最新 Build 状态
- Stars / Forks 趋势摘要

### 完整数据

完整长列表移到各自 Tab：

- 发版 → Release 完整列表
- 提交 → Commit 完整列表
- Issue & PR → Issue / PR 完整列表
- 构建 → 最近构建状态
- 趋势 → 完整趋势图

### 验收目标

- 不再需要连续滚动 2～3 屏才能看到整个仓库状态。
- 第一屏完成“快速判断仓库现状”的任务。
- 长列表不再挤占概览页。

---

# Phase 3 · 监控清单重构

## 3.1 调整仓库卡片信息层级

当前更接近横向数据行。

建议结构：

```text
┌──────────────────────────────────────────────┐
│ deepseek-ai/deepseek-harness            ··· │
│ 抓取于 4 分钟前                             │
│                                              │
│ ★ 236,929   Activity 2 天前   v0.1.7-rc.2   │
└──────────────────────────────────────────────┘
```

### 层级建议

第一视觉层级：

- 仓库名称

第二视觉层级：

- Stars
- 最近活动
- 最新 Release

第三视觉层级：

- 抓取时间

---

## 3.2 删除按钮移入 `···` 菜单

不要让红色删除按钮永久出现在每张卡片。

菜单建议：

```text
···
├─ 在 GitHub 打开
├─ 立即刷新
└─ 从监控清单移除
```

仅危险操作使用红色。

---

## 3.3 优化顶部 Toolbar

建议：

```text
监控清单                              2 个仓库

[ owner/repo 或 GitHub URL             ] [＋加入]

排序：最近活动 ▼                     ⟳ 全部刷新
```

为未来预留：

- 搜索
- 排序
- 筛选

### 验收目标

- 仓库名称更突出。
- 危险操作不再抢夺视觉注意力。
- 增加仓库、刷新清单、查看数量等操作集中在统一区域。

---

# Phase 4 · 数据状态与刷新 UX

## 4.1 明确区分状态

必须分别处理：

- 首次加载
- 后台刷新
- 手动重新抓取
- 使用缓存数据
- 抓取失败
- 真正空数据

---

## 4.2 刷新时保留已有内容

当前不建议：

```text
整个页面 opacity-60
```

改为：

- 数据继续正常显示
- 刷新按钮显示 Spinner
- 抓取时间旁显示“正在更新”
- 刷新失败时保留上次成功数据

例如：

```text
抓取于 4 分钟前 · 正在更新…
```

### 验收目标

- 用户不会因为刷新误以为页面不可用。
- 网络失败不会造成数据“消失”。
- 用户能明确知道当前看到的是缓存还是最新结果。

---

## 4.3 禁止隐式高成本重抓

详情页 GitHub 全量抓取必须以用户主动操作为主。

建议：

- `refetchOnWindowFocus: false`
- `refetchOnMount: false`
- `refetchOnReconnect: false`
- 需要最新数据时点击“重新抓取”

避免切换页面、窗口重新获得焦点等行为无意触发 GitHub API。

---

# Phase 5 · 危险操作统一

## 5.1 删除仓库

取消“4 秒内再次点击确认删除”的交互。

改为小型 Popover：

```text
从监控清单移除
deepseek-ai/deepseek-harness？

[取消] [移除]
```

不需要大型 Modal。

### 原则

- 危险操作明确
- 有取消按钮
- 不依赖倒计时
- 不误触

---

# Phase 6 · 建立设计 Token

在继续视觉重构之前，先停止直接在业务组件中大量使用：

```text
slate-950
slate-900
slate-800
emerald-500
text-slate-*
```

改为语义 Token。

## 建议 Token

### 背景

- `bg-app`
- `bg-surface`
- `bg-elevated`

### 边框

- `border-default`
- `border-subtle`

### 文字

- `text-primary`
- `text-secondary`
- `text-muted`

### 状态

- `accent`
- `success`
- `warning`
- `danger`
- `info`

### 图表

- `chart-grid`
- `chart-label`
- `chart-tooltip-bg`
- `chart-tooltip-text`
- `chart-star`
- `chart-fork`

### 目标

组件只关心“这个颜色代表什么”，不关心具体是 `slate-700` 还是 `slate-800`。

---

# Phase 7 · 主题系统

## 7.1 三种主题模式

提供：

```text
[ 跟随系统 ] [ 浅色 ] [ 深色 ]
```

默认：

**跟随系统**

## 7.2 Electron 行为

使用 `nativeTheme`：

```text
system → nativeTheme.themeSource = 'system'
light  → nativeTheme.themeSource = 'light'
dark   → nativeTheme.themeSource = 'dark'
```

主题偏好保存到现有 `setting` 表。

---

## 7.3 浅色模式建议

不要简单“反色”。

推荐：

```text
应用背景     #F5F7FA
卡片背景     #FFFFFF
次级背景     #F8FAFC
主要文字     #172033
次级文字     #5D697A
弱文字       #8490A1
边框         #DCE2EA
弱边框       #E9EDF2
```

Accent 继续保留 Emerald，但浅色模式使用更深的绿色以保证对比度。

### 验收目标

- Windows 切换系统主题时应用实时响应。
- 用户可以覆盖系统主题。
- 图表、Tooltip、Badge、ErrorBar 等组件全部正确切换主题。

---

# Phase 8 · 设置页重构

建议结构：

```text
设置

外观
────────────────────────
主题
[ 系统 ] [ 浅色 ] [ 深色 ]


GitHub
────────────────────────
Personal Access Token        已配置

[ •••••••••••••••• ] [显示]

令牌只保存在本机。

[保存并验证]     [测试连接]
```

## 调整项

- 增加外观设置。
- Token 增加显示 / 隐藏。
- “校验”弱化为“测试连接”。
- 删除页面底部重复的“返回清单”按钮。
- 保存成功提示只出现一次。

未来可增加：

- 当前 GitHub 用户
- API 配额
- Token 权限状态

---

# Phase 9 · 趋势图重构

当前 Stars 与 Forks 数量级差异太大，不适合共用同一 Y 轴。

## 建议

拆成两个趋势组件：

```text
Stars
236,929
+142 / 7d
──────────

Forks
28,484
+21 / 7d
──────────
```

使用独立 Sparkline。

数据足够后支持：

```text
7D | 30D | 90D | All
```

### 验收目标

- Fork 曲线不再贴在图表底部。
- 即便趋势很平，也能通过变化值获得有效信息。

---

## 9.1 实际实现（2026-09-27）

- **两张独立的图**：`TrendMetric` 每个指标一张 Chart.js 折线图、各自一套 Y 轴，Y 轴按各自数据范围自适应（不强制从 0 起），不再共用刻度；单条数据线不带图例。
- **变化量本地计算**：`src/renderer/lib/trend.ts` 的 `orderSnapshots` / `filterByRange` / `summarizeMetric`——按 `capturedAt` 升序（不假设入参有序、不改原数组、丢弃时间戳不可解析的记录），取窗口内最早可用值为基线、最新可用值为当前值，`delta = current - baseline`。
- **不伪造数据**：有效数值点少于 2 个时 `delta = null`，界面显示「该时间范围内的记录不足 2 次，无法计算变化」；0 条显示「暂无趋势数据…」，1 条显示「已有首次记录…」。绝不显示 `+0`。
- **时间范围 7D / 30D / 90D**：`TrendRangeSelector`（真按钮 + `aria-pressed` + `role="group"`）纯本地过滤，无任何额外请求。范围文案按实际记录跨度说话：窗口被真实数据填满才说「过去 N 天」，否则说「已记录 N 天」。
- **图表不是唯一信息来源**：每张卡以文本给出当前值、变化量、记录范围（`MM-DD ~ MM-DD · 共 N 次记录`），canvas 另有 `aria-label`。
- **概览**用同一组件的紧凑版（无坐标轴、h-16 sparkline，`scope = all`），不把概览撑长。

---

# Phase 10 · 长列表优化

## 10.1 Release

概览：

- 最近 3～5 条

完整列表：

- Stable / RC / Alpha 标记
- 发布时间
- Tag

示例：

```text
v0.1.7-rc.2      RC       Sep 24
v0.1.7-rc.1      RC       Sep 23
v0.1.7-alpha.2   Alpha    Sep 22
```

---

## 10.2 Commit

调整视觉层级。

推荐：

```text
Merge pull request #5180 from ...
Turtle · 2 天前
77b4f4
```

优先级：

1. Commit message
2. 作者 + 时间
3. SHA

不要让 SHA 成为第一视觉元素。

---

## 10.3 Issue / PR 空态

当前如果两者都为空，不要使用一整张大卡片。

改为：

```text
Issues & Pull Requests

✓ 当前没有开放的 Issue 或 Pull Request
```

---

## 10.4 实际实现与偏差（2026-09-27）

- **发版类型只认 alpha / beta / rc**：`classifyReleaseTag()` 按分隔符切词后精确匹配 `rc` / `rc1` / `beta` / `beta2` / `alpha` 这类词；**不再显示 Stable**。原因：`ReleaseItem` 只有 `tagName / title / publishedAt`，没有 GitHub 的 `prerelease` / `draft` 字段，"普通版本号 = Stable" 属于过度推断，而且 nightly / canary / dev / snapshot 会被误判。不显示徽章比标错更诚实。
- **发版层级**：`Tag → 类型徽章 → 绝对短日期`，标题只在它不等于 tag 时另起一行（GitHub 上 `name === tag_name` 很常见）。
- **概览发版**仍是最近 5 条 + 条数提示；计数文案统一改为「已抓取 N 条」——抓取只取最近一页，说"共 N 条"会夸大。
- **提交**：消息一行 `truncate` 并带 `title` 露出全文（长 merge 提交不会撑高列表），第二层 `作者 · 相对时间 · SHA`，SHA 等宽弱色放行末。
- **Issue / PR**：两者皆空时只留一行 `✓ 当前没有开放的 Issue 或 Pull Request`；有数据时先给 `议题 N 条 / 合并请求 M 条` 计数摘要再分区；每行开头是文字类型徽章 `Issue` / `PR`，类型与状态都不只靠颜色。

---

# Phase 11 · 构建状态组件

构建状态作为高价值信息，应提高视觉权重。

建议：

```text
┌──────────────────────────────────────────────┐
│ ● 构建失败                                   │
│ uv in /python/sdk – Update #1592951955      │
│ GitHub Actions · 7 小时前            查看 ↗ │
└──────────────────────────────────────────────┘
```

状态：

- Success → Green
- Failure → Red
- Pending → Amber
- Neutral → Gray

## 11.1 实际实现（2026-09-27）——外链通道

计划里的「查看 ↗」没有做成裸链接，而是先建立一条**受控外链通道**：渲染层只说明要打开哪个 GitHub 实体，URL 由主进程构造并再校验，最后交给 `shell.openExternal`。

- 已接入口：清单 `···` 菜单、详情页表头、发版 Tag、提交 SHA、议题 / PR 编号，以及构建 Tab 的「在 GitHub 查看 ↗」（Actions 地址来自接口的 `html_url`，本机没有 run id 可构造）。
- 安全边界：只放行 `https:` + host 恰为 `github.com` 的地址，非法目标连 `shell` 都不碰；OCTO 窗口永远不会被导航离开应用。规则与拒绝清单见 README「在 GitHub 打开（受控外链）」。
- 未做：把构建状态整块做成计划里的三段式卡片（含 run 标题那一行）属于 Phase 14 视觉 Polish，本轮只补外链入口。

---

# Phase 12 · 公共组件统一

完成页面结构后统一公共组件。

建议建立：

- `Button`
- `IconButton`
- `Card`
- `StatCard`
- `Badge`
- `Input`
- `Tabs`
- `Dropdown`
- `Popover`
- `Toast`
- `EmptyState`
- `ErrorState`
- `LoadingState`

### 目标

业务页面不再重复拼接大量 Tailwind class。

---

# Phase 13 · 桌面布局与响应式

当前桌面内容区域偏窄。

建议：

```text
max-width: 1100～1200px
```

而不是当前接近 `max-w-4xl` 的宽度。

## 大屏

充分利用横向空间。

## 小窗口

- 指标自动换行
- Toolbar 自动换行
- Tab 可横向滚动
- Commit / Release 元信息允许换行

---

# Phase 14 · 最终视觉 Polish

只有完成前面的结构调整后再进行。

包括：

- 圆角统一
- 卡片阴影
- Hover
- Active
- Focus
- Transition
- 字号
- 行高
- 间距
- 图标
- Badge 风格
- Tooltip
- Toast 动画
- 浅色 / 深色对比度
- 键盘焦点状态

### 动效原则

- 150～220ms
- 优先 opacity / transform
- 不使用夸张动画
- 刷新与页面切换避免造成布局跳动

---

# 推荐实施顺序总览

```text
Phase 1   信息架构
    ↓
Phase 2   仓库详情页
    ↓
Phase 3   监控清单
    ↓
Phase 4   Loading / Refresh / Error / Empty
    ↓
Phase 5   危险操作
    ↓
Phase 6   Design Token
    ↓
Phase 7   System / Light / Dark
    ↓
Phase 8   设置页
    ↓
Phase 9   趋势图
    ↓
Phase 10  Release / Commit / Issue / PR
    ↓
Phase 11  Build 状态
    ↓
Phase 12  公共组件
    ↓
Phase 13  桌面布局 / 响应式
    ↓
Phase 14  最终视觉 Polish
```

---

# 建议的开发里程碑

## Milestone A · 信息架构

完成：

- 顶部导航
- 仓库详情子页面
- Tabs
- 页面关系

**此阶段不要大规模改颜色。**

---

## Milestone B · 核心页面

完成：

- 仓库 Overview
- 监控清单
- Summary / StatCard

---

## Milestone C · 状态 UX

完成：

- Loading
- Refresh
- Error
- Cached
- Empty
- Remove confirmation

---

## Milestone D · Design System

完成：

- Theme Tokens
- 公共组件
- 统一状态样式

---

## Milestone E · Theme

完成：

- System
- Light
- Dark
- Chart 双主题

---

## Milestone F · 数据展示

完成：

- Trend
- Build
- Release
- Commit
- Issue / PR

---

## Milestone G · Visual Polish

完成：

- 动效
- Hover
- Typography
- Spacing
- Responsive
- Accessibility

---

# 最终目标

重构完成后的 OCTO 应从目前的：

> “GitHub API 数据展示工具”

提升为：

> **“打开后第一眼就能判断关注仓库最近发生了什么的桌面监控工具”。**

核心体验应满足：

- 第一屏看懂仓库现状。
- 不需要大量滚动才能找到关键信息。
- 用户主动控制 API 抓取。
- 网络失败时仍可继续查看已有数据。
- 浅色 / 深色模式自然一致。
- 危险操作明确但不抢眼。
- 桌面宽屏空间得到充分利用。
