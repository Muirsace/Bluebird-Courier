# 代码骨架

本文规定 `src/` 与 `tests/` 的长期代码骨架。所有代码增删改均须遵守本规范。

本文不规定具体业务功能、接口字段、数据库表结构、页面内容或运行时产品行为。业务模块在本骨架内自行落位。

五层分别规定：结构确定路径，职责确定工作，依赖确定导入关系，边界限定文件内容与创建权，契约规定对外接口。同一规则只在所属层定义。

## 一、结构

以下路径均相对于仓库根目录。`<feature>` 表示单个业务能力。目录树不预先指定具体业务模块，`...` 表示按需增加文件或子目录。

```text
src/                                      # 固定源码根目录

├─ domain/                                # 固定入口加开放扩展区
│  ├─ types.ts                            # 固定入口
│  ├─ ports.ts                            # 固定入口
│  └─ rules/                              # 开放扩展区
│
├─ shared/                                # 封闭目录：固定文件集合
│  ├─ types.ts                            # 固定入口
│  └─ ipc.ts                              # 固定入口
│
├─ main/                                  # 主进程根目录
│  ├─ index.ts                            # 固定入口
│  ├─ ipc.ts                              # 固定入口
│  ├─ core/                               # 受限目录
│  │  ├─ infra/                           # 开放扩展区
│  │  │  └─ ...                           # 按需增加文件
│  │  └─ adapters/                        # 开放扩展区
│  │     └─ ...                           # 按需增加文件
│  ├─ features/                           # 开放扩展区
│  │  └─ <feature>/                       # feature 目录
│  │     ├─ contract/                     # 受限扩展区
│  │     │  └─ ...                         # 按需增加文件
│  │     └─ implementation/               # 受限扩展区
│  │        └─ ...                         # 按需增加文件
│  └─ facade/                             # 受限扩展区
│     └─ facade.ts                        # 固定入口
│
├─ preload/                               # 固定入口加受限辅助
│  ├─ index.ts                            # 固定入口
│  └─ *.ts                                # 受限扩展区
│
└─ renderer/                              # 开放扩展区
   ├─ pages/                              # 开放扩展区
   ├─ components/                         # 开放扩展区
   └─ lib/                                # 开放扩展区

tests/                                    # 测试根目录
```

固定入口文件为 `src/domain/types.ts`、`src/domain/ports.ts`、`src/shared/types.ts`、`src/shared/ipc.ts`、`src/main/index.ts`、`src/main/ipc.ts`、`src/main/facade/facade.ts` 和 `src/preload/index.ts`。

固定入口不得增加同类替代文件；开放扩展区允许增加同类文件；受限扩展区只能增加该目录职责范围内的文件。除 `src/preload/index.ts` 外，preload 辅助文件只能是 `src/preload/` 的直接子级 TypeScript 文件。

`src/domain/` 只允许固定的 `types.ts`、`ports.ts` 和 `rules/`；domain 扩展仅限 `rules/`。

`src/shared/` 是封闭目录，只能包含 `types.ts` 和 `ipc.ts`；不得增加其他直接文件、子目录或替代入口。

feature 仅在 `contract/` 和 `implementation/` 均存在、各自至少包含一个 TypeScript 文件，且 `implementation/` 包含符合以下条件的创建入口时视为已实现：创建入口是 implementation 文件导出的可调用函数值；`src/main/index.ts` 通过静态 named import 或 default import 获取该值，并直接以函数调用表达式调用该值。namespace import、间接转存、动态 import 和 `new` 不构成创建入口。

## 二、职责

| 代码层 | 负责的工作 |
|---|---|
| `domain` | 定义领域类型、领域端口和纯业务规则 |
| `core/infra` | 提供基础设施能力，包括数据库、迁移器、加密、时钟和日志 |
| `core/adapters` | 适配外部平台协议，实现领域端口并转换平台响应 |
| `features` | 实现单个业务能力，负责流程、数据访问和事务 |
| `facade` | 提供用例入口，编排跨 feature 协作并组装对外结果 |
| `shared` | 定义跨进程数据契约和 IPC 通道常量 |
| `preload` | 通过约定桥接接口暴露主进程能力 |
| `renderer` | 实现页面、组件、展示映射、格式化和图表配置 |
| `main/ipc` | 注册 IPC 通道并转发调用 |
| `main/index` | 创建实例、注入依赖并完成主进程接线 |

## 三、依赖

`A → B` 表示 A 可以直接导入 B；`+` 表示同时允许多个目标；`∅` 表示无项目模块依赖。未列出的项目模块依赖默认禁止，允许导入不自动允许反向或传递导入。

```text
domain                             → domain
core/infra                         → core/infra + infra-tech
core/adapters                      → core/adapters + domain + adapter-tech
features/<feature>/contract        → own-contract + domain
features/<feature>/implementation  → own-implementation + own-contract + domain + core/infra
facade                             → facade + feature-contract(*) + domain + shared/types
shared/types.ts                    → shared + domain
shared/ipc.ts                      → ∅
preload                            → preload + shared + electron
renderer                           → renderer + shared/types + renderer-libs(*)
main/ipc                           → facade + shared + electron
main/index                         → main-runtime(*) + feature-implementation(*) + domain + shared + main-tech
```

`own-*` 表示当前 feature，`feature-*` 表示所有 feature，`main-runtime(*)` 表示 `src/main/` 下除 `main/index.ts`、所有 `features/<feature>/contract/` 和所有 `features/<feature>/implementation/` 之外的运行时模块。`infra-tech`、`adapter-tech`、`main-tech` 和 `renderer-libs(*)` 表示按来源层维护的外部依赖集合。

每个来源层只能使用其依赖关系中列出的外部依赖。技术依赖集合按来源层分别维护；未列入该来源层技术依赖集合的外部包默认禁止，未声明外部依赖的来源层不得导入外部包。`electron` 是依赖表明确列出的固定平台依赖，不属于可扩展技术依赖集合。

`A → A` 表示 A 内不同模块之间允许同层导入，不包含当前文件自导入。固定单文件入口不得导入自身；该规则优先于同层依赖关系。`main/index.ts` 和 `main/ipc.ts` 的同层辅助关系由 `main-runtime(*)` 或对应开放扩展区表示。

这些关系适用于 `src/` 下的所有模块级源码依赖，包括静态 `import`、`import type`、re-export、动态 `import()` 和 `require()`。模块路径必须可静态解析；无法静态解析的动态路径不属于允许依赖。项目模块依赖图不得存在循环依赖；类型依赖、重导出、动态依赖和 `require()` 同样计入循环判定。

## 四、边界

本节规定各路径的关键边界，包括文件职责、创建权、对外暴露和语义范围；源码导入关系按第三层判定。

### 1. domain

| 范围 | 关键边界 |
|---|---|
| `src/domain/types.ts` | 领域类型 |
| `src/domain/ports.ts` | 领域端口声明 |
| `src/domain/rules/` 内的文件 | 纯业务规则 |

domain 保持零平台依赖、零 I/O。

### 2. core/infra

| 范围 | 关键边界 |
|---|---|
| `src/main/core/infra/` 内的文件 | 可复用的基础设施能力及其技术实现；基础设施能力不包含业务规则；对外导出面不得暴露具体技术类型 |

core/infra 提供的基础设施能力必须可替换。替换技术实现时，domain、feature contract、feature 流程和 facade 的业务契约不应因技术实现变化而改变；实现的选择和注入由 `main/index` 完成。

### 3. core/adapters

| 范围 | 关键边界 |
|---|---|
| `src/main/core/adapters/` 内的文件 | 平台协议处理、协议层判断、平台响应转换和领域端口实现；协议适配不定义业务规则，平台字段在转换后不进入 domain 类型 |

### 4. features

| 范围 | 关键边界 |
|---|---|
| `src/main/features/<feature>/contract/` 内的文件 | 单个 feature 的对外接口与类型 |
| `src/main/features/<feature>/implementation/` 内的文件 | 单个 feature 的流程、数据访问、事务管理及创建入口；创建入口必须符合结构层规定的导出、静态导入和直接调用形式 |

每个 feature 拥有自己的事务。跨 feature 协作由 facade 编排，或通过注入的 domain port 完成。

### 5. facade

| 范围 | 关键边界 |
|---|---|
| `src/main/facade/` 内的文件 | 用例入口、对已创建 feature 的编排及对外结果组装 |

facade 不负责基础设施接线，不创建 feature，不实现业务规则。

### 6. shared

| 范围 | 关键边界 |
|---|---|
| `src/shared/types.ts` | 跨进程契约与对外结果类型 |
| `src/shared/ipc.ts` | IPC 通道常量 |

### 7. preload

| 范围 | 关键边界 |
|---|---|
| `src/preload/index.ts` | 唯一组装并通过 `contextBridge` 暴露 `window.bluebirdCourier` 的文件 |
| `src/preload/*.ts`（除 `index.ts`） | 只能包含桥接方法包装、IPC 参数转换和结果转换；只能通过 `ipcRenderer.invoke` 调用 `src/shared/ipc.ts` 导出的通道常量 |

preload 辅助文件不得调用 `contextBridge.exposeInMainWorld`，不得定义 IPC 通道、暴露通用 Electron 能力或实现业务规则。

### 8. renderer

| 范围 | 关键边界 |
|---|---|
| `src/renderer/pages/` 内的文件 | 页面与展示交互 |
| `src/renderer/components/` 内的文件 | 展示组件 |
| `src/renderer/lib/` 内的文件 | 展示映射、格式化、图表配置与展示辅助 |

展示层不实现业务规则。

### 9. main/ipc

| 范围 | 关键边界 |
|---|---|
| `src/main/ipc.ts` | IPC 通道注册、参数转发和结果返回 |

### 10. main/index

| 范围 | 关键边界 |
|---|---|
| `src/main/index.ts` | 基础设施与端口实现的创建、feature 实现的创建、facade 的创建、依赖注入及主进程接线 |

`src/main/index.ts` 是唯一组合根。feature 创建入口只能由这里通过结构层规定的形式调用；domain port 的具体实现由这里创建并注入 feature。preload 和 renderer 由应用运行时分别加载。

## 五、契约

本节规定接口内容和交互方式，具体字段与业务行为由业务模块定义。

| 契约 | 规定 |
|---|---|
| 领域类型与端口 | 使用领域数据表达；平台字段不得进入 domain 类型 |
| feature 对外接口 | 表达单个业务能力；跨 feature 协作可以由 facade 编排，也可以通过注入的 domain port 完成 |
| 跨进程结果 | 由 facade 组装为 `shared/types`；shared 可以复用或转出领域类型，也可以携带平台字段 |
| IPC 通道 | 所有 IPC 通道标识只能在 `src/shared/ipc.ts` 中定义并导出；`main/ipc.ts` 的注册和 preload 的调用只能引用这些常量 |
| 渲染进程桥接 | `BluebirdCourierBridge` 必须由 `src/shared/types.ts` 定义并导出；`preload/index.ts` 按该接口实现并暴露为 `window.bluebirdCourier`；renderer 只能通过该接口访问主进程能力；接口不包含通用 Electron 能力或任意 IPC 通道 |

## 落地顺序

每次变更只处理涉及的层，复用已有且符合规范的模块。

1. 定义领域类型、端口与纯业务规则。
2. 定义跨进程契约与 IPC 通道常量。
3. 实现基础设施、平台协议适配与领域端口。
4. 定义 feature 对外接口，实现流程、数据访问与事务管理。
5. 基于已创建的 feature 实现 facade 编排与结果组装。
6. 在组合根创建实例并注入依赖；注册 IPC 通道，暴露 preload 桥接，由 renderer 消费契约。
7. 执行类型检查和相关测试。

## 完成条件

以下条件必须全部满足：

- 文件归属符合第一层结构；
- 实现内容与创建权符合第四层边界；
- 所有模块级源码依赖符合第三层关系；
- 对外接口符合第五层契约；
- 类型检查通过。
