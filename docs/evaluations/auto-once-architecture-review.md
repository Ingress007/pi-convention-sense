# auto-once 后置整体架构复审

> 审查日期：2026-09-27
> 产品版本：`0.4.0-alpha.1`（未发布）
> 基线：Guard 生产准入、Practice P1 Advisory、P1 前置架构审查和 P2 auto-once 已完成
> 范围：Extension 生命周期、Runtime、Context、Observe、Guard、Profile、Practice、Git 审计和验证链路

## 1. 结论

P2 后的整体架构可以保留，结论为 **通过，已完成必要调整**。

最终数据流为：

```text
before_agent_start
  -> begin task-local generation

successful controlled mutation
  -> discard source body after relevance classification
  -> record normalized path + relevant/unknown/irrelevant

successful audited Shell mutation
  -> reuse existing Git post-change changed source paths
  -> record normalized path + unknown

agent_before_settle
  -> pure boundary planner
  -> refreshed target Snapshot
  -> deterministic Practice Signals
  -> bounded one-shot custom message
  -> current Agent continuation once
```

没有把 Practice 状态塞入 Guard、checkpoint、Profile 或 Context cache；没有新增第二个模型、parser、平行 Git tracker、独立 token allocator 或 Profile schema。

## 2. 复审中发现并修正的问题

### 2.1 错误预判 Pi `canContinue`

初版在追加 review draft 前检查 `event.context.canContinue`。真实 Pi 表明 pre-settle 原始投影通常以 assistant message 结束，因此该值为 `false`；追加 `custom_message` 后最终投影才可继续。

调整：

- 删除原始投影 pre-check；
- 始终链式保留 `event.entries` 并追加合法 `custom_message` draft；
- 让 Pi 在提交 draft 后验证最终 projection；
- 自动测试以初始 `canContinue=false` 固定该契约。

这是生命周期正确性修复，不是容错放宽。

### 2.2 简单修改借用文件级 Signal

初版只判断“文件被改 + 文件有 Signal”。真实字符串替换因此在复杂 service 中触发了一次无必要 continuation。

调整：

- 成功 edit/write 只在内存中读取正文；
- 立即归纳为 `relevant | unknown | irrelevant`；
- 不保存 old/new text 或 write content；
- 已知 marker-free 修改以 `no-relevant-mutation` 跳过；
- 相关事务、failure、状态、持久化、外部副作用、兼容和分支修改才进入 target Signal 分析。

真实 Pi negative 从 2 次 Agent run 降为 1 次；positive 仍保持一次 review continuation。

### 2.3 auto-once 重复执行 suggest 分析

Context formatter 原本只为 `suggest` 注入 Practice Capsule，但 Extension 一度在 `auto-once` 普通 Context 中也执行相同分析，结果不被消费，只增加 I/O 和日志噪声。

调整：

- `suggest`：普通 Context 执行 Practice 分析并注入 Capsule；
- `auto-once`：普通 Context 不执行 suggest 分析，只在 pre-settle 对相关 mutation 分析；
- 两种模式共用 Signal analyzer 和 token 上限，但不重复同一轮问题。

这保持模式语义清晰，也避免 custom review message 与普通 Capsule 重复。

### 2.4 确定性决策滞留在 Extension 入口

初版把 generation、outcome、pending continuation、mutation relevance、read ledger 和 target eligibility 的组合判断直接写在 `extensions/index.ts`。

调整：

- 提取纯函数 `planPracticeReviewBoundary()` 到 `src/practice/review-runtime.ts`；
- Extension 只提供生命周期事实和 `isEligible` callback；
- planner 单元测试覆盖排序、上限和 skip reason；
- 文件分析、消息格式化和 Pi draft 接线仍各自独立。

没有为了形式完整增加 Planner class 或注册表。

### 2.5 删除无运行价值状态

Review Runtime 最终只保留：

- generation；
- mutation path/relevance map；
- requested bit。

不保留未参与决策的 task start timestamp、源码正文、diff、Signal cache 或模型结果。

## 3. 子系统必要性复核

| 子系统 | 结论 | P2 后职责 |
| --- | --- | --- |
| `extensions/index.ts` | 保留 | Pi event 接线、Snapshot refresh callback、日志和 boundary draft；不承载 Signal/format/planner 细节 |
| `src/practice/signal-analyzer.ts` | 保留 | 修改后 production target 的确定性结构 Signal |
| `src/practice/capsule-formatter.ts` | 保留 | suggest Capsule 与 one-shot message 的共同排序、去重、escaping 和 token 裁剪 |
| `src/practice/review-runtime.ts` | P2 后必要 | task generation、防循环、正文即弃的 mutation relevance 和纯 boundary planner |
| `src/runtime/context.ts` | 保留且不扩张 | 只组合 Knowledge/Snapshot/suggest；auto-once 不把生命周期状态带入 Context composer |
| `src/runtime/state.ts` / v3 checkpoint | 保持原状 | read/mutation/Guard 历史；不持久化临时 review generation |
| `src/guard/` | 保持原状 | Discovery-only；没有 Practice import 或新 reason code |
| `src/profile/` | 保持原状 | 继续复用 knowledge/conventions；没有 `practices` schema |
| Git post-change audit | 复用 | Shell 路径证据唯一来源；没有第二套 baseline/diff tracker |
| 日志/status | 保留 | mode、generation decision、reason、id、计数、预算和耗时；不记录正文 |

## 4. 依赖方向

```text
Extension
  -> Observe analyzer / Snapshot cache
  -> Practice Review Runtime + pure planner
  -> Practice Signal analyzer
  -> Practice formatter
  -> Runtime logger

Extension Shell path
  -> existing Git auditor
  -> Review Runtime records changed source path as unknown

Guard  -/-> Practice
Profile -/-> Review Runtime
Checkpoint -/-> Review Runtime
Context -/-> Review Runtime
```

`-/->` 表示没有依赖。当前没有新增环。

## 5. 为何不继续拆分组件

`src/practice/review-runtime.ts` 同时包含小型 mutation classifier、纯 boundary planner 和状态容器，共享同一 one-shot domain contract。继续拆成 mutation-analyzer、planner class、generation store 会产生更多文件和跨模块 DTO，但没有独立复用或变化轴证据。

`extensions/index.ts` 仍是约 1,000 行的生命周期入口，这是既有架构债务；本轮已把新增的确定性决策提到 `src/`。若只为减少行数再建立 orchestration facade，会扩大整个 Extension 的重构范围，不应与 P3 质量评估混合。

## 6. 刻意不增加的能力

- **不持久化 review generation**：任务不能跨进程自动继续；崩溃后 fail-open 比重复请求安全。
- **不读取完整 Git diff**：controlled input 即时分类，Shell 复用路径级审计；不保存 pre-image。
- **不做 method-level parser**：当前 negative/positive 证据只支持轻量 relevance，不支持新增 parser 依赖。
- **不自动检查测试文件关联**：需要语言/构建系统映射和质量标注，留待 P3。
- **不配置 review 次数**：一次是安全边界，不允许改为可调循环。
- **不默认 auto-once**：默认继续为 `suggest`。
- **不把 review 结果转成 Guard block**：建议是否采纳仍由当前 Agent 和可执行检查决定。

## 7. 已知但可接受的限制

1. relevance 是词法 marker，不等价于 method-level semantic diff；会有保守漏报。
2. Shell 和无法解释正文的受信第三方 mutation 为 `unknown`，可能比 controlled edit 更容易触发；P3 必须单独测量。
3. 精确编辑若只替换参数常量而不包含周围状态调用，可能被视为 irrelevant；这是降低干扰的主动取舍。
4. custom review message 会持久化在当前 Session transcript，但 generation 状态不会持久化。
5. review continuation 中允许正常工具调用和工具后的模型跟进，但 pre-settle hook不会再请求第二个 review generation。

这些限制均 fail-open 或只影响 opt-in 模式，不扩大 Guard 风险。

## 8. 验证证据

自动：

- strict TypeScript + NodeNext；
- clean build；
- 68/68 tests；
- marker-free/relevant/unknown、pi-lens、Shell、Branch、boundary chaining、token 和隐私覆盖；
- changed TypeScript 无已报告 LSP 诊断；silent-on-clean 不作为通过证据。

真实 Pi `0.87.1`：

- negative Session `01a0e072-abcd-7598-96a0-46fdbafefa77`：1 次 Agent run，0 review；
- positive Session `01a0e073-07e7-70f8-8626-cedf715e6322`：2 次 Agent run，1 个 373-token review，随后 `already-requested`；
- 两次 stderr 均为空；
- 最终 diff 均只有用户要求的单点修改。

详细结果见 [Practice auto-once 验证](practice-auto-once-results.md)。

## 9. 最终判断

P2 增加 Review Runtime 是必要的，因为 one-shot generation 和 mutation relevance 已成为跨事件状态；但其状态和依赖已经限制在最小边界。

复审后的架构满足：

- Extension 核心、Skill 辅助；
- deterministic decision 在 `src/`；
- Guard Discovery-only；
- 默认 suggest、auto-once opt-in；
- 当前 Agent、每任务最多一次；
- repository/Session/Branch 隔离；
- 统一且有界的消息预算；
- 日志隐私和分析失败 fail-open。

因此不再增加组件；当时的下一步是进入 P3 真实质量评估，而不是继续扩展 Runtime 或 schema。

后续 P3 已完成，结论继续支持不扩 Runtime/schema；详见 [Practice P3 真实质量评估](practice-quality-p3-results.md)。
