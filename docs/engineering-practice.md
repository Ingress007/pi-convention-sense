# Engineering Practice：让软件工程思维贯穿 Agent 编码过程

> 状态：P1 Advisory MVP、P2 opt-in `auto-once`、后置架构复审与 P3 真实质量评估已完成
> 定位：在 Local Convention 之外增加工程实践感知、自审和改进闭环
> 前置条件：Stage 2 Guard 生产准入收尾已完成
> 相关文档：[产品需求](requirements.md)、[技术设计](design.md)、[Project Intelligence](project-intelligence.md)、[Stage 2 Guard](stage-2-guard.md)

## 1. 问题定义

现有系统能够让 Agent 根据同仓库、同模块、同角色的真实实现保持局部一致性，但“项目中多数代码怎样写”不等于“当前代码怎样写得更清晰、更可靠、更易维护”。遗留项目中重复出现的长方法、缺失注释、重复分支或过度耦合同样可能被 Local Evidence 观察到。

本阶段要解决的是：在不放弃项目一致性的前提下，让软件工程判断贯穿需求理解、实现规划、编码、修改后自审和验证，而不是只在最终结果中机械补注释或套用设计模式。

重点问题包括：

- 非显然的业务约束、顺序、兼容原因和状态转换是否需要简短的 why-comment；
- 一个修改是否混合了校验、状态转换、持久化、外部副作用和响应组装；
- 复杂流程是否需要按职责拆分；
- 是否存在真实、稳定的变化轴，足以证明 Strategy、State、Template Method、Adapter 等模式的价值；
- 失败、事务、并发、幂等、补偿和负向测试是否被考虑；
- Agent 是否为了“更优雅”而扩大改动范围或制造过度抽象。

## 2. 核心判断

### 2.1 Local Convention 与 Engineering Practice 不等价

Local Evidence 回答：

```text
这个 Scope 附近的代码通常怎样写？
```

Engineering Practice 回答：

```text
面对当前任务、风险和变化方向，哪些工程问题值得思考？
```

前者可以主要通过确定性仓库分析获得；后者需要结构信号、项目知识和当前 Agent 的语义判断共同完成。

### 2.2 不从多数代码自动学习“优秀”

以下内容不得仅凭出现频率提升为工程原则：

- 所有方法都写注释；
- 达到固定行数就强制拆分；
- 分支多就强制使用设计模式；
- 某个历史模块的复杂结构应推广到其他模块；
- 一次 Local Snapshot 自动写回 Project Profile。

重复事实仍然只是代码现状。长期工程原则必须来自 reviewed Project Profile、可执行检查或明确的人类审核。

### 2.3 建议优先，阻断从严

Engineering Practice 初期只提供有触发条件的建议和自审问题，不加入现有 Convention Guard reason code。只有能够由编译器、lint、pi-lens 或项目专用静态检查可靠证明的规则，未来才可能进入独立 Hard Policy。

## 3. 在现有架构中的位置

```text
Global Pack ─┐
Project Profile ─┼─→ Project Context / Engineering Principles
Local Evidence ─┘                    │
                                     ├─→ Convention Snapshot
任务与变更结构信号 ─────────────────┤
                                     └─→ Practice Capsule
                                              │
                                              ↓
                                      当前 Agent 规划与编码
                                              │
                                              ↓
                                    Diff Signals + 一次性自审
                                              │
                         ┌────────────────────┴────────────────────┐
                         ↓                                         ↓
              必要的局部修正与测试                      pi-lens / 编译 / 测试
```

职责边界：

| 能力 | 回答的问题 | 是否阻断 |
|---|---|---:|
| Local Evidence | 附近实现通常怎样写 | 否 |
| Project Profile | 项目明确知识和审核后的工程原则 | 只有独立 hard policy 才可能阻断 |
| Practice Advisor | 当前任务有哪些工程风险和审查问题 | 初期否 |
| Convention Guard | 必要 Discovery 是否完成 | 可阻断 |
| pi-lens、编译、lint、测试 | 机器可验证的问题是否存在 | 由各工具决定 |
| 当前 Agent 自审 | 注释、拆分、抽象和设计选择是否合理 | 不直接阻断工具调用 |

## 4. 工程实践生命周期

### 4.1 需求理解

Agent 先识别任务是否涉及：

- 业务状态变化；
- 外部协议或兼容约束；
- 事务与副作用；
- 并发、幂等或补偿；
- 多实现、多渠道或可替换算法；
- 公共 API 或跨模块 contract；
- 安全、权限、租户或 namespace 隔离。

系统只提供信号和项目知识，不替代 Agent 理解业务。

### 4.2 实现规划

Practice Capsule 应要求 Agent 在动手前考虑：

1. 责任边界是什么；
2. 哪些约束无法通过命名和类型自然表达；
3. 哪些失败路径必须设计；
4. 是否存在真实变化轴；
5. 最简单的可维护方案是什么；
6. 哪些测试能够证明行为。

### 4.3 编码

编码时同时遵守：

- 显式需求和可执行检查；
- reviewed Project Profile hard knowledge；
- 当前 Scope 的 Local Evidence；
- 与当前任务匹配的工程实践建议；
- 不做无关重构和预防性过度抽象。

### 4.4 修改后自审

在 Agent 准备结束前，先把当前任务 mutation 归纳为不保存正文的 relevance，再结合修改后目标的结构 Signal。只有两者都支持审查时，才使用当前 Agent 进行至多一次自审：

- 是否缺少解释“为什么”的短注释；
- 是否存在职责混合或不必要的嵌套；
- 抽象是否由真实变化轴支持；
- 事务、错误、状态转换和外部副作用是否清晰；
- 测试是否覆盖关键正负路径；
- 是否修改了任务范围之外的代码。

自审不能无条件循环，也不能自动要求所有建议都变成代码修改。

### 4.5 验证

工程判断完成后仍必须使用编译、类型系统、lint、pi-lens 和测试验证。Practice Advisor 不能替代任何可执行检查。

## 5. Practice Signal

Advisory MVP 只采集低成本、可解释且不需要完整 parser 的目标结构信号：

- transaction marker 与外部调用同时出现；
- 校验、状态转换、持久化、外部调用和结果组装中至少三个职责维度同时出现；
- 状态转换与持久化调用同时出现；
- fallback、retry、recovery、rollback 或 compensation marker；
- legacy、compatibility、workaround 或 migration marker；
- 至少三个 switch case 或 type-dispatch site，作为可能的真实变化轴。

P2 已增加 task-local mutation relevance，但没有保存 diff 正文或建立平行 Git runtime。P3 未证明 method-level diff、公共 contract、异常吞噬或测试关联值得引入新 metadata，因此继续不实现。

每个 Signal 至少包含：

- 稳定 id；
- category；
- 触发目标；
- 可解释的计数或结构事实；
- confidence；
- 建议的 review question；
- 来源与 analyzer version。

Signal 只说明“值得审查”，不能直接断言“必须使用某个模式”。

## 6. Practice Capsule

Practice Capsule 与 Knowledge Capsule、Convention Snapshot 共享总预算，只注入当前任务相关内容。

建议格式：

```xml
<engineering-practice status="advisory">
Change characteristics:
- State transitions and persistence are modified together.
- An external side effect occurs inside a transaction-sensitive flow.

Review questions:
- Is the state transition invariant clear from names and types, or does it need a short why-comment?
- Should validation, transition, persistence, and notification be separated?
- What happens when the external side effect fails?
- Is there a demonstrated variation axis, or would simple functions be clearer than a design pattern?

Avoid:
- Comments that restate the code.
- Splitting methods without improving responsibility boundaries.
- Introducing abstractions for hypothetical future requirements.
</engineering-practice>
```

裁剪优先级：

1. 保留用户要求、hard knowledge 和高风险问题；
2. 保留与当前目标直接匹配的 review question；
3. 删除低置信 Signal；
4. 合并重复问题；
5. 不硬截断结构标签。

## 7. 注释策略

### 应考虑简短注释

- 非显然的业务不变量；
- 看似多余但不能删除的兼容逻辑；
- 外部协议、数据库方言或第三方限制；
- 特殊顺序、锁、事务、并发、幂等和补偿约束；
- 状态转换的业务原因；
- 反直觉算法或性能权衡；
- 临时 workaround 及退出条件。

### 不应鼓励

- 逐行翻译代码；
- 重复方法名或类型已经表达的信息；
- 为简单 getter、mapping 或普通调用增加噪声；
- 无法随代码维护的大段叙述；
- 用注释掩盖糟糕命名和职责混乱。

评估目标是意图和约束是否被保留，不是注释数量。

## 8. 拆分与设计模式策略

方法拆分应改善至少一项：

- 单一职责；
- 业务步骤命名；
- 失败边界；
- 可测试性；
- 复用真实存在的逻辑；
- 降低嵌套和认知负担。

设计模式必须先证明变化轴，例如：

- 多个可替换算法或 provider；
- 明确状态机；
- 固定流程中的可变步骤；
- 多渠道或多协议适配；
- 已存在至少两个真实实现。

Agent 必须优先比较简单函数、数据驱动映射和局部拆分。不得为了展示模式而增加抽象层。

## 9. Project Profile 与信任模型

工程原则可以成为 Project Profile 的可审核知识，并继续遵守现有冲突顺序：

1. 用户当前明确要求；
2. 安全边界和可执行检查；
3. `AGENTS.md`；
4. reviewed hard project knowledge；
5. 当前 Scope 的多文件 Local Evidence；
6. reviewed advisory knowledge；
7. draft Profile；
8. Global Pack；
9. 通用最佳实践。

Practice Signal 不进入这条权威性排序：它只负责选择值得当前 Agent 思考的 review question，不能覆盖用户要求、可执行检查、reviewed hard knowledge 或 Local Evidence。

首版优先复用现有 `knowledge` / `conventions` 表达工程原则。只有真实评估证明需要结构化触发器时，才新增 `practices` schema。任何 selector/trigger 都必须是声明式白名单字段，不允许脚本或命令。

## 10. 当前 Agent 一次性自审

P2 已使用 Pi `agent_before_settle` 实现 opt-in 自动自审：

1. `before_agent_start` 开启 task generation；
2. 成功 edit/write 归纳 mutation relevance，Shell 复用既有 Git 后置审计路径；
3. 只选择已读、existing production target 并刷新 Snapshot；若唯一失败原因是 `scope-unknown`，改走不创建 Snapshot/peer evidence 的 Practice-only fallback；
4. 无相关 mutation 或有效 Signal 时直接结束；
5. 有效时追加一条有 token 上限的 `custom_message`；
6. 请求当前 Agent 继续一次，并在返回前原子标记 requested；
7. continuation 中的新 mutation 不产生第二次 review；Session/Branch/reset 清空 generation。

当前配置：

```json
{
  "practiceReview": {
    "mode": "suggest",
    "maxContextTokens": 400
  }
}
```

当前模式：

- `off`：关闭；
- `suggest`：在普通 Context 注入 advisory Capsule，默认；
- `auto-once`：不重复注入 suggest Capsule，只在相关修改后请求当前 Agent 自审一次。

一次性上限是产品安全边界，不提供可调 `maxReviewsPerTask`。

这会使用当前会话模型，可能增加一次模型请求，但不调用第二个 LLM。日志仍只能记录 Signal id、计数、路径、reason code、预算和耗时，不能记录源码 diff、完整 prompt 或自审正文。

## 11. 与 Guard 的边界

现有 Guard reason code 保持 Discovery-only：

- `TARGET_NOT_READ`；
- `SNAPSHOT_MISSING`；
- `SNAPSHOT_STALE`；
- `SNAPSHOT_NOT_INJECTED`。

首版禁止新增以下主观阻断：

- `MISSING_COMMENT`；
- `METHOD_TOO_COMPLEX`；
- `DESIGN_PATTERN_REQUIRED`；
- `INSUFFICIENT_ABSTRACTION`。

如果项目未来要求“所有公开 API 必须有文档”之类可执行政策，应由 lint、pi-lens、Checkstyle/ESLint 或独立 Hard Policy 实现，不复用 Convention Guard。

## 12. 与 pi-lens 的边界

pi-lens 继续负责 LSP、类型、lint、format、复杂度和结构诊断。Practice Advisor：

- 不把 pi-lens 诊断工具误判为 mutation；
- 不重复实现已有可靠诊断；
- 可以消费有界诊断摘要或 inter-extension event，但不记录诊断正文中的源码；
- 把机器事实转化为少量任务相关 review question；
- 不因同一问题重复阻断。

正式实现前必须先完成当前 Stage 2 的 pi-lens 同时安装联调。

## 13. 验证要求

自动测试至少覆盖：

- Signal 正常路径与弱信号 fail-open；
- 无关简单修改不触发自审；
- 注释建议不会要求逐行注释；
- 设计模式建议只有在真实变化轴信号存在时出现；
- Context 预算和结构完整性；
- Session/Branch 隔离；
- `agent_before_settle` 最多继续一次，不形成死循环；
- pi-lens 诊断不会被识别为 mutation；
- 日志不包含源码、diff、完整 prompt 或命令；
- generated/test/vendor/build output 的策略明确；
- 分析失败不破坏 Pi 生命周期。

真实任务指标与 Guard 准入指标分开统计：

- review suggestion 人工认可率；
- 缺失 why-comment 的有效发现率；
- 无意义注释增加率；
- 过度拆分率；
- 设计模式过度使用率；
- 自审发现并修复真实问题的比例；
- 额外 token、模型调用和延迟；
- 无 Signal 的简单任务干扰率。

P3 已形成首个基线：18/18 修改正确，suggest question 人工适用 5/7，auto-once question 适用 4/4，简单任务额外 continuation 0/2，无意义注释、过度拆分和模式过度使用均为 0。auto-once 3 次 review 中 1 次增加有效移除条件注释、2 次确认无需修改，未发现行为修复；详见 [P3 结果](evaluations/practice-quality-p3-results.md)。

## 14. 已完成与未完成任务汇总

### 已完成基线

- Observe、Guard 主流程和 Project Intelligence 已实现；
- Java、TypeScript、Vue、module/workspace 和 repository 隔离已实现；
- Guard block → read → Context → retry allow 已在真实 Pi 验证；
- prospective file、weak/no-peer fail-open、Branch checkpoint 和 Shell dirty baseline 已验证；
- SnailJob/SnailAI 主流程与 SnailJob CRUD 已完成真实验收；
- 自动测试基线为 70/70。

### Guard 前置条件已完成

- `/convention-snapshot` 空状态已改为语言无关提示并覆盖自动测试；
- pi-lens `4.2.1` 共存、真实 TUI bypass/Session/Branch/reset 和 HEAD 变化 Shell 审计通过；
- 24 个 SnailJob/SnailAI Observe/Shadow Guard 任务达到 93.5% / 100% / 4.2% 准入指标；
- requirements、design、compatibility、stage-2 和[永久报告](evaluations/guard-production-readiness-results.md)已同步；
- `npm run verify`、`npm pack --dry-run` 和 `git diff --check` 通过。

### Engineering Practice 当前状态

P1 已完成：

- Practice Signal 数据模型和 `practice-lexical-v1` 结构分析；
- Signal relevance/deduplication 和有界 Practice Capsule；
- `off | suggest` 配置、Context 共享预算、状态诊断和隐私日志；
- 简单代码、prospective/non-production path、分析错误 fail-open；
- Java/TypeScript/Vue 通用词法路径及 Extension 生命周期自动测试。

整体架构必要性审查已完成，结论为“通过，附 P2 约束”；详见[审查结果](evaluations/architecture-necessity-review.md)。

P2 `auto-once` 与后置架构复审已完成，详见[验证结果](evaluations/practice-auto-once-results.md)和[复审结果](evaluations/auto-once-architecture-review.md)。

P3 已完成，详见[真实质量评估](evaluations/practice-quality-p3-results.md)。结果不支持增加 Profile `practices` schema、method-level parser 或默认开启 `auto-once`。

`scope-unknown` fallback 已完成，详见[评估结果](evaluations/practice-scope-unknown-fallback-results.md)：只面向 successful-read existing production target，不创建 Snapshot/peer evidence、不改变 Guard；真实 provider 恢复 1 个有效 Signal，简单 wrapper 为 0 Signal/0 continuation。

后续继续不增加 Profile 工程原则专用 schema，除非未来真实证据证明需要。

## 15. 综合执行顺序

### 决策

先收尾 Guard，再实现 Engineering Practice；但现在先完成 Engineering Practice 的需求与设计冻结，避免 Guard 验收结束后再次改变基础生命周期。

理由：

- Guard 收尾任务边界明确且现已闭环；
- pi-lens、TUI、Branch、Shell 和日志验证是 Practice Advisor 也依赖的生命周期基础；
- 若先修改 `context`、`agent_before_settle` 和运行时状态，会污染 Guard 生产准入基线；
- Engineering Practice 属于新增产品能力，不能用来掩盖未完成的 Guard 门禁；
- 先冻结设计可以让 Guard 评估顺带记录未来需要的质量样本，但两套指标必须分开。

### 执行阶段

#### P0-A：设计冻结

- 更新 requirements、design、knowledge-base 和本文；
- 明确 Guard/Practice/pi-lens 边界；
- 明确不调用第二个 LLM、一次性 review 和隐私约束。

#### P0-B：Guard 收尾（已完成）

- 空状态提示、pi-lens、真实 TUI bypass、HEAD 变化和 24 个任务全部完成；
- 已形成 Guard 生产准入结论，同时保持 experimental opt-in 与默认 Observe。

#### P1：Practice Advisory MVP（已实现）

- 已实现 Practice Signal、relevance/deduplication 和 Capsule；
- 默认 `suggest`，不增加阻断；
- 复用现有 Profile knowledge，未扩 schema；
- 已增加自动测试，并完成 SnailJob disposable worktree 只读 smoke；详见 [P1 验证结果](evaluations/practice-advisory-mvp-results.md)。

#### P2：一次性自审（已实现）

- 已实现 `agent_before_settle` 的 opt-in `auto-once`；
- task-local mutation relevance 降低简单修改干扰；
- review generation、token 和循环均受硬边界限制；
- Session/Branch、pi-lens、Shell 和真实 Pi `0.87.1` positive/negative 生命周期已验证。

#### P3：真实质量评估（已完成）

- 在 SnailJob/SnailAI 完成复杂业务、简单 API、状态流、兼容迁移、side effect 和 provider 变化任务；
- 6 个任务按 `off | suggest | auto-once` 执行 18 次真实 Pi run；
- 18/18 正确、简单任务干扰 0/2、无机械注释/过度拆分/模式滥用；
- 默认保持 `suggest`，`auto-once` 保持 opt-in，Profile schema 不扩展；
- 识别出 `scope-unknown` 抑制有效 Practice Signal 的运行时覆盖缺口。

#### P3-F：`scope-unknown` fallback（已完成）

- 仅接受 successful-read existing production target；
- suggest/auto-once 复用既有 target、预算和 one-shot 上限；
- 不创建 Snapshot、Scope、candidate、peer evidence 或 Guard 状态；
- SnailAI provider 恢复 `practice.variation-axis`，简单 API wrapper 继续无 Signal、无 continuation。

## 16. 当前结论

Engineering Practice 已作为与 Local Evidence、Guard 正交的产品能力实现，而不是对二者的简单扩展。当前架构是：

```text
Local Evidence 保持项目一致性
+ Project Profile 提供审核后的工程原则
+ Practice Signals 发现值得思考的结构风险
+ 当前 Agent 做有边界的一次性语义自审
+ pi-lens / 编译 / 测试完成机器验证
```

Guard 生产准入、P1 Advisory MVP、前置[整体架构必要性审查](evaluations/architecture-necessity-review.md)、P2 [auto-once](evaluations/practice-auto-once-results.md)、[后置架构复审](evaluations/auto-once-architecture-review.md)、[P3 真实质量评估](evaluations/practice-quality-p3-results.md)和 [`scope-unknown` fallback](evaluations/practice-scope-unknown-fallback-results.md)均已完成。证据支持默认继续为 `suggest`、`auto-once` 保持 opt-in，并继续不增加缓存、parser、Profile schema、平行 Git runtime 或第二个模型。
