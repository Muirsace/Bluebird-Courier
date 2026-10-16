# 抓取与 GitHub API

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

---

← [返回 README](../README.md)
