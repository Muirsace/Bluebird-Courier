# 架构骨架测试

本目录是 `docs/agents/skeleton.md` 的可执行护栏。它长期检查 `src/` 是否遵守规范规定的目录归属、依赖白名单、模块边界和跨进程契约。

测试只依赖规范中的目录角色和依赖关系，不依赖具体业务模块名称、业务字段或产品行为。新增业务模块只要落在规范允许的位置并遵守允许的依赖方向，就可以直接纳入检查。

## 测试范围

### 目录结构

结构检查验证以下稳定入口和目录边界：

- `domain/types.ts`、`domain/ports.ts`
- `shared/types.ts`、`shared/ipc.ts`
- `main/index.ts`、`main/ipc.ts`
- `preload/index.ts`
- `domain/rules/`
- `main/core/infra/` 和 `main/core/adapters/`
- `main/features/<feature>/contract/` 和 `implementation/`
- `main/facade/`
- `renderer/pages/`、`renderer/components/` 和 `renderer/lib/`

feature 名称和 feature 数量不固定，也不要求没有业务代码时预先创建空目录。入口文件必须位于规定的直接路径，未登记的目录位置会被报告。

### 依赖白名单

依赖分析把以下形式视为同一种模块依赖：

- `import` 和 `import type`
- re-export
- 动态 `import()`
- `require()`

相对资源文件（例如 CSS、SVG）不作为 TypeScript 模块依赖。无法静态解析的动态模块路径会被拒绝，不能绕过白名单。

技术依赖采用精确字符串匹配。`react` 和 `react/jsx-runtime` 是两个独立条目，子路径不会因为根包已登记而自动放行。

### 层间边界

测试验证文档规定的依赖方向和所有权：

- feature 之间不能直接 import。
- feature 不能直接依赖 `core/adapters`。
- feature contract 只能依赖 domain 和同一 feature 的 contract。
- feature implementation 只能依赖自身 contract、domain 和 `core/infra`。
- facade 不能依赖 feature implementation 或基础设施实现。
- 只有 `main/index.ts` 可以 import feature implementation。
- `main/index.ts` 不能依赖 preload 或 renderer。
- renderer 不能依赖 domain、main、preload 或 Electron 主进程模块。

### 跨进程契约

测试对静态可观察的契约进行检查：

- preload 只能通过 `contextBridge` 暴露 `window.bluebirdCourier`。
- preload 不能直接暴露 Electron IPC 对象、通用 Electron 能力或任意 IPC 通道。
- 受限的固定通道包装可以调用 `ipcRenderer.invoke`。
- renderer 不能直接使用 `ipcRenderer`、`ipcMain` 或 `contextBridge`。
- `main/ipc.ts` 注册通道时必须使用从 `shared/ipc.ts` 导入的通道常量。
- facade 只能把 `shared/types.ts` 作为 shared 结果契约来源。

## 文件说明

- `policy.ts`：依赖白名单、层间允许关系和技术依赖集合。
- `analyzer/classifier.ts`：源码文件分类和目录结构检查。
- `analyzer/scanner.ts`：静态 import、export、动态 import 和 require 扫描。
- `analyzer/resolver.ts`：相对路径、别名、外部包和资源依赖解析。
- `analyzer/boundaries.ts`：feature、facade、组合根和 renderer 边界检查。
- `analyzer/contracts.ts`：preload、renderer、main/ipc 和 facade 契约检查。
- `structure.test.ts`：目录结构规则及通用正反例。
- `dependencies.test.ts`：依赖方向和技术依赖白名单规则。
- `boundaries.test.ts`：所有权和进程边界规则。
- `contracts.test.ts`：跨进程契约规则。
- `repository-gate.test.ts`：将全部规则应用到真实 `src/` 的仓库门禁。

fixture 通过 `test-utils.ts` 创建临时 `src/` 树，不把故意非法的源码写入项目本身。`fixtures/` 目录只记录 fixture 分类说明。

## 技术依赖集合维护

以下集合默认为空：

- `coreInfraTechnicalDependencies`
- `coreAdapterTechnicalDependencies`
- `mainIndexTechnicalDependencies`
- `rendererPresentationLibraries`

当规范允许某个技术依赖时，在 `policy.ts` 中登记完整的 import specifier，并同时增加“登记后允许”和“相近但未登记仍拒绝”的测试。不要通过放宽前缀匹配来规避违规。

## 运行测试

先运行类型检查：

```text
npm run typecheck
```

只运行架构规则和通用 fixture（不执行仓库门禁）：

```text
node --require ./tools/compat/no-pipe-spawn.cjs ./node_modules/vitest/vitest.mjs run tests/architecture --exclude tests/architecture/repository-gate.test.ts
```

运行包含真实仓库门禁的完整架构测试：

```text
node --require ./tools/compat/no-pipe-spawn.cjs ./node_modules/vitest/vitest.mjs run tests/architecture
```

`repository-gate.test.ts` 是仓库级门禁，必须与类型检查和相关测试一起通过。门禁报告的每一项违规都应通过调整源码归属、依赖关系或明确维护技术依赖集合来解决，不应跳过门禁。

## 测试边界

这些测试验证目录、模块依赖、边界和静态契约，不验证业务运行结果，也不试图通过脆弱的 AST 启发式判断“某个函数是否包含业务逻辑”。组合根是否真的完成实例创建和注入、adapter 是否正确转换平台响应、feature 是否正确处理事务等内容，属于对应实现测试的范围。

文档 `docs/agents/skeleton.md` 是规范来源。本目录中的策略代码是它的执行投影；当文档发生有意变更时，应同步更新策略、通用正例、通用反例和仓库门禁。
