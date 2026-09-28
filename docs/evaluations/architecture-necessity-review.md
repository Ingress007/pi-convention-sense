# 整体架构必要性审查

> 审查日期：2026-09-25
> 产品版本：`0.4.0-alpha.1`（未发布）
> 基线：Guard 生产准入完成，Engineering Practice P1 Advisory MVP 完成
> 范围：当前生产架构、P1 新增组件及其与 Extension、Context、Observe、Guard、Profile 的耦合

## 1. 结论

当前架构与产品目标相称，可以保留；没有发现为了 P1 而必须保留的冗余 Runtime、缓存、持久化、schema、生命周期 hook、策略引擎或第二个模型。

P1 应停留在当前边界：

```text
successful read
  -> branch-local Snapshot
  -> deterministic Practice analysis
  -> shared Context budget
  -> advisory Capsule
```

本轮删除了已经确认没有调用方或运行价值的外部字段，没有为了“架构完整”新增独立 Resolver、Practice Runtime、缓存层或 token allocator。P2 `auto-once` 可以进入设计/实现，但必须作为 opt-in 独立增量；不能把 Review 状态塞进 Guard，也不能提前扩展 Profile schema。

## 2. 子系统必要性

| 子系统 | 必要性结论 | 原因与边界 |
| --- | --- | --- |
| `extensions/index.ts` | 保留 | Pi 生命周期、工具事件和命令只能在 Extension 入口接线；分析和决策仍放在 `src/`。P1 只复用既有 `context` hook，没有新增 hook。 |
| `src/runtime/config.ts` | 保留 | `off/suggest` 与独立上限是用户控制和安全回退所需；只有两个 P1 字段，没有单独配置框架。 |
| `src/runtime/context.ts` | 保留并继续作为唯一预算所有者 | Knowledge Capsule、Local Snapshot、Practice Capsule 必须在同一处决定顺序与总预算，避免三个子系统各自声称预算。 |
| `src/runtime/state.ts` / checkpoint | 保留原状 | read、mutation、Guard 和 Branch 恢复已有状态价值；P1 没有增加 Practice 持久状态。 |
| `src/observe/` | 保留 | Snapshot 是目标已读、repository/Scope/Branch 隔离和候选证据的唯一来源；Practice 不重复实现 discovery。 |
| `src/guard/` | 保留且不接入 Practice | Guard 的不可替代职责是阻断可补救 Discovery 缺口。Practice 不导入 Guard，Guard 也不导入 Practice。 |
| `src/profile/` | 保留原 schema | reviewed 项目知识已有 trust、selector 和 Capsule 机制；P1 复用该机制，不需要 `practices` schema。 |
| `src/practice/types.ts` | 保留 | 为稳定 Signal id、结构 facts、reason 和有界 Capsule 提供明确契约；不包含 Review 状态机。 |
| `src/practice/signal-analyzer.ts` | 保留 | 隔离有界文件读取、源码清洗、确定性触发与 fail-open；不依赖 Git diff、parser、模型或仓库索引。 |
| `src/practice/capsule-formatter.ts` | 保留 | relevance、置信度过滤、稳定排序、去重、XML escaping 和结构完整的 token 裁剪不同于 Signal 检测，独立测试有价值。 |
| 日志与 `/convention-status` | 保留 | 默认开启的 advisory 能力必须可观察、可关闭；只记录 id、计数、reason、预算和耗时。 |
| 自动测试与 disposable 评估 | 保留 | 词法启发式无法只靠类型检查证明低干扰；真实仓库触发密度和隐私需要独立证据。 |

## 3. 组件关系

当前依赖方向为：

```text
Pi lifecycle
  -> Extension orchestration
      -> Observe Snapshot
      -> Practice analyzer
      -> Context composer
          -> Profile Capsule formatter
          -> Snapshot formatter
          -> Practice Capsule formatter

Extension mutation path
  -> Guard Runtime / post-change audit
```

关键性质：

- `src/guard/` 没有 Practice 引用；
- `src/profile/` 没有 Practice schema 或引用；
- checkpoint/state 没有 Practice 字段；
- `agent_before_settle` 尚未注册；
- package 没有新增生产依赖；
- Practice 分析结果只在当前 `context` 调用内存活；
- Session/Branch 隔离由 branch-local read ledger 和 Snapshot 重建继承，不存在跨 Branch Practice cache；
- repository 隔离由目标 Snapshot 的 repository root 继承，不建立跨仓库索引。

该关系避免形成 `Practice -> Guard`、`Guard -> Practice` 或 `Profile -> Runtime Review` 循环。

## 4. 本轮实际简化

架构审查不是只写结论。本轮从 P1 API 删除：

1. `PracticeAnalysisReason` 中从未产生的 `unsupported-language`；
2. `PracticeAnalysisResult.repositoryRoot`，该值已存在于实际 Signal，result 层重复；
3. `FormattedPracticeCapsule.includedTargetPaths`，没有决策或日志调用方；
4. `FormattedPracticeCapsule.truncated`，裁剪提示已在 Capsule 内部处理，外部没有调用方；
5. dynamic Context details 中对应的重复 Practice target path 列表。

同时增加 Session/Branch 隔离回归：切到没有 read checkpoint 的 Branch 后不再生成 Practice Capsule，恢复原 Branch 后重新从其 Snapshot 生成；新 Session 没有当前 Branch read evidence 时也不会继承 Capsule。

这些删除不改变用户可见 Signal、Capsule、预算、配置或日志语义。

## 5. 刻意不新增的组件

### 5.1 不新增独立 Resolver 类

P1 的 resolution 只有三步：

- Context 按实际已注入 Snapshot 过滤目标；
- formatter 丢弃 low confidence；
- formatter 稳定排序、去重并按预算选择。

这些规则分别属于 Context relevance 和 Capsule formatting。为其创建 stateful Resolver 或注册表只会增加跳转和测试表面。

### 5.2 不新增 Practice Runtime

`suggest` 没有跨事件状态机。分析是 `Snapshot -> AnalysisResult`，格式化是 `AnalysisResult[] -> Capsule`。在 P1 创建 Runtime 只会预先承载尚不存在的 `auto-once` 状态。

P2 若真实引入一次性继续、Branch-local generation 和防循环，届时才允许增加小型 `review-runtime.ts`。

### 5.3 不新增缓存

一次 Context 最多分析 4 个已活跃目标，每个文件上限 256 KiB；SnailJob 固定真实目标约 6 ms。当前没有证据表明缓存收益大于失效和 repository/Branch 隔离复杂度。

### 5.4 不引入 parser 或 AST 框架

P1 Signal 是 review prompt，不是合规结论。源码清洗、有界结构计数、低触发密度和 fail-open 已满足 advisory 目标。完整 Java/TypeScript parser 会显著增加依赖、语言分支和误配置面，当前证据不支持。

### 5.5 不扩展 Profile schema

现有 `knowledge` / `conventions` 已能承载审核后的工程原则。只有 P3 证明需要 selector-aware Practice trigger 时，才重新评估 `practices` schema。

### 5.6 不新增第二个模型或 policy engine

第二个模型违反正常链路约束，也增加成本、隐私和非确定性。可执行硬规则继续由编译器、lint、测试和 pi-lens 承担；Practice 只提出结构证据支持的问题。

## 6. 保留但受控的架构债务

### 6.1 Extension 入口较大

`extensions/index.ts` 约 900 行，是现有生命周期编排热点。但 P1 只增加一次 Context 分析和元数据记录；为这几十行立即拆分新的 orchestration layer 会扩大改动面。

约束：P2 若加入 `agent_before_settle`、generation、防循环和继续决策，Review 状态必须提取到 `src/practice/review-runtime.ts`，入口只做接线。

### 6.2 `ObserveConfig` / `SpikeConfig` 命名早于当前产品范围

配置现已覆盖 Guard、Profile 和 Practice，类型名偏窄；历史 `spike` 状态名还有兼容契约。当前重命名会产生广泛无行为价值的 churn，因此不在本轮处理。若未来发布前进行公共 API 整理，应作为单独迁移，不与 P2 混合。

### 6.3 词法 Signal 有表达上限

源码清洗不能等价于语义 parser，facts 也不能证明业务风险。控制措施是固定问题措辞、只选 production existing target、低触发密度、预算限制和 fail-open。P3 必须用人工认可率决定保留、收紧或删除 Signal，不得用更多正则掩盖低质量。

## 7. P2 准入约束

`auto-once` 实现前必须保持：

1. 用户显式 opt-in，默认仍为 `suggest`；
2. 只使用当前 Agent，不调用第二个 LLM；
3. generation Branch-local，每任务最多继续一次；
4. 没有重大 Signal、分析错误或信息不足时不继续；
5. 复用现有 mutation ledger 与 Git audit，不建立平行 diff tracker；
6. Review 不改变 Guard reason code、bypass 或放行结果；
7. 统一 Context 预算不变；
8. 真实 Pi 生命周期验证覆盖继续一次、无循环、Branch/Session 隔离和关闭模式；
9. P3 质量评估前不新增 Profile `practices` schema。

## 8. 验证

审查后的代码应满足：

- `npm run verify`：strict TypeScript、clean build、66/66 tests；
- LSP：changed TypeScript 无已报告诊断，silent-on-clean 仍不作为通过证据；
- `npm pack --dry-run`：无 test、`dist/`、日志和临时证据；
- `git diff --check`；
- Markdown 本地链接检查；
- SnailJob disposable worktree 已删除，源仓库原有未提交修改保持不变。

## 9. 最终判断

P1 的最小生产结构是：配置、确定性 analyzer、纯 formatter、共享 Context 编排和现有 Extension 接线。三者职责不重叠，且没有新增持久 Runtime。

因此本轮判断为 **通过，附 P2 约束**：当前组件均有明确不可替代职责；已删除无调用方字段；其余潜在组件必须等待 `auto-once` 或真实质量证据，不得预建。
