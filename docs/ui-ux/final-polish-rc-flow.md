# OCTO 仓库监控器 · Final Polish → RC 流程清单

> 目标：在核心架构、主要页面、主题系统、数据展示与 GitHub External Links 已基本完成的基础上，停止继续扩展功能，进入视觉精修、真机验收与 Release Candidate 收尾阶段。

---

## 当前原则

- 核心信息架构进入冻结状态。
- 不再随意修改 Watchlist / Detail / Settings 的页面关系。
- 不再随意调整 Theme Architecture、IPC、DB Schema、数据模型。
- 后续优先处理视觉一致性、Electron 真机行为、可访问性与发行质量。
- 搜索 / 排序 / 更多 Actions 详情等功能进入 Backlog，不与本轮收尾混做。

## Phase 14A Implementation（2026-09-27）

- Visual Foundation 已实现：Typography、Spacing、Surface / Border、控件尺寸、Settings 限宽、Detail Header 与 Build Status 视觉整理。
- 自动验证：`npm run typecheck`、`npm test`（19 个测试文件、200 项）与 `npm run build` 均通过。
- Light / Dark 七个目标页面均已用生产构建 Renderer 截图，截图记录见 [Phase 14A 截图验收记录](./phase-14a-visual-acceptance.md)。预览使用本地 fixture bridge，不调用 GitHub API；Electron 真机 Smoke 已由用户此前完成。
- 1152px、768px、480px 响应式检查与截图复核已完成；用户已确认进入 Phase 14B。

## Phase 14B Implementation（2026-09-27）

- 交互基础已收口：按钮与链接的 hover / pressed / disabled / loading 状态、Tabs 键盘方向键、菜单键盘导航与焦点归还、Popover / Menu 浮层样式、主题 Scrollbar，以及 `prefers-reduced-motion` 下的降动效规则。
- 自动验证：`npm run typecheck`、`npm test`（19 个测试文件、204 项）与 `npm run build` 均通过。
- 生产构建 Renderer 已在 Light / Dark 下复核 Watchlist、Detail Overview、Build、Trend、Settings，并检查 480px、768px、1152px 视口；交互与截图记录见 [Phase 14B Interaction Acceptance](./phase-14b-interaction-acceptance.md)。预览使用本地 fixture bridge，不访问 GitHub API。
- 完整 Manual Acceptance / RC 尚未开始。Windows Electron 中针对系统“减少动态效果”偏好的人工 Smoke 留待 Full Manual Acceptance；Chromium 的 `prefers-reduced-motion` CSS 规则已在构建产物中核对。

---

# Step 0 · 冻结当前架构

将以下部分视为基本冻结：

- 顶级导航
- Watchlist 信息架构
- Detail Overview + Tabs
- Settings 结构
- System / Light / Dark Theme Architecture
- Design Token
- Trend 数据表达
- Release / Commit / Issue & PR 数据表达
- GitHub External Links 安全通道
- Query / Refresh 语义
- 错误降级与缓存保留逻辑

除非发现明确 Bug，否则不要继续进行结构性重构。

### 本阶段禁止

- 新增大型功能
- 修改 DB Schema
- 修改 Repository / Snapshot 等核心数据模型
- 大幅调整 IPC
- 推翻现有 Theme 体系
- 重新设计页面导航
- 引入新 UI Framework

---

# Step 1 · 高风险 Electron 真机 Smoke

在 Windows 真机运行：

```bash
npm start
```

优先验证自动化无法完全覆盖的内容。

## 重点检查

### 启动

- 应用正常启动
- 无明显白屏 / 黑屏
- 无 startup theme flash
- 无主进程异常弹窗

### Theme

- System 模式跟随 Windows
- Windows 浅色 → OCTO 浅色
- Windows 深色 → OCTO 深色
- 应用运行中切系统主题能实时变化
- 强制 Light 时不跟随系统变化
- 强制 Dark 时不跟随系统变化
- 重启后主题偏好保持

### External Links

- GitHub 外链由系统默认浏览器打开
- OCTO 窗口本身不发生导航
- Repository / Release / Commit / Issue / PR / Build 外链均正常
- 非法目标被拒绝
- 外链失败时错误反馈正常

### 核心行为

- Watchlist 正常加载
- 打开 Detail 正常
- 手动刷新正常
- 刷新失败时旧数据保留
- 删除确认正常
- 删除失败时仓库仍保留
- Settings Token 行为正常

### 输入与窗口

- 键盘 Tab 导航正常
- Enter / Space 激活合理
- Esc 关闭 Popover / Menu
- 480 / 768 / 1152px 下无关键布局异常

---

# Step 2 · 建立代码 Checkpoint

真机 Smoke 没有阻断问题后，建立一个明确的代码回退点。

建议：

```bash
git add -A
git commit -m "feat(ui): complete repository monitoring experience"
```

此提交代表：

- 核心功能完成
- 自动化验证通过
- 高风险真机行为已初步确认

不代表：

- Final Visual Polish 已完成
- Full Manual Acceptance 已完成
- Release Candidate 已完成

---

# Step 3 · Phase 14A · Visual Foundation

**Implementation complete · 2026-09-27.** 本轮保持信息架构、功能行为与 Theme Architecture 冻结；细节见下方截图验收记录。

本阶段只做视觉基础，不新增功能。

推荐顺序：

## 3.1 Typography

统一：

- 页面标题
- 仓库标题
- Section 标题
- 正文
- 辅助文字
- Meta 信息
- 数字
- monospace 内容

建议原则：

- 普通 UI 文本使用系统 sans-serif
- repo / tag / SHA / workflow 等技术内容使用 monospace
- 拉开标题 / 正文 / 辅助信息层级
- 避免所有文字“同一个重量”

## 3.2 Spacing Scale

统一：

- 页面上下间距
- Section 间距
- Card padding
- 表单间距
- 列表行高
- Button / Input 内边距
- Badge 与文字间距

目标：

减少“每个页面自己定一套间距”。

## 3.3 Surface / Border 层级

减少盒子感。

原则：

> 一个视觉层级最多一层显式边框。

重点：

- Overview 不要 Card 套 Card 套 Card
- 浅色模式减少灰边框密度
- 深色模式不要继续堆高亮边框
- Popover / Menu 可使用更明显 elevation
- 普通 Section 优先靠 surface 区分

## 3.4 Button / Input / Menu 尺寸统一

建议建立统一尺寸区间：

- 普通 Button：34–36px
- IconButton：32–34px
- Menu Item：36–40px
- Input：36–38px

统一：

- radius
- border
- padding
- icon size
- focus state

## 3.5 Settings 页面限宽

Detail / Watchlist 可以继续使用较宽布局。

Settings 单独限制内容宽度：

```text
760–840px
```

要求：

- 左对齐
- 不要变成居中网页表单
- Token 输入框不要横跨整个 1152px 内容区
- 外观与 GitHub Section 更紧凑

## 3.6 Detail Header 精修

保持现有结构，不重构。

优化：

- 仓库名更突出
- fetched time 更弱
- Stars / Forks / 最近活动 / 最新版本形成稳定 definition group
- GitHub / Refresh 操作统一尺寸
- 不新增额外 Card

## 3.7 Build 状态卡重做

Build 是本阶段最值得单独打磨的组件。

推荐三层：

```text
构建失败
uv in /python/sdk – Update #1592951955
11 小时前 · failure                        在 GitHub 查看
```

建议：

- 主状态高权重
- Workflow 次一级
- 时间 / conclusion 作为 meta
- 失败使用克制 danger surface / left accent
- Success / Pending 同样有一致结构
- 不整卡高饱和染色

---

# Step 4 · Phase 14A 截图复核（完成）

Visual Foundation 与 14 张 Light / Dark 关键视图截图已完成并经用户复核；随后已进入 Phase 14B。

分别截图：

## Light

- Watchlist
- Detail Overview
- Release
- Issue & PR
- Build
- Trend
- Settings

## Dark

同样全部检查。

### 重点观察

- Typography 是否清晰
- Border 是否过多
- 页面是否仍像后台网页
- Card 层级是否合理
- Settings 是否过宽
- Build 是否突出
- Light / Dark 是否属于同一套视觉语言

如果基础层级仍有问题，不进入动效阶段。

---

# Step 5 · Phase 14B · Interaction & Micro Polish

**Implementation complete · 2026-09-27.** 当前交互与微动效实现、自动验证和本地 Renderer 视觉记录见 [Phase 14B Interaction Acceptance](./phase-14b-interaction-acceptance.md)。本步骤不代表 Full Manual Acceptance 或 Release Candidate 已完成。

## 统一状态

- Hover
- Pressed
- Focus
- Selected
- Disabled
- Loading
- Menu Open
- Popover Open

## Tabs

保持：

- 文字 + underline

优化：

- active 字重
- underline 高度
- hover feedback
- 高度统一
- divider 弱化

不要改成大面积 pill navigation。

## Menu / Popover

统一：

- radius
- shadow
- padding
- item height
- danger state
- focus behavior

## Scrollbar

检查：

- Light / Dark
- 长 Release 列表
- Electron 窗口
- 不要喧宾夺主

## Tooltip

只在真正需要解释的地方使用。

不要滥用。

## 动效

统一：

```text
150–180ms
```

优先：

- opacity
- background-color
- border-color
- transform

避免：

- 大幅 scale
- 发光
- 玻璃
- 渐变流光
- 复杂页面转场

---

# Step 6 · 响应式与极端内容专项

测试：

```text
1152px
768px
480px
```

## 内容边界

- 超长仓库名
- 超长 Release Tag
- 超长 Commit Message
- 超长 Workflow
- 无 Release
- 无 Commit
- Issue / PR 为空
- 只有 1 个 snapshot
- 2 个 snapshot
- 多 snapshot
- Build 无数据
- Build Failure

## 要求

- 无页面级横向滚动
- 操作按钮不被挤掉
- `···` 始终可用
- Tabs 可合理横向滚动
- Grid 正确降为单列
- 文本截断行为清晰
- title / aria-label 保留完整信息

---

# Step 7 · Accessibility 与视觉一致性检查

重点检查：

- 键盘完整可操作
- focus-visible 清楚
- Esc 关闭浮层
- Menu / Popover 焦点归还正确
- 颜色不是唯一状态表达
- Light / Dark 对比度达标
- Button 点击区足够
- Chart 关键数据有文本表达
- Badge 有文字，不只靠颜色

---

# Step 8 · Full Manual Acceptance

完成 Final Visual Polish 后，再执行完整 Manual Acceptance。

当前：

```text
TC-01 ～ TC-78
```

这一次作为真正 Release Candidate 前的人工作业。

## 建议分级

### P0 / Smoke

每个 RC 都跑：

- 启动
- Theme
- Refresh
- Delete
- Detail
- Error fallback
- External Links
- Security boundary

### P1 / Feature

重大 UI 改动后跑：

- Trend
- Release
- Commit
- Issue / PR
- Popover
- Responsive
- Settings

### P2 / Extended

正式 Release 前完整跑：

- 所有边界组合
- 空态
- 错误态
- 极端内容
- 长列表
- Keyboard

---

# Step 9 · 缺陷修复轮

Manual Acceptance 中发现的问题：

- 单独列 Bug
- 不顺便加功能
- 不顺便重构
- 修复后跑相关自动测试
- 重新跑对应 Manual Case

保持 Scope 小。

---

# Step 10 · Release Candidate 验证

代码与 UI 验收完成后进入发行验证。

## Windows Packaging

检查：

- 安装包生成
- 首次安装
- 启动
- 升级覆盖
- 卸载

## Data

检查：

- SQLite 数据持久化
- Watchlist 保留
- Snapshot 保留
- Theme Setting 保留
- Token 状态保留

## Security

检查：

- safeStorage
- preload sandbox
- External Link 白名单
- Renderer 无 Node 权限泄漏

## Network

检查：

- 正常 GitHub API
- Rate Limit
- Invalid Token
- Network Failure
- Recovery

## Performance

检查：

- 冷启动
- 多仓库启动
- Detail 打开
- Trend 渲染
- Refresh

---

# Step 11 · RC Checkpoint / Tag

满足以下条件后：

- typecheck PASS
- tests PASS
- build PASS
- Manual Acceptance PASS
- Packaging PASS
- RC Smoke PASS

建立：

- RC commit
- RC tag
- 或 release branch

---

# Step 12 · Backlog

以下功能不进入当前收尾周期。

## 搜索 / 排序

等真实使用出现：

```text
10～20+ 仓库
```

再决定是否需要：

- 名称搜索
- 最近活动排序
- Stars 排序
- Build 状态过滤

## 逐仓库刷新进度

当前后端只暴露全局：

```text
refreshGlance
```

因此标记为：

> Deferred · backend does not expose per-repository progress

不作为当前缺陷。

## Release Stable / Draft

当前 domain 不保存：

- prerelease
- draft

所以：

> Not implemented by design

避免未来 Agent 把它误认为遗漏。

## 更多 GitHub Actions 详情

例如：

- Workflow 列表
- Run History
- Job Details

留到后续真正有需求时再做。

---

# 最终流程总览

```text
架构冻结
   ↓
高风险 Electron 真机 Smoke
   ↓
建立 Checkpoint
   ↓
Phase 14A · Visual Foundation
   ↓
截图复核
   ↓
Phase 14B · Interaction & Micro Polish
   ↓
Responsive / Accessibility
   ↓
Full Manual Acceptance
   ↓
缺陷修复
   ↓
Release Candidate 验证
   ↓
RC Checkpoint / Tag
```

---

# 当前下一步

Phase 14B 已实现并完成自动验证与浏览器视觉复核；现在暂停等待用户复核。下一步仅建议进行 Full Manual Acceptance / RC 验收；本轮不自动开始。
