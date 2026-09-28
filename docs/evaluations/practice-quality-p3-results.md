# Engineering Practice P3 真实质量评估

> 执行日期：2026-09-27
> 产品版本：`0.4.0-alpha.1`（未发布）
> Pi：`0.87.1`
> Practice analyzer：`practice-lexical-v1`
> 评估模型：`deepseek/deepseek-flash`，thinking off
> 运行编号：`20260927T024720Z-practice-p3`

## 1. 结论

P3 真实质量评估已完成。当前证据支持以下产品决定：

1. **默认继续为 `suggest`**；没有证据把 `auto-once` 改为默认。
2. **`auto-once` 继续 opt-in**：相关问题准确，但本轮只带来 1 次有意义的兼容分支移除条件注释，没有带来行为修复，同时产生 3 次额外 Agent continuation。
3. **不扩展 Profile `practices` schema**：本轮问题均可由通用 Signal 表达，没有出现需要项目专属声明式 trigger 的证据。
4. **不增加 method-level diff、parser、测试映射器或 policy engine**：18 个结果均正确，现有证据不足以支持这些复杂度。
5. **记录一个明确覆盖缺口**：当 Observe 对已读取 production target 返回 `scope-unknown` 时，静态 Practice Signal 即使有效也不会进入 `suggest` 或 `auto-once`。本轮 provider variation 任务真实命中该缺口。该缺口随后通过独立的[有界 fallback 评估](practice-scope-unknown-fallback-results.md)关闭：只允许 successful-read existing production target，不伪造 Local Snapshot 或改变 Guard。

这是一组小样本基线，不宣称证明跨模型、跨语言或跨仓库的普遍因果收益。

## 2. 评估设计

### 2.1 冻结与隔离

执行前冻结 `evaluation-plan.json`：

```text
sha256 fd760de5e2ddc791c92f268adc854b49ffb2a2e66c2479ce6fca31674eafc267
```

每个 task/mode 组合使用独立 detached disposable worktree。三个源仓库保持原 HEAD 与原状态：

| 仓库 | HEAD | 评估后状态 |
| --- | --- | --- |
| SnailJob backend | `d837ef0bad8f3182ad1fd262249d198ce0df2f5e` | 原 15 条 Job Tag CRUD v2 状态保持不变 |
| SnailJob Admin | `9797d1f53c41d56a03d8d1af30d37d5d6d480e72` | 原 7 条 Job Tag CRUD v2 状态保持不变 |
| SnailAI backend | `10c1d3e50b701be62da23a3403d79a41187ab8cd` | clean |

没有在产品仓库或被测仓库创建 commit。

### 2.2 任务集

6 个真实代码任务分别以 `off`、`suggest`、`auto-once` 执行，共 18 次 Pi run。模式顺序按 task 轮换，降低固定顺序偏差。

| Task | 仓库 | 类别 | 预期关注点 |
| --- | --- | --- | --- |
| `P3-SJ-SIMPLE-FAILURE` | SnailJob backend | 简单 failure message | 保留 cause、加入 batch id、无额外抽象 |
| `P3-SJ-STATE` | SnailJob backend | 状态持久化 | id + version 乐观匹配、stale 返回 false、保持幂等与 next-trigger |
| `P3-AI-COMPAT` | SnailAI backend | 兼容迁移 | exact legacy hash 条件更新、并发冲突时不签 token |
| `P3-AI-TX-SIDE-EFFECT` | SnailAI backend | 持久化与 cache side effect | 数据库更新成功后才能清 cache、记录成功并返回 |
| `P3-AI-PROVIDER` | SnailAI backend | provider variation | flat index 优先、nested fallback、score/default 保持、聚焦测试 |
| `P3-SJ-ADMIN-SIMPLE` | SnailJob Admin | 简单 API wrapper | 只改参数语义，URL 行为不变 |

两项为简单任务，四项为复杂任务。Prompt、预期关注点和评分 rubric 在运行前冻结；原始 session、diff 和日志只保存在 `.tmp/`。

### 2.3 仓库级静态基线

确定性只读扫描：

| 仓库 | 已分析 production Java | 有 Signal 目标 |
| --- | ---: | ---: |
| SnailJob backend | 1,158 | 43（3.7%） |
| SnailAI backend | 657 | 19（2.9%） |

两个仓库各有 4 个 generated-header 文件被排除。该扫描只验证 Signal 密度，不等于运行时 Capsule 覆盖率。

## 3. 人工质量结果

### 3.1 最终修改质量

| 指标 | off | suggest | auto-once | 合计 |
| --- | ---: | ---: | ---: | ---: |
| 完成用户行为 | 6/6 | 6/6 | 6/6 | 18/18 |
| 满足冻结工程关注点 | 6/6 | 6/6 | 6/6 | 18/18 |
| 无关修改 | 0 | 0 | 0 | 0/18 |
| 无意义注释 | 0 | 0 | 0 | 0/18 |
| 过度拆分 | 0 | 0 | 0 | 0/18 |
| 设计模式过度使用 | 0 | 0 | 0 | 0/18 |

所有模式都完成了请求，因而本轮没有观察到 `suggest` 或 `auto-once` 的行为正确性增益。不同模式的具体写法存在小幅随机差异，但均通过人工检查和相应可执行验证。

### 3.2 建议认可率

按“每个 task 中去重后的稳定 Signal question”计数，不按每轮 Context 重复计数：

| 模式 | surfaced questions | 人工认为适用 | 认可率 |
| --- | ---: | ---: | ---: |
| suggest | 7 | 5 | 71.4% |
| auto-once | 4 | 4 | 100% |

`suggest` 的 2 条低价值问题来自 active peer 分析中的额外 responsibility/state Signal；它们没有造成无关修改。`auto-once` 只分析 mutation target，因此问题更聚焦。

### 3.3 一次性自审结果

`auto-once` 在 6 个任务中继续 3 次：

| Task | Signal | review message | 结果 |
| --- | --- | ---: | --- |
| `P3-SJ-STATE` | state-persistence | 256 tokens | 确认无需修改 |
| `P3-AI-COMPAT` | compatibility-intent | 251 tokens | 增加 1 条有效的 legacy 分支移除条件注释 |
| `P3-AI-TX-SIDE-EFFECT` | transaction-side-effect、responsibility-boundary | 329 tokens | 确认无需修改 |

因此：

- 有意义改进：1/3，但仅为兼容意图的说明清晰度；
- 行为问题修复：0/3；
- 正确确认无需修改：2/3；
- 自审制造无关修改：0/3；
- 第二次 review 循环：0。

兼容任务的 review 确实回答了 Signal 的“移除条件”问题，不属于复述代码的无意义注释。但该收益不足以抵消默认开启额外调用的成本。

### 3.4 简单任务干扰

两个简单任务：

- failure message：`skip / no-review-capsule`；
- TypeScript API wrapper：`skip / no-review-capsule`。

均只有 1 次 Agent run，最终 diff 精确，无额外注释、测试、抽象或方法拆分。

简单任务额外 continuation 干扰率：**0/2**。

## 4. 成本与额外轮次

### 4.1 总体运行数据

| 模式 | Agent starts | assistant tool-loop calls | provider-reported tokens | cost | wall time |
| --- | ---: | ---: | ---: | ---: | ---: |
| off | 6 | 82 | 936,530 | 0.05928 | 308.7 s |
| suggest | 6 | 67 | 847,986 | 0.05651 | 172.5 s |
| auto-once | 9 | 104 | 1,660,003 | 0.08773 | 460.9 s |

这些总量受模型随机性、模型自行选择的检查命令和环境缓存影响。例如 provider 任务在三个模式都未收到 Practice Capsule，但耗时仍明显不同。因此不能把 mode 间所有差额直接归因于 Practice。

### 4.2 可直接归因的一次性 continuation

三个 review continuation 合计：

- review message：836 estimated tokens；
- 额外模型 tool-loop calls：6；
- provider-reported累计 usage：107,443 tokens；
- cost：0.00596；
- elapsed：99.8 s；
- elapsed 中位数：3.5 s；
- 最大值：93.6 s。

最大值来自兼容任务在 comment-only review 后重新执行 focused Maven compile。该行为符合“修改后验证”指令，但说明即使 review message 很小，一次 continuation 也可能放大工具执行成本。

## 5. 运行时覆盖缺口

### 5.1 观测

静态扫描对以下 5 个任务目标发现 Signal：simple failure、state、compatibility、transaction/side-effect、provider variation。运行时只有 state、compatibility 和 transaction 三项进入 Practice：

- 有 Signal task 的运行时覆盖：3/5；
- 四个复杂任务的运行时覆盖：3/4。

`QwenRerankModelAdapter.java` 静态命中 `practice.variation-axis`，但 Observe 无法为该 provider module 建立已知 Scope，持续返回 `scope-unknown`。因此：

- `suggest` 没有注入 variation question；
- `auto-once` 以 `skip / no-eligible-target` 结束；
- 三种模式均由普通 Agent 自行完成正确实现和测试。

简单 failure 文件也因没有可用 Capsule 而未进入 Practice；由于任务简单，这次没有质量损失。

### 5.2 决策

本轮不直接放宽 Runtime，因为那会改变 P1“只分析进入 Context 的 Snapshot target”边界。后续若处理，应先设计并独立验证：

- 只针对成功读取的 existing production target；
- 只提供 Practice，不生成或伪造 Local Snapshot；
- 不改变 Guard reason code、决策或 bypass；
- 保持 target/repository、Session、Branch 和 token 隔离；
- 最多分析当前 mutation targets 或严格有界的最近目标；
- no Signal、读取失败、超限和 non-production 继续 fail-open。

这是 P3 得到的具体后续项，不是 Profile schema 或 parser 的理由。后续评估已采用该边界：provider Signal 覆盖从 0/1 提升到 1/1，简单 API wrapper 仍为 0 Signal、0 continuation；详见 [`scope-unknown` fallback 结果](practice-scope-unknown-fallback-results.md)。

## 6. 验证与环境限制

### 6.1 独立验证

- 18/18 patch 可在各自基线 clean apply；
- SnailJob backend：simple failure representative compile 通过；三个 state mode variant compile 通过；
- SnailAI backend：admin compatibility 与 transaction representative compile 通过；
- provider：三个 mode variant 的 focused tests 全部通过；
- 共 9/9 backend executable checks 通过；
- 18/18 `git diff --check` 通过。

### 6.2 前端环境阻塞

SnailJob Admin detached worktree 的 typecheck 缺少由项目流程生成的 elegant-router 类型和 transform 文件。即使只读复用源仓库 `node_modules`，仍在变更文件之外报缺失 generated modules，因此标记为 `ENVIRONMENT_BLOCKED`。

三种前端 diff 完全相同，仅做两个参数重命名与对应模板插值替换；人工检查通过。该环境阻塞不冒充 executable pass。

### 6.3 隐私

永久报告只保存 task id、路径类别、Signal id、计数、reason、token、耗时、验证状态和结论。源码、完整 prompt、diff、命令和模型自审正文只在 `.tmp/pi-convention-sense/practice-p3/` 原始证据中保留，不进入 npm package。

## 7. 局限

1. 每个 task/mode 只运行一次，模型输出具有随机性。
2. 任务为了可人工判定而包含明确验收条件，降低了 Practice 发现隐含行为缺陷的空间。
3. Java 占 5/6；TypeScript 只有一个简单任务，Vue 未进入本轮修改任务。
4. 没有真实数据库、并发竞争、外部 MCP server 或 provider API 端到端测试。
5. token/cost 是 provider session usage，不是严格的独立 billable-token 实验。
6. 本轮只覆盖一个模型，不能外推到所有 Pi provider/model。

## 8. 最终产品判断

P3 证明了当前 Practice 不会机械制造注释、拆分或设计模式，并且简单任务干扰为零。`auto-once` 的问题聚焦度高且防循环有效，但在最终行为正确性与 `suggest`/`off` 相同的情况下，额外 continuation 只产生一次注释清晰度改进，成本和最坏延迟不可忽略。

因此：

```text
默认：suggest
可选：auto-once
Guard：继续 Discovery-only
Profile practices schema：不增加
parser / method-level diff / policy engine：不增加
scope-unknown fallback：已完成，仅 successful-read existing production target
```

原始有界汇总：

```text
.tmp/pi-convention-sense/practice-p3/20260927T024720Z-practice-p3/
  evaluation-plan.json
  preflight.json
  signal-index.json
  execution-summary.json
  human-review.json
  quality-summary.json
  validation-summary.json
```

后续 fallback 原始证据：

```text
.tmp/pi-convention-sense/practice-scope-unknown/20260928T-evaluation/
  evaluation-summary.json
```
