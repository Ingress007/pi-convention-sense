# Engineering Practice Advisory MVP 验证结果

> 执行日期：2026-09-25
> 产品版本：`0.4.0-alpha.1`（未发布）
> Practice analyzer：`practice-lexical-v1`
> Pi 开发依赖：`0.87.1`
> Node.js：`22.22.2`

## 1. 结论

Engineering Practice P1 Advisory MVP 已完成：系统可以从已成功读取、已形成 Snapshot 且实际进入 Context 预算的现有 production target 中生成确定性 Practice Signal，并在不影响 Local Snapshot 和 Convention Guard 的前提下注入有界 `<engineering-practice status="advisory">`。

该结论只覆盖 advisory 能力，不是 Practice 质量发布结论：

- 不执行 `agent_before_settle`；
- 不自动继续当前 Agent；
- 不分析 mutation diff 或测试关联；
- 不增加任何 Guard reason code；
- 不调用第二个 LLM；
- 不扩展 Project Profile schema。

后续[整体架构必要性审查](architecture-necessity-review.md)已通过；P2 `auto-once` 仍须按审查约束单独实现。

## 2. 实现范围

P1 新增三个小型职责单元：

| 文件 | 职责 |
| --- | --- |
| `src/practice/types.ts` | Signal、fact、analysis result 和 Capsule 类型 |
| `src/practice/signal-analyzer.ts` | 有界源码读取、词法清洗、确定性结构 Signal、fail-open reason |
| `src/practice/capsule-formatter.ts` | relevance、稳定排序、去重、结构完整的 token 裁剪 |

Extension 继续只负责编排：在既有 `context` hook 中对最多 4 个 active Snapshot 目标分析，Local Snapshot 成功进入预算后，Practice Capsule 才使用剩余预算。没有新增缓存、持久化、Profile schema、生命周期 hook 或 Review Runtime。

配置：

```json
{
  "practiceReview": {
    "mode": "suggest",
    "maxContextTokens": 400
  }
}
```

当前只接受 `off | suggest`。未实现的 `auto-once` 会产生配置诊断并回退到 `suggest`。

## 3. Signal 边界

首批 Signal：

- `practice.transaction-side-effect`；
- `practice.responsibility-boundary`；
- `practice.state-persistence`；
- `practice.failure-path`；
- `practice.compatibility-intent`；
- `practice.variation-axis`。

每条 Signal 只保存稳定 id、category、目标路径、语言、confidence、结构计数、固定 review question、来源和 analyzer version。Signal 不保存源码片段，也不直接要求注释、拆方法或设计模式。

以下场景不产生 Capsule：

- 简单目标没有有效 Signal；
- prospective target；
- test/generated/vendor/build output；
- 超过 256 KiB 的目标；
- 文件不存在或读取失败；
- Snapshot 没有实际进入总 Context 预算；
- `practiceReview.mode="off"`。

## 4. 自动验证

`npm run verify` 通过：strict TypeScript、clean build、66/66 Node tests。

新增覆盖包括：

- 注释和字符串不会制造 Signal；
- 事务/外部副作用、职责、状态/持久化正常路径；
- compatibility、failure path 和多分支变化轴；
- review question 不要求机械注释、强制拆分或模式；
- Capsule 结构完整、受预算约束且不包含源码正文；
- Practice 不挤掉 Local Snapshot；
- `off`、prospective 和 non-production fail-open；
- 配置无效时安全回退；
- Extension Context、状态诊断、Guard 不变和日志隐私。

LSP 对 changed TypeScript 文件没有报告诊断，但服务器属于 silent-on-clean，不能代替上述 TypeScript 编译和测试证据。

## 5. SnailJob disposable worktree smoke

仓库：SnailJob backend
HEAD：`d837ef0bad8f3182ad1fd262249d198ce0df2f5e`

对 1,158 个 production Java 文件执行只读确定性扫描：

| 项目 | 数量 |
| --- | ---: |
| 有至少一个 Signal 的目标 | 43（3.7%） |
| 无 Signal 的简单目标 | 1,115（96.3%） |
| transaction-side-effect | 10 |
| responsibility-boundary | 10 |
| state-persistence | 2 |
| failure-path | 12 |
| compatibility-intent | 1 |
| variation-axis | 14 |

该扫描只验证触发密度和运行稳定性，不替代 P3 人工认可率评估。

首次扫描把任意包含 `retry` 的标识符当作 failure path，导致 346/1,158 文件触发。实现随后收紧为明确 receiver recovery call、framework retry marker 或 catch-associated recovery call；中间结果降至 140，最终降至 43。此过程说明 MVP 优先降低简单任务干扰，而不是追求 Signal 数量。

固定真实目标 `RetryWebServiceImpl.java`：

- Local Snapshot：`valid`；
- peer：4；
- Signal：transaction-side-effect、responsibility-boundary、failure-path；
- Practice 分析：约 6 ms；
- Capsule：335 tokens；
- XML 结构完整；
- Capsule 不含源码正文。

原始只读结果保存在：

```text
.tmp/pi-convention-sense/practice-mvp/
```

Disposable worktree 在证据保存后删除，原 SnailJob 仓库未被修改。

## 6. 隐私与 Guard 边界

Context 日志只记录：

- analysis 数量；
- Signal 数量和稳定 id；
- skip reason；
- 总耗时。

日志不记录源码、Signal question 正文、diff、prompt 或命令。Extension 集成测试确认源码调用文本和 review question 不进入 NDJSON。

Practice 不参与 `evaluateConventionGuard()`，也不修改 Guard Runtime、bypass、checkpoint 或 post-change audit。Local Snapshot 先进入 Context，Practice 只使用剩余预算，因此不会制造新的 `SNAPSHOT_NOT_INJECTED`。

## 7. 尚未完成

- 对每类 Signal 的真实人工认可率；
- 无意义注释、过度拆分、过度设计和简单任务干扰率；
- mutation/diff 和测试关联 Signal；
- `agent_before_settle` `auto-once` 防循环 Runtime；
- 是否需要 Profile `practices` schema；
- 更多仓库、语言和真实 Pi 交互式生命周期评估。

这些项目属于整体架构审查、P2 或 P3，不应为完成 P1 而提前加入额外组件。
