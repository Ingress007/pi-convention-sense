# pi-convention-sense 产品需求文档（PRD）

> 文档状态：方案草案（Draft）
> 版本：V1.1
> 源文档标注更新日期：2026-09-17
> 当前架构融合日期：2026-09-23
> 适用对象：项目负责人、Pi Extension 开发者、企业 Web 前后端开发者
> 原始资料：用户提供的 Notion 文档
> Project Intelligence 深入设计：[project-intelligence.md](./project-intelligence.md)

## 1. 产品定义

pi-convention-sense 是运行在 Pi Agent 中的“局部代码惯例感知层”。它在 Agent 修改代码前，自动发现当前模块中可重复验证的实现习惯，将证据临时注入当前会话，并在证据不足时进行提醒或拦截。

本产品解决的不是“再写一套编码规范”，而是企业老项目中以下普遍问题：

- 显式规范只能覆盖少量硬约束；
- 真正影响一致性的局部习惯大量存在于现有实现中；
- AI 常在未阅读足够同类代码时直接修改；
- 通用最佳实践不一定适合当前模块，盲目统一会扩大改动范围。

产品形态采用 **Pi Extension 为核心、Skill 为辅助**：Extension 负责自动触发、确定性分析、Profile Runtime 和 Guard 主流程；Project Profiler Skill 仅用于用户显式触发的项目知识候选生成、语义 diff 和 adopt。

当前产品使用三层信息源：

1. Global Baseline Pack：可组合技术栈基线，永远 advisory；
2. Project Profile / Knowledge：一仓库一份、可版本控制、可审核的长期项目知识；
3. Local Evidence：当前 Scope 从真实 peer 动态提取的局部代码事实。

一次 Local Evidence 不会自动写回 Project Profile。完整 Profile 不直接注入模型，只为当前目标解析有预算的 Knowledge Capsule。

## 2. 背景与问题

### 2.1 使用背景

目标用户通常在大型企业代码库或遗留项目中使用 Pi Agent/Codex 完成需求分析、方案设计、编码和测试。此类项目往往具有以下特点：

- 业务复杂，历史代码和遗留设计较多；
- 不同模块、分层、代码角色存在不同局部惯例；
- `AGENTS.md` 适合记录架构、安全、依赖边界等硬约束，不适合承载大量细碎风格；
- 编译、LSP、lint、format、测试可以验证明确规则，却无法完整表达“附近的人类代码通常怎样写”；
- 局部代码可能风格混杂，单个样本不能代表团队惯例。

### 2.2 核心问题

1. **修改前缺少同类实现阅读约束**：Agent 可能只读取目标文件就开始 edit。
2. **静态规范无法覆盖局部差异**：Controller、Service、Mapper、DTO 及不同模块可能采用不同习惯。
3. **偶然写法容易被误判为规则**：个人习惯或历史遗留不能自动升级为组织规范。
4. **全面规则维护成本过高**：人工维护的细粒度规范容易过期。
5. **现有能力缺少运行时串联**：`AGENTS.md`、pi-lens、pi-conventions 各自解决部分问题，但缺少局部惯例感知层。
6. **Shell/第三方工具可绕过 edit/write**：只依赖修改前拦截无法覆盖所有变更。

### 2.3 产品机会

在 Agent 动手前，自动回答：

- 当前正在修改什么语言、模块和代码角色？
- 当前区域内哪些同类实现最值得参考？
- 哪些模式被多个相关文件重复证明，哪些只是偶然或混杂？

## 3. 产品目标

- **G1 自动生效**：安装后无需用户反复提示“先学习项目规范”。
- **G2 证据驱动**：输出可追溯的局部惯例证据，不生成武断的永久规则。
- **G3 低干扰**：正常路径在 Agent 探索代码时完成发现，Guard 仅作兜底。
- **G4 作用域准确**：至少区分语言、模块和代码角色。
- **G5 上下文可控**：默认选择 2～4 个高相关参考文件，并限制注入 Token。
- **G6 会话安全**：Session、Branch 或源文件变化后不错误复用 Snapshot。
- **G7 渐进上线**：先 Observe，再 Guard，以真实任务评估准确率和误拦截率。
- **G8 生态互补**：不重复 pi-lens 的编译/LSP/lint 能力，不替代 `AGENTS.md` 的硬约束。
- **G9 项目知识可审核**：Project Profile 通过 candidate、validate、diff、显式批准和 adopt 建立，不静默覆盖。
- **G10 技术栈可组合**：语言、框架、架构、持久化、Transport 和 Build/Test 能力通过 Adapter 与 advisory Pack 组合。
- **G11 仓库信任隔离**：候选只来自目标 Git repository；Profile trust 只属于 Pi 启动仓库，不隐式扩展到外部路径。

## 4. 非目标

V1 明确不做：

- 自动重构历史代码；
- 自动生成或修改 `AGENTS.md`；
- 根据一次局部观察自动创建或覆盖永久项目规范；
- 未经显式审核把 draft Profile 升级为 reviewed；
- 跨项目学习、跨仓库候选复用或用户画像式长期记忆；
- 正常编码链路使用第二个 LLM、Subagent 或外部模型服务；
- 覆盖所有语言的完整 AST；
- 提供复杂 UI；
- 泛化评审设计优劣或架构先进性；
- 保证拦截所有 Shell/第三方工具产生的文件变更；
- 将局部惯例置于显式需求、硬约束、编译器、测试或安全规则之上。

## 5. 用户角色

- 在大型企业代码库中使用 Pi Agent 的后端开发者；
- 维护遗留项目、需要控制改动范围的工程师；
- 希望 AI 代码与现有模块保持一致的团队负责人；
- 需要通过 Observe 模式逐步验证和建立信任的工具维护者。

## 6. 典型场景

### 6.1 新增 Service 方法

Agent 读取 `OrderServiceImpl.java`。系统识别 Scope 为 `java:order:service-impl`，自动选取 2～4 个同模块或邻近模块的 ServiceImpl，提取构造注入、事务、异常、日志和返回模型等重复证据，并在下一次 LLM 调用前注入。

### 6.2 Agent 过早编辑

Agent 仅读取目标 Controller，尚无足够同类证据就调用 edit：

- Observe 模式允许修改，但记录并提示 `wouldBlock`；
- Guard 模式阻止本次修改，并说明需要补充的 Discovery；
- Agent 下一轮完成必要读取后可重新发起修改。

### 6.3 模块风格混杂

三个参考 Service 中两份使用构造注入，一份使用字段注入。系统不得输出“必须构造注入”，而应标记为 2/3 的主导模式，并明确存在反例；不得为统一风格而修改无关代码。

### 6.4 证据文件变化

Snapshot 生成后，任一证据文件被修改。系统在再次注入或 Guard 判断前校验 freshness，将 Snapshot 标记为 stale 并重新发现。

### 6.5 Shell 绕过前置 Guard

Agent 通过脚本修改源码。系统通过 Mutation Ledger、Git diff 或后置 Review 发现变更，并在任务结束前提示对应 Scope 缺少 Convention Evidence。

### 6.6 新建文件

系统根据目标路径和文件名推断 Scope，搜索同 Role 的 peer 后建立 Snapshot。若仓库确实没有同类实现，则降级使用硬约束和仓库级证据，不得造成永久阻塞。

### 6.7 Project Profile 细分同一 base role

Java `@Controller` 与 `@RestController` 都可先识别为 base role `controller`。受信 Profile 再根据 module、annotation 和 path 将其细分为 `mvc-view-controller` 与 `rest-controller`，Candidate Finder 不混用两个 subtype。Profile 缺失或无效时 fail-open 回 base role 与 Local Evidence。

### 6.8 TypeScript/Vue 与 workspace

Agent 读取 Vue route page、route-local component、hook、API service、request client、Pinia store、router、layout 或 workspace package。系统识别独立 role，并优先从同 role、同 workspace package 选择 peer，避免主应用与可复用 package 混用。

### 6.9 读取外部仓库

Pi 从仓库 A 启动却读取仓库 B 的绝对路径时，候选仍严格限制在 B 的 Git repository；A 的 Profile 不应用到 B，B 的 Profile 即使存在也标记为 `ignored`。用户必须从 B 根目录显式批准并启动新的 Pi 才能加载 B 的 Profile。

## 7. 功能需求

| 编号 | 优先级 | 需求 | 验收要点 |
| --- | --- | --- | --- |
| FR-01 | P0 | Extension 自动注册并监听 Pi 生命周期事件 | 新 Session 自动生效，无需显式调用 Skill |
| FR-02 | P0 | 记录成功完成的源码读取 | 只以成功的 `tool_result` 为准，已发出的 `tool_call` 不计数 |
| FR-03 | P0 | 识别 Convention Scope | V1 支持 language + module + role；Java 角色覆盖首版清单 |
| FR-04 | P0 | 自动发现并排序同类候选 | 默认返回 2～4 个 peer；目标文件本身不计入 |
| FR-05 | P0 | 构建重复模式 Evidence | 记录 support、samples、confidence、来源和反例；单文件模式不得升级为惯例 |
| FR-06 | P0 | 在 `context` 阶段注入有效 Snapshot | 只注入与当前修改相关的 Scope；不写入项目文件或永久 Prompt |
| FR-07 | P0 | edit/write 前执行 Convention Guard | Observe 只记录；Guard 可 block，并返回明确补救说明 |
| FR-08 | P0 | Snapshot 缓存与失效 | Evidence、Scope 或 Branch 变化时不得复用过期 Snapshot |
| FR-09 | P1 | 支持 Session 恢复和 Branch 切换 | V1 可在切换时清空重建；Branch A 的 Snapshot 不得用于 Branch B |
| FR-10 | P1 | 记录修改账本 | 可追踪目标文件、Scope、修改方式及是否具备有效 Evidence |
| FR-11 | P1 | 任务结束后输出可选审计结果 | 只报告重大惯例偏离或证据缺口，不评价是否采用“更先进模式” |
| FR-12 | P1 | 支持项目级行为配置 | 控制模式、阈值、文件数、排除路径和上下文预算，不承载编码规则 |
| FR-13 | P2 | 提供 Project Profiler Skill | 支持 init/adopt/refresh/diff；candidate-first，显式批准后才更新 active Profile |
| FR-14 | P0 | 加载受信 Project Profile | 校验 schema、repository root、selector 白名单和 fingerprint；missing/invalid/ignored 时 fail-open |
| FR-15 | P0 | 支持 Global Pack catalog | Pack 由 Profile 显式启用，id/version 参与 freshness，任何 hard 项均降级为 advisory |
| FR-16 | P0 | 支持 effective role | 保留 base role，并用 Profile/Pack selector 隔离项目 subtype 候选 |
| FR-17 | P0 | 注入 Knowledge Capsule | 只注入当前目标匹配的 module/technology/knowledge/convention；与 Snapshot 共享 token 预算 |
| FR-18 | P0 | 支持 TypeScript/Vue Adapter | 覆盖 page、component、hook、API、request、store、router、layout 和 workspace package |
| FR-19 | P0 | 强制 repository/Profile trust 隔离 | 不跨仓库取 peer，不从当前会话隐式加载外部仓库 Profile |
| FR-20 | P1 | 提供 Profile/Pack 状态诊断 | `/convention-status` 展示 config source、Profile status/review/fingerprint、active Packs 和 diagnostics |

## 8. Scope 与候选要求

### 8.1 Scope 最小维度

每个目标至少按以下维度识别：

- `language`：Java、TypeScript 或 Vue；
- `module`：Maven/Gradle module、业务边界或 workspace package；
- `role`：语言 Adapter 给出的 base role；
- `effectiveRole`：可选的 Profile/Pack 项目 subtype；
- `architecture` / `profileTags`：可选目标上下文；
- `profileFingerprint`：参与 Snapshot freshness；
- `root`：作用域根目录；
- `confidence`：识别置信度。

Scope Key 使用 `language:module:(effectiveRole ?? role)`。候选兼容性先保持 base role，再在 Profile 生效时隔离 effective role。

### 8.2 Java V1 角色

- `*Controller.java` → controller；
- `*Service.java` → service-interface；
- `*ServiceImpl.java` → service-impl；
- `*Mapper.java` → mapper；
- `*Repository.java` → repository；
- `*Req.java` / `*Request.java` → request-dto；
- `*Resp.java` / `*Response.java` / `*VO.java` → response-dto；
- `*Entity.java` 或 `@Entity` → entity。

识别时可结合 package、注解、接口/继承关系等信号提高置信度。

### 8.3 TypeScript/Vue 角色

- route page；
- shared、route-local 与 layout-local component；
- hook/composable；
- API service；
- application/workspace request client；
- Pinia store；
- router；
- layout；
- workspace package。

Workspace package 默认是候选边界。Generated declaration、build output、vendor 和 test 文件不进入 production Evidence。

### 8.4 Profile refinement

Profile selector 只能使用声明式白名单字段：paths、excludePaths、languages、modules、baseRoles、fileNames、annotationsAny、dependenciesAny。禁止脚本、命令、可执行正则和未知字段。多个 override 按 priority 与 selector specificity 稳定选择。

### 8.5 候选约束

- 候选必须位于目标文件所属 Git repository；
- 与目标文件语言/扩展名和 base role 一致；
- Profile 生效时还必须与 effective role 兼容；
- workspace 项目默认不跨 package；
- 默认排除 generated、build、target、vendor、test fixture 等路径；
- 目标文件本身不计入 peer；
- 默认优先 production code；
- 同 Scope 候选不足时，按同目录、同模块、邻近模块、仓库级同 Role 逐层扩大；
- 最终默认选择 2～4 个候选；
- 候选不足时标记 weak，不得伪造高置信度结论。

## 9. Evidence 与置信度要求

每条 Observation 至少包含：

- 唯一标识与类别；
- 被观察到的 pattern；
- 支持数量 `support`；
- 样本数量 `samples`；
- `high / medium / low` 置信度；
- 支持证据文件；
- 反例文件。

建议阈值：

- **High**：至少 3 个样本，支持率 ≥ 80%，且 Scope 置信度高；
- **Medium**：至少 2 个样本，支持率 ≥ 60%；
- **Low**：样本不足、支持率较低、Scope 退化或存在明显反例；
- **Mixed**：没有足够主导模式，应展示主要分支，不进入 Guard 的风格强判断。

Java 首版优先覆盖以下确定性信号：

- 依赖注入方式；
- 类、接口、方法注解；
- 事务注解位置；
- 异常类型与错误码；
- 日志框架、参数化日志和业务标识；
- DTO/VO/Req/Resp 命名；
- 返回包装类型；
- converter/mapper 工具复用；
- null/Optional 处理；
- 常见方法可见性、override 和命名结构；
- Controller→Service、Service→Mapper/Repository 的依赖形态。

V1 不尝试仅靠正则判断复杂业务语义、领域建模优劣或方法拆分质量。

## 10. Guard 业务规则

### 10.1 最低放行条件

- 目标文件已成功读取，或属于明确的新建文件；
- Scope 已识别；
- 当前 Branch 下存在未过期 Snapshot；
- Evidence 文件数达到阈值，或已确认仓库无足够同类实现；
- Snapshot 已在最近一次相关 `context` 中注入，或仍处于有效窗口。

### 10.2 Observe 模式

- 永不阻塞；
- 记录 `allow / wouldBlock / reason`；
- 收集候选准确率、弱证据率和潜在误拦截；
- 作为默认上线模式。

### 10.3 Guard 模式

- 对 edit/write 执行阻止；
- 返回缺少条件与建议候选；
- 支持项目级例外和单次 bypass；
- 只对“缺少发现流程”做 Guard，不因 Low Confidence 的风格差异硬阻止；
- 新文件或无 peer 场景不得陷入永久阻塞。

## 11. 决策优先级

系统应按以下顺序处理冲突：

1. 用户当前明确需求；
2. 安全边界、编译器、Linter、类型系统和测试；
3. `AGENTS.md` 等明确项目约束；
4. reviewed Project Profile 中的 hard knowledge；
5. 当前 Scope 内多文件 Local Evidence；
6. reviewed advisory Profile；
7. draft Profile；
8. Global Pack；
9. 通用最佳实践。

Draft Profile 中的 hard 项和 Global Pack 中的任何 hard 项都必须降级为 advisory。Local Evidence 是当前代码事实，不是自动生成永久规则的依据；与 reviewed hard knowledge 冲突时保留双方来源并提示，不静默覆盖。

## 12. 非功能需求

- **性能**：首次 Scope 发现的额外本地分析目标为亚秒到低秒级；不得每轮扫描全仓库。
- **Token**：单个 Snapshot 默认不超过 1200 tokens，仅包含必要证据和路径引用。
- **可靠性**：分析失败不破坏 Pi 主流程；Observe 降级为日志；Guard 返回可操作说明。
- **隐私**：正常运行不向独立模型或外部服务发送源码；日志不记录源码、edit/write 正文、完整 prompt 或完整 Shell 命令。
- **信任隔离**：Profile 只从受信启动仓库加载；外部仓库路径不会隐式扩大信任。
- **可解释性**：Observation 可回溯到 Evidence；Profile knowledge/convention 可回溯到 manifest、config、source、documentation 或 user-review。
- **可配置性**：支持仓库级启停、模式、排除路径、候选数和阈值配置。
- **兼容性**：不侵入 Pi Core，只使用公开 Extension API。
- **可测试性**：Scope、Ranker、Evidence、Cache、Formatter、Guard 可独立测试。
- **可观测性**：Observe 输出 Scope、候选排名、Snapshot 生成/失效和 Guard 决策。

## 13. 异常与降级要求

- 无足够候选：标记 weak 并明确说明，不得虚构惯例；
- Scope 冲突：选择保守 Scope 或标记混合，Observe 模式不中断；
- 分析器异常：记录错误并降级，默认建议 fail-open；
- 超大仓库：使用索引、目录限制和缓存；
- 并行工具：只在成功 `tool_result` 后计入 Read Ledger；
- 文件删除/重命名：Snapshot 失效并重新发现；
- Shell 修改：标记为 `post-check required`；
- 用户明确采用新模式：用户需求优先，但避免顺手重构无关代码；
- 测试代码与生产代码冲突：默认 production code 优先；
- 生成代码：默认排除，除非显式配置纳入。

## 14. V1 验收标准

### 14.1 Observe 版本

- [x] 安装后无需用户显式调用即可生效；
- [x] 只有成功 read 才进入 Read Ledger；
- [x] 能识别约定的 Java 角色与模块 Scope；
- [x] 每个目标 Scope 可选择 2～4 个可解释候选，或明确报告候选不足；
- [x] 每个 Observation 包含支持数、样本数、置信度、Evidence 和必要反例；
- [x] Snapshot 通过 `context` 注入并遵守 Token 上限；
- [x] 不修改项目文件、`AGENTS.md` 或永久 Prompt；
- [x] Branch 切换和 Evidence 变化后不复用过期 Snapshot；
- [x] Observe 能记录 `wouldBlock` 而不实际阻塞；
- [x] 分析失败时主流程安全降级；
- [x] 单元测试和关键集成场景通过；
- [x] 提供配置、架构和局限性说明。

### 14.2 Guard 版本附加标准

> 当前未勾选项是有意保留的未完成准入门槛，不代表实现缺失：真实 TUI 手动命令、HEAD 变化 Shell 场景、20～30 个企业任务和 pi-lens 同时安装联调仍未完成。Guard 因此继续保持 experimental opt-in。

- [x] edit/write 缺少有效 Evidence 时能稳定 block（Fixture 与真实 Pi 合成流程）；
- [x] 返回的信息足以让 Agent 下一轮自行补救；
- [x] 新文件和无同类实现项目不会永久阻塞；
- [x] 支持项目级禁用和明确 bypass；
- [ ] 与并行 Tool Call、pi-lens 组合时无死循环（并行 Tool Call 已验证；同时安装 pi-lens 的真实任务联调未完成）。

### 14.3 Project Intelligence 附加标准

- [x] Profile trust、schema、repository root、selector 和 fingerprint 有正反例测试；
- [x] draft hard 与 Global Pack hard 均降级为 advisory；
- [x] Profile effective role 能隔离 MVC/REST 等相邻 subtype；
- [x] Knowledge Capsule 只包含目标相关知识并遵守预算；
- [x] Profile/Pack 变化使旧 Snapshot stale；
- [x] TypeScript/Vue role 与 workspace package 隔离有 fixture 和 Extension 测试；
- [x] 外部 repository Profile 为 `ignored`，且候选仍限制在外部目标 repository；
- [x] Profiler helper 支持 validate、fingerprint 和 semantic diff；
- [x] SnailJob 后端与前端完成 Profile + Pack + Local Evidence 全栈验证。

## 15. 评估指标

| 指标 | V1 建议目标 |
| --- | --- |
| Top-K 候选人工认可率 | ≥ 80% |
| 高置信 Observation 准确率 | ≥ 90% |
| Observe 潜在误拦截率 | ≤ 10% |
| 平均 Snapshot Token | ≤ 1200 |
| 首次分析交互延迟 | 可接受，且不触发每轮全量扫描 |
| Branch 串用 Snapshot | 0 |

## 16. 发布范围与优先级

1. **阶段 0：技术 Spike**：验证 Pi 事件 payload、工具名、并行工具、Context、block、Branch 和 `agent_settled`。
2. **阶段 1：V1 Observe**：Java Scope、候选排序、确定性 Evidence、Context 注入、Ledger、Cache 和指标。
3. **阶段 2：V1 Guard**：edit/write Guard、补救提示、bypass、fail-open、pi-lens 联调和 Shell 后置检查。
4. **阶段 3：V1.1 Project Intelligence**：v3 checkpoint、Profile/Pack/effective role、Knowledge Capsule、Profiler Skill、TypeScript/Vue Adapter 和全栈验证。
5. **阶段 4：产品化与扩展**：新 Pi 版本兼容矩阵、更多真实仓库、更多 Adapter/Pack、CI/发布自动化和 Guard 准入评估。

## 17. 主要风险

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| 候选选错 | 注入错误局部风格 | Scope 分层、排名解释、Observe 评估、限制 Top K |
| 遗留坏习惯被当作惯例 | 延续技术债 | 显式约束优先、惯例只作偏好、保留反例、禁止无关重构 |
| 上下文膨胀 | 成本和注意力下降 | Token 预算、只注入活跃 Scope、证据摘要 |
| Guard 打断工作流 | 用户体验下降 | 先 Observe、默认 fail-open、bypass、明确补救路径 |
| 并行工具竞态 | 误判已读取 | 仅成功 `tool_result` 进入 Ledger |
| Shell 绕过 | 前置检查缺失 | Mutation Ledger、Git diff、`agent_settled` 后置审计 |
| Session/Branch 污染 | 注入错误证据 | Branch checkpoint、失效重建、不跨 Branch 复用动态授权 |
| Profile 信任扩大 | 外部仓库知识进入当前会话 | Profile 只按受信启动仓库加载；外部状态为 `ignored` |
| Profile/Pack 过度权威 | 通用规则覆盖真实项目 | draft hard 与 Global Pack hard 降级，Guard 不因风格差异阻断 |
| Pi API 变化 | Extension 失效 | Spike、精确开发依赖、CI 和真实 Pi 生命周期矩阵；peer `*` 不作为兼容证据 |

## 18. 待确认事项与阶段 0/1 决策

| 事项 | 状态 | 当前结论 |
| --- | --- | --- |
| Pi Agent 目标版本和兼容声明 | 已决 | 当前开发、类型检查与真实生命周期基线为 `0.87.1`；按 Pi package 规范使用 peer `*`，但不据此声明其他版本已验证 |
| read/edit/write/bash 工具名称与 payload | 已决 | 采用 0.87.1 内置 `read/edit/write/bash/powershell` 的导出类型 |
| 成功读取的入账时机 | 已决 | 仅成功 `tool_result` 入账；pending sibling read 不计 Evidence |
| Guard 默认降级策略 | 已决 | 默认 Observe 和 fail-open；Guard 必须显式启用 |
| Session/Branch 状态隔离 | 已决 | Ledger 使用 active-branch v3 checkpoint，并兼容 v1/v2；Snapshot 在 resume/`/tree` 后根据 `recentReads` 重建 |
| Context 是否持久化 | 已决 | 稳定原则使用 0.87.1 normalized `systemPromptOptions.sections`；动态 Snapshot 通过 `context` 临时注入，不写 Session |
| 诊断与重置入口 | 已决 | 提供 `/convention-status`、`/convention-snapshot` 和显式确认的 `/convention-reset confirm` |
| V1.1 语言和构建系统 | 已决 | 支持 Java/Maven/Gradle 与 TypeScript/Vue/pnpm workspace；各语言使用独立 Adapter |
| 模块识别优先级 | 已决 | 最近构建边界优先；根构建下使用角色 package 前的业务段；最后退化为 source/path |
| Java 解析策略 | 已决 | 词法清洗 + 有边界结构规则；真实误判证明不足时再升级完整 parser |
| 首批确定性 Observation | 已决 | 已实现注入、注解、事务、异常、日志、返回包装、映射、null 和依赖形态等信号 |
| 候选搜索性能 | 已决 | 文件索引 + 路径初筛 + Top 20 深分析 + 最终 2～4 peer |
| Snapshot freshness | 已决 | 校验 mtime、size、SHA-256、配置版本和分析器版本 |
| Observe 运行多少真实任务后发布 Guard | 待企业项目评估 | 实验 Guard 已实现但默认仍为 Observe；完成 20～30 个任务并达到 80% / 90% / 10% 门槛后决定发布 |
| V1.1 是否使用 `appendEntry` 持久化 Snapshot | 部分已决 | Ledger 已升级到兼容 v1/v2 的 v3 custom entry；Snapshot 仍只在内存并按分支重建 |
| Guard 对 weak/mixed/no-peer 的策略 | 已决 | Guard 只拦 Discovery 缺口；weak/mixed/no-peer 和低 Scope fail-open，避免永久阻塞 |
| 新文件 Guard | 已决 | 使用 prospective Snapshot；有 Evidence 时先注入再 write，无 peer 时放行 |
| bypass 与项目例外 | 已决 | 精确路径单次 bypass，不跨分支；项目例外使用 `guard.pathExceptions` glob |
| Post-change 使用 Git diff、watcher 或组合 | 已决 | 使用执行前 Git baseline、dirty fingerprint、执行后状态/HEAD diff；不采用常驻 watcher |
| 第三方工具映射 | 已决 | 受信配置显式声明 `toolName + operation + pathField`；内置映射不可覆盖 |
| pi-lens 联调 | 待更多真实任务 | 未映射诊断工具不进入 Guard；仍需真实同时安装验证无死循环 |
| Project Profile 生命周期 | 已决 | candidate → validate/fingerprint → semantic diff → 显式批准 → adopt；默认 draft |
| Pack 权威性 | 已决 | Global Pack 永远 advisory，只由受信 Profile 显式启用 |
| Profile 加载边界 | 已决 | 一仓库一 Profile；只按 Pi 启动仓库加载，外部仓库 Profile 为 `ignored` |
| Profile 注入策略 | 已决 | 不注入完整 Profile，只生成目标相关 Knowledge Capsule，并与 Snapshot 共享预算 |
