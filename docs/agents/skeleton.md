# 代码骨架

本文规定 `src/` 与 `tests/` 的长期代码骨架：各层职责、目录位置、允许的依赖方向，以及按此骨架实现代码的落地顺序。所有代码增删改均须遵守本规范。

本文不规定具体业务功能、接口字段、数据库表结构、页面内容或运行时产品行为。业务模块应在本骨架内自行落位。

## 职责分工

| 层 | 负责 | 关键边界 |
|---|---|---|
| **domain** | 领域类型、领域端口、纯业务规则 | 零平台依赖、零 I/O；不依赖 `core`、`features`、`facade`、`shared`、Electron 或 UI 框架 |
| **core/infra** | 可复用的基础设施能力：数据库、迁移器、加密、时钟、日志等 | 不承载业务规则；能力应可替换；可以依赖技术库 |
| **core/adapters** | 平台协议适配与端口实现；把平台响应转换为 domain 所需的形状 | 可以处理协议层判断；不定义业务规则；不把平台字段写入 domain 类型 |
| **features** | 单个业务能力的对外契约、内部流程、数据访问和事务所有权 | contract 只依赖 `domain`；implementation 可以依赖自身 contract、`domain` 与 `core/infra`；feature 之间保持隔离，不直接 import 其他 feature |
| **facade** | 跨 feature 编排、用例入口、契约结果组装 | 只依赖并编排已创建的 feature 对外契约；不依赖或实例化 feature 实现；不负责基础设施接线；不承载业务规则 |
| **shared** | 跨进程契约、IPC 常量和对外结果类型 | 可以转出 domain 类型，也可以暴露平台字段；不承载业务规则 |
| **preload** | 将约定的 `BluebirdCourierBridge` 暴露为 `window.bluebirdCourier` | 只提供桥接；不暴露通用 Electron 能力或任意 IPC 通道 |
| **renderer** | 页面、组件、展示映射、格式化和图表配置 | 只消费 `shared` 契约与允许的前端展示库；不实现业务规则，不依赖主进程、domain、Electron 主进程或 Node 后端能力 |
| **main/ipc** | 注册主进程 IPC 通道，并把调用转发到 facade | 只处理通道注册、参数转发和结果返回；不承载业务规则 |
| **main/index** | 唯一组合根：创建基础设施、创建 feature 实现、创建 facade，并完成主进程边界接线 | 可以依赖主进程运行时模块、`domain`、`shared` 和技术依赖；是 feature 实现的唯一创建入口；不依赖 `preload` 或 `renderer`；不承载业务逻辑 |

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
│  │     ├─ contract/         # feature 对外契约面；facade 只依赖这里
│  │     └─ implementation/   # feature 实现面与创建入口；main/index 负责创建
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

架构测试将以下所有模块级源码依赖视为同一种依赖边：静态 `import`、`import type`、re-export、动态 `import()` 和 `require()`。模块路径必须可静态解析；无法静态解析的动态路径不得绕过白名单，必须禁止或显式登记。

下表中的 `core/infra`、`core/adapters`、`features` 和 `facade` 均指 `src/main/` 下的对应目录；`features/<feature>/contract` 和 `features/<feature>/implementation` 是每个 feature 的契约面和实现面。

`core/infra`、`core/adapters` 和 `main/index` 的具体技术依赖集合，以及 renderer 可以使用的前端展示库集合，分别由 `tests/architecture/` 中的显式允许集合维护。骨架文档只规定它们的依赖类别和边界。

```text
domain         → （无项目模块依赖）
core/infra     → 技术依赖
core/adapters  → domain + 技术依赖
features/<feature>/contract → domain
features/<feature>/implementation → own contract + domain + core/infra
facade         → features/<feature>/contract + domain + shared/types
shared         → domain（仅用于契约复用或类型转出）
preload        → shared + electron
renderer       → shared + 允许的前端展示库
main/ipc       → facade + shared + electron
main/index     → `src/main/` 下的其他运行时模块 + features/<feature>/implementation + domain + shared + 技术依赖（唯一组合根）
```

额外边界：

- `features` 不直接 import 其他 feature。
- `features` 不直接 import `core/adapters`；平台协议适配由组合根接线，或通过 domain 端口提供给 feature。
- 同一 feature 的 implementation 文件可以相互 import；implementation 不得 import 其他 feature 的 contract 或 implementation。
- feature contract 不得 import implementation、其他 feature、`facade`、`shared`、Electron 或 Node；跨进程结果由 `facade` 组装为 `shared/types`。
- 只有 `main/index.ts` 可以 import `features/<feature>/implementation` 并调用其中的创建入口；factory 的名称和实现形式不参与架构判断。
- `facade` 只能 import `features/<feature>/contract`，不调用 feature factory 或 constructor，不实例化 feature 实现，不直接接触数据库、迁移器或其他基础设施实现。
- `renderer` 通过 `preload` 暴露的桥接访问主进程能力，不直接 import 主进程、domain、Electron 主进程模块或 Node 后端模块。
- `shared` 可以携带平台字段，但这些字段不得进入 `domain`。
- `main/index` 不 import `preload` 或 `renderer`；两者由应用运行时分别加载。

## 落地顺序

以下顺序按依赖关系组织实现。每次变更只处理涉及的层，复用已有且符合规范的模块。

1. **定义 domain**：在 `domain` 中定义所需的领域类型、端口和纯业务规则。
2. **定义 shared 契约**：在 `shared` 中定义跨进程契约和 IPC 常量，按需复用或转出 domain 类型。
3. **实现 core**：在 `core/infra` 中实现基础设施，在 `core/adapters` 中实现平台协议适配与 domain 端口。
4. **实现 features**：为各 feature 划分对外契约面和实现面，在实现面完成能力流程、数据访问与事务管理，遵守 feature 隔离及端口注入规则。
5. **实现 facade**：只依赖 feature 对外契约，基于已创建的 feature 能力实现跨能力编排和契约结果组装。
6. **装配与接入**：由 `main/index.ts` 完成实例创建与依赖注入；由 `main/ipc.ts` 注册通道并转发到 facade；preload 暴露约定的桥接接口，renderer 通过该接口消费契约。
7. **验证边界**：在对应测试分区验证实现，通过类型检查和相关测试；在 `tests/architecture/` 验证所有模块级依赖、维护技术依赖与 renderer 展示库的允许集合，并验证依赖白名单。

完成条件：代码归属符合目录骨架，依赖符合白名单，组合根是唯一组装入口，类型检查与相关测试通过。
