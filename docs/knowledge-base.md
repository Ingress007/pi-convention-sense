# pi-convention-sense 项目知识库

本文是仓库的人类与 Agent 共用入口，用于快速理解产品边界、架构、不可破坏约束、变更路径和验证要求。详细需求、设计和历史结论仍以链接文档为准。

## 1. 当前基线

| 项目 | 当前值 |
|---|---|
| 开发版本 | `0.4.0-alpha.1`，未发布 |
| Node.js | `>=22.19.0` |
| Pi | 当前开发与真实生命周期验证基线 `0.87.1`；peer dependency `*` 不代表全版本兼容 |
| TypeScript | `5.9.3`，strict + NodeNext |
| 自动测试 | `npm run verify`，56/56 |
| 真实 Pi 基线 | Pi `0.87.1`，SnailJob/SnailAI 主流程已验证 |
| Project Profile | `.convention-sense/profile.json` |
| Profile fingerprint | `f806157678d37814` |
| Profile review | `draft`；不得宣称 reviewed |
| 默认运行模式 | `observe` + fail-open |
| Guard | experimental opt-in |
| 真实业务验收 | SnailJob Job Tag CRUD v2 已通过编译/前端检查，修改保留未提交 |
| 环境限制 | SnailAI Admin 缺少 `node_modules`，原生检查为 `ENVIRONMENT_BLOCKED` |

## 2. 产品定位

pi-convention-sense 为 Pi Coding Agent 提供基于真实仓库证据的局部编码惯例感知：

1. Agent 成功读取目标源码；
2. Extension 在目标 Git repository 内识别语言、模块和角色；
3. Candidate Finder 选择同仓库、同模块、同角色的可比实现；
4. Analyzer 提取重复事实并生成有 token 预算的 Snapshot；
5. Snapshot 与目标相关的 Knowledge Capsule 在下一轮 Context 注入；
6. 可选 Guard 只检查必要 Discovery 是否完成，不直接执行风格审查。

正常运行链路是确定性的本地代码，不调用第二个 LLM。Project Profiler Skill 可以显式使用当前 Agent 生成待审核 Profile candidate。

### 不做什么

- 不自动重构历史代码；
- 不因单个 Snapshot 创建长期项目规则；
- 不自动修改 `AGENTS.md` 或把 draft 升级为 reviewed；
- 不把 Global Pack 当作项目硬规范；
- 不跨 Git repository 复用候选、Snapshot 或 Profile trust；
- 不判断业务语义、架构质量或方法拆分是否合理；
- 当前不支持小程序、移动端、React Native、UniApp 和桌面端。

## 3. 架构地图

| 路径 | 职责 | 修改时重点检查 |
|---|---|---|
| `extensions/index.ts` | Pi Extension 入口，生命周期、命令和各子系统接线 | 事件顺序、状态恢复、日志隐私、Context 注入、重启要求 |
| `src/runtime/` | 配置、路径、状态、checkpoint、Context、日志和状态栏 | trust、branch-local 状态、v1/v2/v3 兼容、敏感数据 |
| `src/observe/` | repository root、语言分析、Scope、候选、Evidence、Snapshot | repository 隔离、generated/test 排除、预算和 freshness |
| `src/guard/` | Guard 决策、工具映射、Git 后置审计 | 只阻断 Discovery、fail-open、bypass 精确消费 |
| `src/profile/` | Profile 加载、校验、Pack、选择器、解析和 Capsule | trust gate、schema、fingerprint、draft 降级、token 预算 |
| `skills/project-profiler/` | Profile init/adopt/refresh/diff 工作流 | candidate-first、显式批准、禁止覆盖 active Profile |
| `scripts/` | 可复用真实仓库评估工具 | 输出必须写入 `.tmp/pi-convention-sense/` |
| `test/` | Node 自动测试和固定 fixtures | 不依赖用户机器上的外部仓库或运行日志 |
| `docs/` | 需求、设计、研究、规范和永久评估结论 | 当前事实与历史结果分开记录 |
| `examples/` | 可复制配置与 Stage 0 历史示例 | 当前配置放 `examples/config/` |

### 3.1 主要依赖方向

```text
extensions/index.ts
  ├─ src/runtime
  ├─ src/observe
  ├─ src/guard
  └─ src/profile

src/guard ──> src/observe types / src/runtime types
src/profile ──> profile types + scoped observe types
src/observe ──> optional Profile resolution
```

`extensions/index.ts` 应主要负责编排；确定性分析和决策逻辑应留在 `src/` 中并可独立测试。

## 4. 运行时生命周期

### Session 启动

- 从 Pi 启动仓库读取受信配置；
- 加载同一启动仓库的 Project Profile；
- 从当前 Session Branch 的最新兼容 checkpoint 恢复状态；
- 建立 logger、analyzer、Snapshot cache、Guard runtime 和 Git audit baseline。

### Tool 执行

- `tool_call` 只登记 pending/read/mutation 意图；
- 只有成功 `tool_result` 才能进入 read ledger；
- write/edit 在 Guard 模式下先进行 Discovery gate；
- Shell 工具使用执行前 Git baseline 和执行后真实 diff 审计；
- 第三方工具必须通过受信配置声明映射。

### Context 注入

- 稳定原则由 `before_agent_start` 写入 `systemPromptOptions.sections["pi-convention-sense"]`；
- 动态 Snapshot 与 Knowledge Capsule 使用 custom Context message；
- 同一 Scope 不重复注入；
- Profile、Pack、Evidence 或配置 fingerprint 变化会使旧 Snapshot stale。

### Session/Branch

- checkpoint 类型名保留历史 `pi-convention-sense-spike-state` 以兼容旧 Session；
- v1/v2 会迁移为当前 v3 运行态；
- `/tree` 或 Branch 切换只从该 Branch 重建；
- `/convention-reset confirm` 清空当前 Branch 状态并追加空 checkpoint。

## 5. 不可破坏的安全约束

### 5.1 Guard 只约束 Discovery

允许阻断的核心缺口：

- `TARGET_NOT_READ`；
- `SNAPSHOT_MISSING`；
- `SNAPSHOT_STALE`；
- `SNAPSHOT_NOT_INJECTED`。

必须 fail-open 的典型场景：unsupported、excluded、scope unknown、analysis error、low confidence、weak/mixed evidence、no peer、insufficient peer。Guard 不得因为代码未遵循某种风格直接阻断。

### 5.2 仓库与信任隔离

- 目标文件决定 Candidate Finder 使用的 Git repository root；
- Profile 只按 Pi 启动仓库加载；
- 从仓库 A 读取仓库 B 时，B 的候选仍限制在 B，但 B 的 Profile 为 `ignored`；
- 要加载 B 的 Profile，必须从 B 根目录显式批准并启动新的 Pi。

### 5.3 三层项目知识

```text
Global Pack（永远 advisory）
        ↓
Project Profile / Knowledge（可审核）
        ↓
Local Evidence（当前 Scope 的真实代码事实）
```

优先级还必须服从用户明确要求以及编译器、类型系统、lint、测试和安全约束。Draft Profile 中的 hard 项运行时降级为 advisory。

### 5.4 日志隐私

允许记录事件名、工具名、规范化路径、计数、reason code、fingerprint、耗时和状态。禁止记录：

- 源码正文；
- edit/write 正文；
- 完整 prompt；
- 完整 Shell 命令；
- 未脱敏密钥和凭据。

## 6. 配置和持久化路径

| 路径 | 是否提交 | 说明 |
|---|---:|---|
| `.pi/settings.json` | 是 | 本仓库开发时加载当前 Pi package |
| `.pi/convention-sense.json` | 可选 | 目标项目共享运行配置 |
| `.convention-sense/profile.json` | 是 | 当前仓库 active Project Profile |
| `.convention-sense/profile.candidate.json` | 否 | Profiler 审核中间文件 |
| `.pi/convention-sense/` | 否 | 本地日志和运行状态 |
| `.tmp/pi-convention-sense/` | 否 | 一次性评估、研究和调试产物 |
| `dist/` | 否 | TypeScript 可重建输出 |
| `docs/evaluations/` | 是 | 经审阅的永久评估结论 |

## 7. 常见变更路径

### 修改 Observe 或新增语言/框架 Adapter

1. 更新语言事实分析、Scope detector、Candidate ranker 和 Evidence builder；
2. 保持 repository/module/role 隔离；
3. 添加正例、反例、generated/test 和 prospective fixtures；
4. 验证 token budget 与 freshness；
5. 按[贡献规范](contributing-adapters-and-packs.md)补充真实项目评估。

### 修改 Guard

1. 先定义 reason code；
2. 证明阻断的是可完成的 Discovery 缺口；
3. 为 weak/error/no-peer 提供 fail-open；
4. 覆盖 Observe shadow、正式 Guard、bypass 和 post-change 测试；
5. 不把 Profile/Pack 风格差异升级为阻断。

### 修改 Profile/Pack

1. Profile schema 与 runtime loader 同步；
2. selector 只能使用声明式白名单字段；
3. fingerprint 必须覆盖影响 Snapshot freshness 的内容；
4. draft hard 和 Global Pack hard 必须降级；
5. Profile 更新走 candidate → validate → diff → approve → adopt。

### 修改 Extension 生命周期

1. 查阅当前 Pi `0.87.1` Extension API；
2. 覆盖独立 Session、Branch、Context 和 tool result 顺序；
3. 真实 Pi 验证后再扩大兼容声明；
4. 提醒用户重启 Pi 才能加载 Extension 代码变化。

## 8. 验证与发布门槛

### 8.1 当前真实项目结论

SnailJob 后端与 Admin 已完成 Profile、Pack、Local Evidence、Observe、Guard、Session/Branch/reset、跨仓库信任和隐私验证；并在真实 `master` 分支完成 Job Tag Management CRUD v2 业务开发验收。该修改未创建 commit，保留给人工审查。后端 compile、Admin typecheck/build、六种数据库方言审查和 `git diff --check` 均通过，namespace 由服务端会话推导。

SnailAI 后端与 Admin 已完成静态分析和 Pi 主流程回归。SnailAI Admin 因缺少 `node_modules` 未执行原生 typecheck、lint、format、build，分类为环境限制而非产品缺陷；本轮未安装依赖或修改 lockfile。

永久报告： [SnailJob 验收](evaluations/snail-job-pi-0.87.1-results.md)、[SnailAI 验收](evaluations/snail-ai-pi-0.87.1-results.md)、[发布就绪评估](evaluations/release-readiness-results.md)。原始证据保留在 `.tmp/pi-convention-sense/`，不纳入版本控制。

日常完整验证：

```bash
npm run verify
npm pack --dry-run
```

当前 `npm run verify` 包括：

- strict TypeScript `--noEmit`；
- 清理并构建 `dist/`；
- Node test runner 的 56 个测试。

提交前还应执行：

- `git diff --check`；
- Markdown 相对链接检查；
- JSON 解析和 Profile validate；
- package 内容断言；
- 临时目录、日志、密钥和大文件检查。

版本兼容和未验证环境见[兼容性与验证矩阵](compatibility.md)。扩大 Pi、Node 或 OS 支持范围前必须加入 CI 并运行真实 Pi 生命周期。

## 9. 决策与文档索引

| 主题 | 文档 |
|---|---|
| 产品范围与验收 | [产品需求](requirements.md) |
| 系统设计与数据流 | [技术设计](design.md) |
| Profile、Pack、Knowledge Capsule | [Project Intelligence](project-intelligence.md) |
| Adapter/Pack 开源贡献规范 | [贡献与测试规范](contributing-adapters-and-packs.md) |
| 永久/运行时/临时文件 | [文件生命周期](file-lifecycle.md) |
| 兼容声明和发布门槛 | [兼容性矩阵](compatibility.md) |
| Stage 0/1/2 历史 | [Spike](stage-0-spike.md)、[Observe](stage-1-observe.md)、[Guard](stage-2-guard.md) |
| 真实全栈证据 | [SnailJob 全栈验证](evaluations/snail-job-fullstack-results.md) |
| SnailJob Pi 验收 | [SnailJob Pi 0.87.1 结果](evaluations/snail-job-pi-0.87.1-results.md) |
| SnailAI Pi 验收 | [SnailAI Pi 0.87.1 结果](evaluations/snail-ai-pi-0.87.1-results.md) |
| 发布就绪评估 | [发布就绪结果](evaluations/release-readiness-results.md) |
| 双项目测试计划与执行记录 | [SnailJob 与 SnailAI 全场景测试计划](evaluations/snail-job-snail-ai-test-plan.md) |
| 版本变化 | [更新日志](../CHANGELOG.md) |
| Agent 工作规范 | [AGENTS.md](../AGENTS.md) |

## 10. 更新本知识库

出现以下变化时同步更新本文：

- 目录或核心依赖方向改变；
- Guard 阻断语义、fail-open 边界或日志隐私改变；
- Profile schema、Pack 规则或信任边界改变；
- Node/Pi/OS 兼容范围改变；
- 自动测试数量和发布门槛发生实质变化。

代码中的可执行检查始终优先于本文。如果文档与实现不一致，应先通过测试和真实运行确认，再同时修正文档与 Profile；不得为了让文档“正确”而隐藏实现差异。
