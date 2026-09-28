# 代码骨架（草稿）

本文只规定 `src/` 与 `tests/` 的代码骨架：各层职责、目录位置、允许的依赖方向，以及模块迁移时的落地顺序。

本文不规定具体业务功能、接口字段、数据库表结构、页面内容或运行时产品行为。业务模块应在本骨架内自行落位。

## 职责分工

| 层 | 负责 | 关键边界 |
|---|---|---|
| **domain** | 领域类型、领域端口、纯业务规则 | 零平台依赖、零 I/O；不依赖 `core`、`features`、`facade`、`shared`、Electron 或 UI 框架 |
| **core/infra** | 可复用的基础设施能力：数据库、迁移器、加密、时钟、日志等 | 不承载业务规则；能力应可替换；可以依赖技术库 |
| **core/adapters** | 平台协议适配与端口实现；把平台响应转换为 domain 所需的形状 | 可以处理协议层判断；不定义业务规则；不把平台字段写入 domain 类型 |
| **features** | 单个业务能力的内部流程、数据访问和事务所有权 | 可以依赖 `domain` 与 `core/infra`；feature 之间保持隔离，不直接 import 其他 feature |
| **facade** | 跨 feature 编排、用例入口、契约结果组装 | 只编排已创建的 feature；不创建 feature；不负责基础设施接线；不承载业务规则 |
| **shared** | 跨进程契约、IPC 常量和对外结果类型 | 可以转出 domain 类型，也可以暴露平台字段；不承载业务规则 |
| **preload** | 将约定的 `BluebirdCourierBridge` 暴露为 `window.bluebirdCourier` | 只提供桥接；不暴露通用 Electron 能力或任意 IPC 通道 |
| **renderer** | 页面、组件、展示映射、格式化和图表配置 | 只消费 `shared` 契约与展示库；不实现业务规则 |
| **main/ipc** | 注册主进程 IPC 通道，并把调用转发到 facade | 只处理通道注册、参数转发和结果返回；不承载业务规则 |
| **main/index** | 唯一组合根：创建基础设施、创建 features、创建 facade，并完成主进程边界接线 | 可以依赖全部运行时模块；不承载业务逻辑 |

feature 之间禁止直接 import。跨 feature 协作由 `facade` 编排，或通过 domain port 注入完成；domain port 的具体实现由 `main/index.ts` 创建并注入 feature；feature 对基础设施的使用不等于 feature 之间的耦合。

## 目录骨架

目录只表示代码归属，不预先列出具体业务模块。

```text
src/
├─ domain/
│  ├─ types.ts
│  ├─ ports.ts
│  └─ rules/                  # 纯规则模块；可按需要拆分
│
├─ shared/
│  ├─ types.ts                # 跨进程契约与对外结果类型
│  └─ ipc.ts                  # IPC 通道常量
│
├─ main/
│  ├─ index.ts                # 唯一组合根
│  ├─ ipc.ts                  # IPC 注册与转发
│  ├─ core/
│  │  ├─ infra/
│  │  │  └─ ...               # 数据库、迁移、加密、时钟、日志等基础设施
│  │  └─ adapters/
│  │     └─ ...               # 外部平台协议适配器
│  ├─ features/
│  │  └─ <feature>/
│  │     └─ <feature>.ts      # feature 内部流程与事务所有权
│  └─ facade/
│     └─ facade.ts            # 只编排已创建的 feature
│
├─ preload/
│  └─ index.ts                # contextBridge 与 BluebirdCourierBridge
│
└─ renderer/
   ├─ pages/
   ├─ components/
   └─ lib/                    # 展示辅助，不放业务规则

tests/
├─ architecture/              # 依赖白名单与边界断言
├─ domain/                    # 纯规则测试
├─ core/                      # infra / adapter 测试
├─ facade/                    # facade 契约与编排测试
├─ main/
├─ preload/
├─ renderer/
└─ manual-acceptance/
```

## 依赖白名单

下表中的箭头表示“左侧模块可以 import 右侧模块”。依赖白名单只约束 `src/` 下的运行时代码；未列出的运行时代码依赖默认不允许。测试代码可以导入被测源码和测试工具，测试依赖另行约定。

下表中的 `core/infra`、`core/adapters`、`features` 和 `facade` 均指 `src/main/` 下的对应目录。

```text
domain         → （无项目模块依赖）
core/infra     → 技术依赖
core/adapters  → domain + 技术依赖
features       → domain + core/infra
facade         → features + domain + shared/types
shared         → domain（仅用于契约复用或类型转出）
preload        → shared + electron
renderer       → shared + 展示库
main/ipc       → facade + shared + electron
main/index     → `src/main/` 下的其他运行时模块 + domain + shared + 技术依赖（唯一组合根）
```

额外边界：

- `features` 不直接 import 其他 feature。
- `features` 不直接 import `core/adapters`；平台协议适配由组合根接线，或通过 domain 端口提供给 feature。
- `facade` 不创建 feature，不直接接触数据库、迁移器或其他基础设施实现。
- `renderer` 通过 `preload` 暴露的桥接访问主进程能力，不直接 import Electron 主进程模块。
- `shared` 可以携带平台字段，但这些字段不得进入 `domain`。
- `main/index` 不 import `preload` 或 `renderer`；两者由应用运行时分别加载。

## 落地顺序

每一步完成后，保持既有行为，并通过项目现有的类型检查和测试。

1. **建立 domain 层**：创建 domain 目录及其边界文件，将纯类型、端口和规则归位。
2. **归位 shared 契约**：将跨进程契约和 IPC 常量归入 `shared`，保留允许的 domain 类型转出。
3. **划分 core**：把基础设施放入 `core/infra`，把平台协议实现放入 `core/adapters`，明确两者的职责边界。
4. **迁移 features**：按 feature 建立目录和内部模块；允许 feature 使用 `domain` 与 `core/infra`，禁止 feature 之间直接 import。
5. **建立 facade**：让 facade 只接收已经创建的 feature 并负责跨 feature 编排和结果组装。
6. **收拢组合根**：由 `main/index.ts` 创建基础设施与 features，创建 facade，完成 IPC 及其他必要的主进程边界接线。
7. **补齐边界测试**：在 `tests/architecture/` 固化依赖白名单，并为 domain、core、facade、main、preload、renderer 保留对应测试位置。

完成条件：目录归属明确，依赖白名单可由架构测试验证，组合根是唯一组装入口，且每一步迁移后的既有行为保持不变。
