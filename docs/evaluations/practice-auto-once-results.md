# Engineering Practice auto-once 验证结果

> 执行日期：2026-09-27
> 产品版本：`0.4.0-alpha.1`（未发布）
> Pi：`0.87.1`
> Practice analyzer：`practice-lexical-v1`

## 1. 结论

opt-in `practiceReview.mode="auto-once"` 已实现并通过自动与真实 Pi 生命周期验证：

- 每个用户任务由 `before_agent_start` 开启一个内存 generation；
- 成功 edit/write 或既有 Git 后置审计确认的 Shell source mutation 才进入候选；
- 目标必须已成功读取、仍为现有 production source 且能形成 Snapshot；
- 有相关 mutation 和有效 Practice Signal 时，在 `agent_before_settle` 追加一条有界 `custom_message`；
- 返回 `continue: true`，由当前 Agent 完成一次自审；
- generation 在发出 review 前原子标记，review 中继续修改也不会再次触发；
- Session/Branch/reset 清空 generation，不进入 checkpoint；
- `off` / `suggest` 默认行为、Guard reason code 与放行决策不变；
- 不调用第二个 LLM。

默认仍为 `suggest`。该结论是生命周期和边界验证，不替代 P3 人工质量评估。

## 2. 最小 Runtime

新增 `src/practice/review-runtime.ts`，只保存当前用户任务的：

- generation；
- 规范化 mutation path；
- mutation relevance：`relevant | unknown | irrelevant`；
- 是否已经请求 review。

Runtime 不保存源码、diff、prompt、review 正文或模型输出，也不持久化到 v3 checkpoint。`agent_before_settle` draft 使用 Pi 的既有 `custom_message` 契约；没有新增工具、命令、Profile schema 或 Guard 状态。

受控 edit/write 只在内存中检查输入是否包含事务、错误恢复、状态修改、持久化、外部副作用、兼容或分支 marker，立即归纳为 relevance 后丢弃正文。已知 marker-free 修改不会仅因文件其他位置复杂而触发；无法安全解释的第三方/Shell mutation 保持 `unknown`，随后仍要求 production/read/Snapshot/Signal 门槛。

## 3. Pi boundary 契约修正

首次真实 Pi 运行发现一个仅靠模拟 harness 未暴露的问题：进入 `agent_before_settle` 时，当前投影视图通常以 assistant message 结束，因此 `event.context.canContinue` 为 `false`；Extension 追加 `custom_message` 后，最终投影才变为可继续。

实现最初在创建 draft 前检查 `event.context.canContinue`，导致真实运行以 `continuation-unavailable` 跳过。修正后：

- 不预判原始投影；
- 始终按 Pi 契约返回 `entries: [...event.entries, reviewDraft]`；
- 由 Pi 在提交 draft 后验证最终 projection；
- 自动测试显式以 `canContinue=false` 的初始 boundary 验证仍能产生合法 continuation；
- 既有其他 handler 的 draft 会原序保留。

该修正使用 Pi `0.87.1` 实际声明与运行时行为，不依赖猜测。

## 4. 简单修改干扰修正

第二个真实发现是：只按“文件有 Signal + 文件被修改”判断，会让复杂类中的简单字符串修改触发额外模型调用。

因此增加了轻量 mutation relevance 门槛：

| mutation | 结果 |
| --- | --- |
| marker-free 精确 edit | `irrelevant`，跳过 |
| edit/write 触及事务、failure、状态、持久化、外部调用、兼容或分支 marker | `relevant` |
| 无法解析正文的受信第三方 mutation 或 Git 确认的 Shell source mutation | `unknown` |

这不是完整语义 diff，也不宣称定位到具体方法；它只防止已知无关编辑借用同文件其他位置的结构 Signal。更精确的 method-level diff 必须等待 P3 证明确有收益，不能提前引入 parser 或平行 Git runtime。

## 5. 自动验证

自动测试覆盖：

- `off | suggest | auto-once` 配置与无效值回退；
- one-shot review message 结构和 400-token 上限；
- current-task generation、path 去重和 relevance 合并；
- marker-free edit 不触发；
- relevant edit 触发当前 Agent continuation；
- 原始 boundary `canContinue=false` 时，追加 custom message 后仍合法继续；
- earlier boundary drafts 不丢失；
- 第二次 settle 为 `already-requested`，不循环；
- 无 mutation、pi-lens 诊断、分析失败路径 fail-open；
- Shell Git 后置审计识别的 source mutation 可参与；
- Branch 切换不继承 generation；
- review message 和 NDJSON 不含 edit 正文、源码调用或完整问题正文；
- Guard 仍按原决策运行。

完整验证基线更新为 68/68 tests。

## 6. 真实 Pi 0.87.1 生命周期

临时 Git fixture：4 个同 Scope Java service implementation，目标包含事务、状态持久化和外部副作用 Signal。Extension 通过显式 `--extension` 在全新 Pi 进程加载，使用 `--no-extensions` 排除其他 Extension 干扰。

### 6.1 Negative：简单字符串修改

Session：`01a0e072-abcd-7598-96a0-46fdbafefa77`

任务只把 `reviewMarker()` 的 `"before"` 改为 `"after"`：

- mutation target：1；
- decision：`skip / no-relevant-mutation`；
- agent start/end：1/1；
- custom review entry：0；
- stderr：空；
- 最终 diff 只有指定字符串。

### 6.2 Positive：外部副作用调用修改

Session：`01a0e073-07e7-70f8-8626-cedf715e6322`

任务把 `notificationGateway.publish(order)` 改为 `publishApproved(order)`：

- mutation target：1；
- analyzed target：1；
- Signal：transaction-side-effect、responsibility-boundary、state-persistence；
- one-shot message：373 tokens；
- 首次 decision：`continue / practice-signals`；
- 当前 Agent 第二次运行完成自审；
- 第二次 boundary：`skip / already-requested`；
- agent start/end：2/2；
- custom review entry：1；
- stderr：空；
- 最终 diff 只有用户要求的调用名修改，没有无关注释、拆分或抽象。

原始临时证据：

```text
.tmp/pi-convention-sense/auto-once-real/
```

其中 `real-summary.json` 只保存有界计数、reason、Signal id、token 和 Session id。

## 7. 隐私与边界

Review 日志只包含：

- generation；
- action/reason；
- mutation/analyzed target 数量；
- Signal id/数量；
- token 与耗时；
- 安全错误类型名。

日志不包含源码、old/new text、diff、完整 prompt、review question 或自审正文。Custom review message属于当前会话模型所需上下文，但只含固定指令、路径、结构 facts 和固定 question，不含源码正文。

Practice 仍不参与 `evaluateConventionGuard()`，不新增 reason code，不消费 bypass，也不修改 Guard counters。

## 8. 尚未完成

- SnailJob/SnailAI 多任务人工认可率与额外调用成本基线；
- Shell `unknown` mutation 的真实干扰率；
- method-level diff、公共 contract 和测试关联是否值得实现；
- `suggest` 与 `auto-once` 的质量对照；
- Profile `practices` schema 的必要性。

这些属于 P3。默认策略不得在质量基线前从 `suggest` 改为 `auto-once`。

P2 后置整体架构复审已完成并通过，详见 [auto-once 后置整体架构复审](auto-once-architecture-review.md)。后续 P3 也已完成，默认策略继续保持 `suggest`；详见 [Practice P3 真实质量评估](practice-quality-p3-results.md)。
