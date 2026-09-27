# Phase 14A · 截图验收记录

日期：2026-09-27

## 实施前基线

- `npm run typecheck`：通过。
- `npm test`：19 个测试文件、200 项通过。
- `npm run build`：通过；Vite 输出现有 `configLoader: 'native'` 配置兼容提示。

## 截图范围

以 `npm run build` 生成的 `dist/renderer` 生产产物为截图对象，通过本地 fixture bridge 提供演示数据；预览没有调用 GitHub API。Light 与 Dark 均已截图，14 个截图视图随本轮聊天输出。

| 页面 | Light | Dark | 复核重点 |
|---|---:|---:|---|
| Watchlist | ✓ | ✓ | 仓库名、指标、抓取时间的三级层级；`···` 点击区 |
| Detail Overview | ✓ | ✓ | Build 状态、双栏 Release / Commit、Issue 空态、Trend 摘要 |
| Release | ✓ | ✓ | Tag / badge / date 层级与弱化预发布 badge |
| Issue & PR Empty | ✓ | ✓ | 88px 紧凑空态与文字状态表达 |
| Build | ✓ | ✓ | 状态、workflow、时间 / conclusion 与 GitHub 操作三层结构 |
| Trend | ✓ | ✓ | 当前值、delta、时间范围、淡化网格与双指标并列 |
| Settings | ✓ | ✓ | 左对齐、840px 上限、主题 segmented control 与 Token 输入宽度 |

## 响应式检查

| 视口 | 结果 |
|---|---|
| 1152px | 页面与详情布局正常；Settings 内容上限 840px；Trend 双栏。`document.scrollWidth` 未超过视口。 |
| 768px | Trend 两列各约 343px；Settings 内容宽 736px；Build workflow 可收缩；无页面级横向溢出。 |
| 480px | Trend 堆叠；Detail Header 操作与指标换行；Build 操作保持可见；Settings 内容宽 448px；Watchlist 工具栏与仓库卡片可读。无页面级横向溢出。 |

## 复核结论

- 两种主题保持同一层级与控件语言；Light 的普通边界更弱，Dark 沿用现有 Slate / Emerald 语义 token。
- Overview 的强边界只在 Section 层，Trend 子区域改用 raised surface；Build 子区域以状态边线表达，不增加完整内框。
- 标题 / 正文 / meta 层级、表单尺寸与仓库身份区在目标视口均可读。
- 本记录不扩展 TC-01～TC-78。Phase 14A 截图已由用户复核，随后进入 Phase 14B；14B 的交互 / 响应式证据见 [Phase 14B 验收记录](./phase-14b-interaction-acceptance.md)。
