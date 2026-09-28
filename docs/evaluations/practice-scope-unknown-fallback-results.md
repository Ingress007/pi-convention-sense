# `scope-unknown` Practice-only fallback 评估结果

> 评估日期：2026-09-28
> 版本：`0.4.0-alpha.1`
> Pi 基线：`0.87.1`
> Practice Analyzer：`practice-lexical-v1`

## 1. 结论

采用严格有界的 fallback：当 Observe 对**已成功读取、已存在、production source** 返回 `scope-unknown` 时，Practice 可以直接分析该目标；它不创建 Local Snapshot、不提供 peer evidence，也不参与 Guard。

```text
Observe scope-unknown
  + successful read
  + existing production target
  + configured language / repository exclusion checks
  -> Practice-only deterministic target analysis
  -> suggest Capsule 或 opt-in auto-once review
```

无 Signal、读取失败、超大文件、非 production、prospective、excluded 或 unsupported target 继续 fail-open。默认仍为 `suggest`，`auto-once` 仍须显式启用。

## 2. 为什么采用

P3 的真实 provider 任务暴露了一个窄而可复现的缺口：

- `QwenRerankModelAdapter.java` 的 Observe 结果为 `scope-unknown`，没有 Snapshot；
- 同一文件的确定性分析稳定命中 `practice.variation-axis`；
- 对应 review question 经 P3 人工判断适用；
- 原有 Runtime 因要求 Snapshot 而在 suggest/auto-once 两条路径均漏掉该 Signal。

fallback 只去除 Practice 对 Snapshot 的不必要依赖，不放宽 read、production、repository、预算或 one-shot 边界，因此收益明确而架构增量较小。

## 3. 实现边界

### 3.1 suggest

- 仍以 Snapshot target 为优先；
- 仅从当前 Branch 的有界 active paths 中补充 `scope-unknown` target；
- 必须出现在 successful-read ledger；
- Snapshot 与 fallback analysis 合计最多 4 个 active target；
- Practice Capsule 继续使用独立上限和剩余总 Context 预算；
- 即使没有 Snapshot，也明确保留 `<local-convention status="unavailable">`，不得把 Practice 伪装成 Local Evidence。

### 3.2 auto-once

- mutation relevance、successful-read、existing production、max target 和 generation 边界保持不变；
- 首先尝试正常 Snapshot 分析；只有结果为 `scope-unknown` 才执行 direct target analysis；
- 无 Signal 不创建 review message；有效 Signal 仍只允许当前 Agent continuation 一次。

### 3.3 明确不改变

- 不新增 Guard reason code、block、bypass、counter 或 checkpoint 状态；
- 不把 direct analysis 写入 Snapshot Cache；
- 不提供虚构的 Scope、candidate、peer 或 Observation；
- 不新增 Profile `practices` schema、parser、method-level diff、测试映射器、缓存或第二个 LLM；
- Review Runtime 仍只保存 generation、normalized path、relevance 和 requested bit。

## 4. 结果

### 4.1 SnailAI provider 正例

目标：`QwenRerankModelAdapter.java`

| 指标 | 结果 |
| --- | --- |
| Observe reason | `scope-unknown` |
| Snapshot created | 否 |
| fallback basis | `successful-read` |
| Signal | `practice.variation-axis` |
| question applicable | 是 |
| direct analysis | 6 ms |
| suggest Capsule | 186 tokens |
| auto-once review | 273 tokens |
| 预期额外 continuation | suggest 0；auto-once 1 |

P3 中该目标的 Practice 覆盖从 0/1 提升到 1/1，同时没有改变其 Local Evidence 状态。

### 4.2 简单 API wrapper 负例

一个 `scope-unknown` 的 existing production API wrapper 只包含单次 client 调用：

| 指标 | 结果 |
| --- | --- |
| Observe reason | `scope-unknown` |
| Snapshot created | 否 |
| Practice Signal | 0 |
| direct analysis | 1 ms |
| auto-once continuation | 0 |

这证明 fallback 不是“scope unknown 就建议”，而是仍由确定性高价值 Signal 门控。

### 4.3 自动生命周期覆盖

新增测试覆盖：

- direct target analyzer 的 production/test fail-open 边界；
- 无 Snapshot 时，unavailable Local Convention 与 Practice-only Capsule 可同时存在且共享预算；
- suggest 正例不创建 Snapshot；
- auto-once 正例只 continuation 一次；
- Session/Branch/read ledger 和现有 one-shot 逻辑继续复用；
- 简单 API wrapper 无 Signal、无额外 continuation；
- 日志只增加 fallback target count，不记录源码或问题正文。

### 4.4 完整验证

- `npm run verify`：70/70；
- focused Practice/Extension tests：22/22；
- `npm pack --dry-run`：79 个文件，package 中不含 `.tmp` 原始证据；
- `git diff --check`：通过；
- 32 个 Markdown 文件相对链接检查：无断链；
- LSP 主服务器 silent-on-clean，未确认 clean；TypeScript typecheck 与测试均通过；pi-lens 无 error，并在 modified Observe files 的既有区域报告 6 个非阻断 style warning。

## 5. 产品决策

fallback 进入当前实现，但不改变 Practice 默认策略：

```text
Practice default: suggest
Auto review: auto-once remains opt-in
Fallback: scope-unknown + successful-read + existing production only
Guard: unchanged, Discovery-only
Snapshot/peer evidence: never fabricated
Profile/parser/method-level runtime: unchanged
```

本次证据只支持修复已观察到的 provider 覆盖缺口，不支持扩大到所有 Snapshot 失败原因，也不支持把 Practice 变成通用复杂度审查器。

## 6. 原始证据

```text
.tmp/pi-convention-sense/practice-scope-unknown/20260928T-evaluation/
  evaluate.mjs
  evaluation-summary.json
  fixture/
```

临时目录不进入 package；永久报告不包含源码、diff、完整 prompt、完整命令或模型输出。
