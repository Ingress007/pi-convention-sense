# pi-convention-sense 项目知识库

本文是仓库的人类与 Agent 共用入口，用于快速理解产品边界、架构、不可破坏约束、变更路径和验证要求。详细需求、设计和历史结论仍以链接文档为准。

## 1. 当前基线

| 项目 | 当前值 |
|---|---|
| 开发版本 | `0.4.0-alpha.1`，未发布（包已具备 MIT 许可证与发布元数据，发布由维护者手动执行，流程见[兼容性矩阵](compatibility.md)） |
| Node.js | `>=22.19.0` |
| Pi | 当前开发与真实生命周期验证基线 `0.87.1`；peer dependency `*` 不代表全版本兼容 |
| TypeScript | `5.9.3`，strict + NodeNext |
| 运行时依赖 | 只有 `minimatch@10.2.5`（glob）；Pi 本身是 peer dependency |
| 自动测试 | `npm run verify`，306/306；`npm run coverage` 门槛 88/78/88%（行/分支/函数） |
| 真实 Pi 基线 | Pi `0.87.1`，SnailJob/SnailAI 主流程已验证 |
| Project Profile | `.convention-sense/profile.json` |
| Profile fingerprint | `f806157678d37814` |
| Profile review | `draft`；不得宣称 reviewed |
| 默认运行模式 | `observe` + fail-open |
| Guard | 既定生产准入门槛通过；继续 experimental opt-in、默认 Observe、Discovery-only |
| Engineering Practice | P1 Advisory、opt-in `auto-once`、后置架构复审、P3 质量评估与 `scope-unknown` fallback 已完成；默认 suggest，auto-once 保持 opt-in |
| 真实业务验收 | SnailJob Job Tag CRUD v2 已通过编译/前端检查，修改保留未提交 |
| 环境限制 | SnailAI Admin 缺少 `node_modules`，原生检查为 `ENVIRONMENT_BLOCKED` |

## 2. 产品定位

pi-convention-sense 为 Pi Coding Agent 提供基于真实仓库证据的局部编码惯例感知：

1. Agent 成功读取目标源码；
2. Extension 在目标 Git repository 内识别语言、模块和角色；
3. Candidate Finder 选择同仓库、同模块、同角色的可比实现，并用 Java declaration kind 与 TypeScript/Vue 文件语义后缀缩小误匹配；
4. Analyzer 提取重复事实并生成有 token 预算的 Snapshot；
5. Snapshot 与目标相关的 Knowledge Capsule 在下一轮 Context 注入；
6. 可选 Guard 只检查必要 Discovery 是否完成，不直接执行风格审查。

正常运行链路是确定性的本地代码，不调用第二个 LLM。Project Profiler Skill 可以显式使用当前 Agent 生成待审核 Profile candidate。

Engineering Practice P1 Advisory 与 P2 `auto-once` 已实现：Local Evidence 继续回答“项目附近通常怎样写”，确定性 Practice Signal/Capsule 回答“当前目标有哪些工程问题值得思考”；opt-in one-shot Runtime 只对相关 mutation 请求当前 Agent 自审一次。Practice 不改变 Guard 只约束 Discovery 的边界。

### 不做什么

- 不自动重构历史代码；
- 不因单个 Snapshot 创建长期项目规则；
- 不自动修改 `AGENTS.md` 或把 draft 升级为 reviewed；
- 不把 Global Pack 当作项目硬规范；
- 不跨 Git repository 复用候选、Snapshot 或 Profile trust；
- 当前实现不判断业务语义、注释必要性、架构质量或方法拆分是否合理；Practice 不会把这些主观判断直接升级为 Guard 阻断；
- 当前不支持小程序、移动端、React Native、UniApp 和桌面端。

## 3. 架构地图

| 路径 | 职责 | 修改时重点检查 |
|---|---|---|
| `extensions/index.ts` | Pi Extension 入口，生命周期、命令和各子系统接线 | 事件顺序、状态恢复、日志隐私、Context 注入、重启要求 |
| `src/runtime/` | 配置与校验、路径身份（`path-key`）、状态与 checkpoint、Context、日志（含符号链接防护）、handler 异常描述、glob 限制、racy-clean、XML 转义、状态栏 | trust、branch-local 状态、v1/v2/v3 兼容、敏感数据、fail-open |
| `src/observe/` | repository root、语言分析、Scope、候选、Evidence、Snapshot | repository 隔离、generated/test 排除、预算和 freshness |
| `src/guard/` | Guard 决策、工具映射、Git 后置审计 | 只阻断 Discovery、fail-open、bypass 精确消费 |
| `src/profile/` | Profile 加载、校验、Pack、选择器、解析和 Capsule | trust gate、schema、fingerprint、draft 降级、token 预算 |
| `src/practice/` | Signal analyzer、Capsule formatter、一次性 Review Runtime 与纯 boundary planner | advisory 默认、真实变化轴、低干扰、成本和隐私 |
| `skills/project-profiler/` | Profile init/adopt/refresh/diff 工作流 | candidate-first、显式批准、禁止覆盖 active Profile |
| `scripts/` | 可复用真实仓库评估工具 | 输出必须写入 `.tmp/pi-convention-sense/` |
| `test/` | Node 自动测试和固定 fixtures | 不依赖用户机器上的外部仓库或运行日志 |
| `docs/` | 需求、设计、研究、规范和永久评估结论 | 当前事实与历史结果分开记录 |
| `examples/` | 可复制到目标项目的配置示例 | 当前配置放 `examples/config/` |

### 3.1 主要依赖方向

```text
extensions/index.ts
  ├─ src/runtime
  ├─ src/observe
  ├─ src/guard
  ├─ src/profile
  └─ src/practice

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

- 所有 handler 自行捕获异常并 fail-open（Pi 不捕获 `tool_call` handler 的异常），被吞掉的错误只记录无消息的 `handler_error`；
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
- `/convention-reset confirm` 清空当前 Branch 状态并追加空 checkpoint；
- checkpoint 是整份账本快照，只在 `agent_settled` 与 `session_shutdown` 写入（不是每个 `tool_result`），且只保留最近 300 条成功读取；异常退出最多丢失最近一次 run 的账本，格式仍为 v3。

## 5. 不可破坏的安全约束

### 5.1 Guard 只约束 Discovery

允许阻断的核心缺口：

- `TARGET_NOT_READ`；
- `SNAPSHOT_MISSING`；
- `SNAPSHOT_STALE`；
- `SNAPSHOT_NOT_INJECTED`。

必须 fail-open 的典型场景：unsupported、excluded、scope unknown、analysis error、low confidence、weak/mixed evidence、no peer、insufficient peer。Guard 不得因为代码未遵循某种风格直接阻断。

### 5.2 仓库与信任隔离

- 目标文件决定 Candidate Finder 使用的 Git repository root；目标不在任何 Git 仓库且不在 Pi 启动目录内时，按以下顺序取项目根：TS/Vue 先取最近的 `package.json` 目录（若外层存在 pnpm/npm workspace 则取最外层 workspace 根，保证 `apps/<name>` 可见），再依次取 Maven/Gradle 最外层构建根、`src/main/java` 模块根，最后才是文件所在目录（此时目录语义丢失，分类退化为 unknown/production）；
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

### 5.5 Engineering Practice 边界

- Local Evidence 描述代码现状，不代表优秀实践；
- 注释建议只聚焦非显然的 why、约束和权衡，不追求注释数量；
- 拆分建议必须改善责任、失败边界或可测试性；
- 设计模式必须有真实变化轴，不为假设需求制造抽象；
- Practice 初期只 advisory，不新增 Convention Guard reason code；
- `agent_before_settle` 自审只使用当前 Agent、每任务最多一次且 Branch-local；
- P1 Advisory、P2 `auto-once` 与 P3 真实质量评估已完成；auto-once 保持 opt-in、Branch-local、每任务最多一次且不进入 Guard/checkpoint；
- P3 的 18 个 mode run 为 18/18 正确、简单任务干扰 0/2；证据不足以默认开启 auto-once、扩 Profile schema 或引入 parser；
- `scope-unknown` Practice-only fallback 已实现：只面向 successful-read existing production target，不创建 Snapshot/peer evidence、不改变 Guard fail-open。

### 5.6 路径与文件分类

- generated/test/role/workspace 判定只能使用**仓库相对路径**（`src/observe/repository-path.ts`）；仓库上层目录名（如 `D:\build\app`、`~/test/app`）不得影响分类；
- 路径比较、Set/Map key 一律使用 `pathKey`/`PathSet`（`src/runtime/path-key.ts`）：Windows/macOS 折叠大小写与盘符，Linux 保持大小写敏感；显示、日志和 checkpoint 保留原始拼写；Windows 的 `\\?\D:\…` 与 `\\?\UNC\…` 扩展前缀在 `pathKey`/`normalizeToolPath` 中剥离，符号链接/junction 不做 realpath 规范化（同一文件的不同拼写会被视为不同文件，后果只是需要用同一拼写重新读取）；
- 项目配置的 `logPath` 只能位于 `<configDir>/convention-sense/` 内；日志文件本身及其上的目录不得是符号链接或 junction，默认路径同样检查（不安全时关闭日志而不是写穿链接），logger 写入前还会再检查最终文件；
- 所有 Pi 生命周期 handler 必须自行捕获异常并 fail-open（Pi 不捕获 `tool_call` handler 的异常，抛出会阻断工具）；被吞掉的异常只记录 `handler_error`：事件名、错误名、错误码和栈顶非 Node 内部帧的函数与 `文件:行号`，**不记录错误消息**（解析/文件系统错误可能带源码片段），同一错误按第 1、10、100…次限流；
- 因为异常会被吞掉，测试必须断言 happy path 中没有 `handler_error`（`extension.test.ts` 的 `afterEach` 与 `pi-integration.test.ts` 的 `withHarness` 已自动检查，故障注入测试需显式声明 `allowHandlerErrors`）。

### 5.7 性能与资源边界

- 仓库文件索引只存路径：编辑已存在的文件不改变它；只有创建/删除源文件才失效（`noteFileChanged`，符号链接和目录不算），被截断（≥ 2 万文件）的索引保持不重建；因为 `git checkout/pull/stash`、代码生成不会被识别为风险命令，索引还会在超过 3 分钟或 `.git/HEAD` 变化时重扫；glob 一律用预编译缓存（`src/runtime/glob.ts`），不要在循环里调用 `minimatch()`；
- Snapshot freshness 与 Profile 加载使用 git 的 "racy clean" 规则（`src/runtime/racy-clean.ts`，只此一份）：mtime+size 不变且文件已足够旧（> 5s）才信任，否则回退到内容哈希/重读；
- Git 后置审计在 Pi 事件循环上同步运行：必须先截断再哈希，带 `--no-optional-locks` 和一次抓取共享的 3s 总时限，超限降级为 unavailable（fail-open）；
- token 预算用 `estimateTokens`（CJK 约 1 token/字，其余 4 字符/token），不要再用 `length / 4`；
- 超过 1 MiB 的源码文件不分析（`MAX_ANALYZED_FILE_BYTES`）：目标 fail-open 为 `analysis-error`，peer 跳过；
- 注入模型上下文的标签内容（路径、模块名、Profile 文本）统一用 `escapeXml`；
- Java 文本块 `"""` 是一个整体字符串，不能按"空字符串 + 开引号"处理；
- 分析器和命令分类在 Pi 事件循环上同步运行，正则必须在 1 MiB 内的任意输入上线性或有界：不要写 `[^x]*` / `[\s\S]*?` 这类对每个锚点都可能扫到文件末尾的无界模式，也不要写 `\w*(?:关键字)\w*` 这类对单个标识符二次的模式（用 `{0,N}` 或手写线性扫描）；`test/robustness.test.ts` 用对抗输入给每个分析器设 1 s 预算，新增正则要把它的最坏输入加进去；
- 字符串屏蔽/注释剥离按 UTF-16 下标写入，缓冲区必须用 `text.split("")`，不能用 `[...text]`（按码点会在 emoji 之后整体错位）；Java 行注释在 LF/CR/CRLF 处结束；
- glob 只接受 `isSupportedGlob` 通过的模式（≤ 512 字符，单段 `*` 连续段 ≤ 5、extglob 组 ≤ 3），否则视为永不匹配，因为 `minimatch` 对复杂模式指数增长并在 64 KiB 以上抛错；
- 标记为 stale 的 Snapshot 不再被 `getFresh` 返回，直到该目标被重新分析。

## 6. 配置和持久化路径

| 路径 | 是否提交 | 说明 |
|---|---:|---|
| `.pi/settings.json` | 是 | 本仓库开发时加载当前 Pi package |
| `.pi/convention-sense.json` | 可选 | 目标项目共享运行配置 |
| `.convention-sense/profile.json` | 是 | 当前仓库 active Project Profile |
| `.convention-sense/profile.candidate.json` | 否 | Profiler 审核中间文件 |
| `.pi/convention-sense/` | 否 | 本地运行日志（checkpoint 在 Pi 的 Session 文件里） |
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

### 修改 Engineering Practice

1. 不修改 Guard 的 Discovery-only 语义；
2. 先定义可解释 Signal，再设计 review question，不能直接指定模式；
3. MVP 先复用 Profile knowledge/convention，不提前扩 schema；
4. 默认 `suggest`，`auto-once` 必须显式启用并证明不会循环；
5. 覆盖简单任务低干扰、Session/Branch、pi-lens、预算和日志隐私；
6. 真实质量指标与 Guard 准入指标分开统计。

### 修改配置项或校验规则

1. 在 `src/runtime/config.ts` 增加字段、默认值、范围和诊断，非法值只回退该字段；
2. 同步 README 的配置参考、design §12 和 `examples/config/`；
3. 同步 `test/fuzz-state.test.ts` 的生成器与不变量；
4. 影响 Snapshot 内容的配置要进入 `createConfigFingerprint`。

### 新增或修改词法规则、glob、路径逻辑

1. 正则必须对任意不超过 1 MiB 的输入线性或有界，不要写会对每个锚点扫到文件末尾的无界模式；
2. 把该规则的最坏输入加进 `test/robustness.test.ts` 的对抗输入列表；
3. 用真实语料做修改前后的差分（例如对一个真实仓库的全部文件比较 facts），确认只有预期的差异；
4. 路径比较用 `pathKey`/`PathSet`，分类用 `classificationPath`，缓冲区按 UTF-16 下标；
5. glob 只通过 `src/runtime/glob.ts` 使用。

### 修改 Extension 生命周期

1. 查阅当前 Pi `0.87.1` Extension API；
2. 覆盖独立 Session、Branch、Context 和 tool result 顺序，并用真实 Pi 离线测试（`pi-integration`、`pi-lifecycle`）验证 runner 语义，不只用手写假 API；
3. 真实 Pi 验证后再扩大兼容声明；
4. 提醒用户重启 Pi 才能加载 Extension 代码变化。

## 8. 验证与发布门槛

### 8.1 当前真实项目结论

SnailJob 后端与 Admin 已完成 Profile、Pack、Local Evidence、Observe、Guard、Session/Branch/reset、跨仓库信任和隐私验证；并在真实 `master` 分支完成 Job Tag Management CRUD v2 业务开发验收。该修改未创建 commit，保留给人工审查。后端 compile、Admin typecheck/build、六种数据库方言审查和 `git diff --check` 均通过，namespace 由服务端会话推导。

SnailAI 后端与 Admin 已完成静态分析和 Pi 主流程回归。SnailAI Admin 因缺少 `node_modules` 未执行原生 typecheck、lint、format、build，分类为环境限制而非产品缺陷；本轮未安装依赖或修改 lockfile。

永久报告： [SnailJob 验收](evaluations/snail-job-pi-0.87.1-results.md)、[SnailAI 验收](evaluations/snail-ai-pi-0.87.1-results.md)、[Guard 生产准入](evaluations/guard-production-readiness-results.md)、[Practice P3 质量评估](evaluations/practice-quality-p3-results.md)、[`scope-unknown` fallback 评估](evaluations/practice-scope-unknown-fallback-results.md)、[发布就绪评估](evaluations/release-readiness-results.md)。原始证据保留在 `.tmp/pi-convention-sense/`，不纳入版本控制。

日常完整验证：

```bash
npm run verify
npm pack --dry-run
```

当前 `npm run verify` 包括：

- strict TypeScript `--noEmit`；
- 清理并构建 `dist/`；
- Node test runner 的 306 个测试（`dist/test/*.test.js` glob；包含真实 Pi 离线生命周期、种子化 fuzz、对抗输入性能和 Guard 判定表穷举）。`npm run coverage` 另有行/分支/函数 88/78/88% 门槛，当前 97.6/94.0/98.6%；`FUZZ_SCALE=20 npm test` 放大 fuzz 做一次性深度运行；`node scripts/benchmark-analysis.mjs` 给出合成大仓库的分析耗时（本地使用，不进 CI）。

提交前还应执行：

- `git diff --check`；
- Markdown 相对链接检查；
- JSON 解析和 Profile validate；
- package 内容断言；
- 临时目录、日志、密钥和大文件检查。

版本兼容和未验证环境见[兼容性与验证矩阵](compatibility.md)。扩大 Pi、Node 或 OS 支持范围前必须加入 CI 并运行真实 Pi 生命周期。

当前任务顺序：Guard 生产准入、[Engineering Practice](engineering-practice.md) P1 Advisory、前置[架构审查](evaluations/architecture-necessity-review.md)、[auto-once](evaluations/practice-auto-once-results.md)、[后置架构复审](evaluations/auto-once-architecture-review.md)、[P3 质量评估](evaluations/practice-quality-p3-results.md)和 [`scope-unknown` fallback](evaluations/practice-scope-unknown-fallback-results.md)均已完成。

## 9. 决策与文档索引

| 主题 | 文档 |
|---|---|
| 产品范围与验收 | [产品需求](requirements.md) |
| 系统设计与数据流 | [技术设计](design.md) |
| Profile、Pack、Knowledge Capsule | [Project Intelligence](project-intelligence.md) |
| 工程实践、Practice Capsule 与实施顺序 | [Engineering Practice](engineering-practice.md) |
| Adapter/Pack 开源贡献规范 | [贡献与测试规范](contributing-adapters-and-packs.md) |
| 永久/运行时/临时文件 | [文件生命周期](file-lifecycle.md) |
| 兼容声明和发布门槛 | [兼容性矩阵](compatibility.md) |
| Stage 0/1/2 历史 | [Spike](stage-0-spike.md)、[Observe](stage-1-observe.md)、[Guard](stage-2-guard.md) |
| 真实全栈证据 | [SnailJob 全栈验证](evaluations/snail-job-fullstack-results.md) |
| SnailJob Pi 验收 | [SnailJob Pi 0.87.1 结果](evaluations/snail-job-pi-0.87.1-results.md) |
| SnailAI Pi 验收 | [SnailAI Pi 0.87.1 结果](evaluations/snail-ai-pi-0.87.1-results.md) |
| Guard 生产准入 | [Stage 2 Guard 生产准入结果](evaluations/guard-production-readiness-results.md) |
| Practice Advisory MVP | [P1 验证结果](evaluations/practice-advisory-mvp-results.md) |
| Practice auto-once | [P2 验证结果](evaluations/practice-auto-once-results.md) |
| P1 架构必要性审查 | [审查结果](evaluations/architecture-necessity-review.md) |
| P2 后置架构复审 | [审查结果](evaluations/auto-once-architecture-review.md) |
| Practice P3 真实质量评估 | [质量结果](evaluations/practice-quality-p3-results.md) |
| Practice `scope-unknown` fallback | [评估结果](evaluations/practice-scope-unknown-fallback-results.md) |
| 发布就绪评估 | [发布就绪结果](evaluations/release-readiness-results.md) |
| 双项目测试计划与执行记录 | [SnailJob 与 SnailAI 全场景测试计划](evaluations/snail-job-snail-ai-test-plan.md) |
| 版本变化 | [更新日志](../CHANGELOG.md) |
| Agent 工作规范 | [AGENTS.md](../AGENTS.md) |

## 10. 更新本知识库

出现以下变化时同步更新本文：

- 目录或核心依赖方向改变；
- Guard 阻断语义、fail-open 边界或日志隐私改变；
- Engineering Practice Signal、Capsule、自审模式或 Guard 边界改变；
- Profile schema、Pack 规则或信任边界改变；
- Node/Pi/OS 兼容范围改变；
- 自动测试数量和发布门槛发生实质变化。

代码中的可执行检查始终优先于本文。如果文档与实现不一致，应先通过测试和真实运行确认，再同时修正文档与 Profile；不得为了让文档“正确”而隐藏实现差异。
