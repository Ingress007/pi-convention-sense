# 更新日志

本文件记录 `pi-convention-sense` 的重要变化。项目尚未发布稳定版本；版本号用于标记可复现的开发基线。

## [Unreleased]

### 修复

- **fail-open**：所有 Pi 生命周期 handler 统一捕获异常并只记录 `handler_error`（事件名、错误名、错误码，不含错误消息）。Pi 的 `tool_call` 不捕获 handler 异常，此前任何未捕获异常都会在 observe 模式下阻断用户的 edit/write；
- **路径分类**：generated/test/role/workspace 判定只使用仓库相对路径。此前项目位于名为 `build`、`target`、`generated`、`dist`、`test`、`tests` 的目录下会被整体判为 generated/test，Snapshot 与 Practice 静默失效；
- **Windows/macOS 路径**：read ledger、Snapshot cache、Guard bypass/注入记录、post-change audit 和 Practice runtime 统一使用 `pathKey`（Windows/macOS 折叠大小写与盘符，Linux 保持大小写敏感），修复大小写或盘符不同导致的误报 `TARGET_NOT_READ` 以及目标被列为自身 peer；显示路径保持磁盘原样；
- **`logPath` 约束**：项目配置的 `logPath` 必须位于 `<configDir>/convention-sense/` 内且不得经过符号链接或 junction，否则回退默认路径并给出诊断；
- **日志符号链接**：`logPath` 校验现在覆盖日志文件本身（此前只检查父目录），默认路径和未信任项目也同样检查；仓库提交指向外部文件的符号链接时不再被追加写入，默认路径不安全则关闭日志；logger 写入前再检查一次最终文件；
- **非 Git 项目根**：目标不在 Git 仓库且不在 Pi 启动目录内时，TS/Vue 取最近 `package.json` 目录（外层有 pnpm/npm workspace 则取最外层 workspace 根），避免仓库相对路径退化成文件名导致 role 变 unknown、测试文件被当成生产代码；
- **排序器大小写**：Java/TS 候选排序里同目录、同 workspace root、父目录名比较改用 `samePath`/`foldPathCase`，大小写不同的合法 Windows 路径与精确路径得到完全相同的 peer、level 和分数；
- **`handler_error` 可定位**：记录栈顶非 Node 内部帧的函数与 `文件:行号`（仍不记录错误消息），同一错误按第 1、10、100…次限流；happy-path 测试自动断言没有被吞掉的 handler 错误；
- 评估脚本 `evaluate-java-repository.mjs` 同样改用仓库相对路径分类，并复用共享的 `isPathInside`（此前各文件有 6 份私有拷贝）；
- **checkpoint 体积**：checkpoint 改为在 `agent_settled` 和 `session_shutdown` 写入（不再每个 `tool_result` 写一条），且只保留最近 300 条成功读取（按最近读取排序）；500 次读取的会话从约 18.5 MiB 降到 0.04 MiB。格式仍为 v3，旧 checkpoint 无需迁移；
- **正则二次复杂度（ReDoS）**：同步分析在 Pi 事件循环里运行，旧实现对异常文件会冻结 Agent。TypeScript 模块依赖提取改为线性扫描（纯类型声明文件 576 KB 即需 1.7 s，对抗输入 20–27 s）；Java 构造器/`@Transactional`/`throw new`/泛型返回类型/字段注入/日志占位符/`^\s*import`、Vue `<script>`/`<style>`/`<!--`、`defineStore`、Practice `case`/标识符关键字、Shell 的 `sed`/`python` 参数检测全部改为有界或线性匹配。1 MiB 对抗输入最坏约 1 s（此前 5–84 s）；真实语料（SnailJob 1,661 个文件）与改动前逐字段对比仅 2 处无害差异；
- **emoji 偏移**：TypeScript 与 Practice 的注释/字符串屏蔽用 `[...text]`（按码点）却按 UTF-16 下标写入，注释里出现 emoji 后屏蔽整体后移，后面真实的 import 或 `@Transactional` 被误屏蔽；
- **glob 安全**：`minimatch` 对单段含 6 个以上 `*` 的模式耗时指数增长（7 个 `*` 约 4.5 s）、对超过 64 KiB 的模式直接抛错。现在 `isSupportedGlob` 拒绝过长或过复杂的模式（视为永不匹配），配置里的 `exclude`/`guard.pathExceptions` 给出诊断；
- **配置与 checkpoint 校验**：`includeLanguages` 中的未知语言（如拼写错误）现在给出诊断并被过滤，空列表也给出提示；checkpoint 计数必须是非负安全整数，恢复时 `successfulReads` 同样限制为最近 300 条，损坏的 checkpoint 回退到上一份有效 checkpoint；
- **Snapshot stale 粘性**：`invalidatePath`/配置变化标记为 stale 的 Snapshot 此前在文件恢复一致后会再次作为「新鲜」返回（仍带 `stale` 状态，Guard 会报 `SNAPSHOT_STALE`）；现在 stale 保持到该目标被重新分析为止；
- **Windows 路径**：`\\?\D:\repo\A.java`、`\\?\UNC\server\share\a.java` 现在与普通写法被视为同一文件（`pathKey`、`normalizeToolPath`），此前被当作仓库外的另一个文件；
- **行结束符**：Java 行注释、块注释与字符串屏蔽按 LF/CR/CRLF 处理（此前 CR-only 文件的 `//` 注释会吞掉其后所有内容）；SnailJob 1,591 个文件在三种行结束符下的 facts 与 Practice Signal 完全一致；
- **workspace 误判**：`packages/loose.ts` 这类直接位于 `packages/` 下的文件不再被当作名为 `loose.ts` 的 workspace package。
- **“Snapshot 已注入”按证据身份判断**：Guard 此前用 Snapshot 的创建时间判断模型是否见过它，编辑目标文件会重建 Snapshot，于是同一轮里紧接着的下一次编辑被 `SNAPSHOT_NOT_INJECTED` 阻断，要等下一次 Context。现在按证据身份（Scope、peer 路径与内容哈希、Observation、配置 fingerprint）判断，目标自己的内容和创建时间不参与；peer 或 Observation 变化仍需重新注入；
- **分析错误消息不再写入日志**：`snapshot_skipped` 此前记录原始错误消息（可能带路径或文本），与「日志不含错误消息」的约束不一致；现在只记录错误类名、错误码和抛出位置，消息仍保留在返回值里供调用方和测试使用。

### 性能与体验

- **文件索引**：索引只存路径，编辑已存在的文件不再清空索引；只有创建或删除源文件才重建（`noteFileChanged`，符号链接和目录不会触发）；索引被截断（≥ 2 万文件）时无法判断，保持不重建；索引超过 3 分钟或 `.git/HEAD` 变化（切换分支）时也会重扫，覆盖 `git checkout/pull/stash`、代码生成等未被识别为风险的改动；`minimatch` 改为预编译缓存（`src/runtime/glob.ts`，Profile selector 同步使用）；`classificationPath` 对规范化路径走字面前缀快路径。2 万文件级合成仓库实测：编辑后重分析约 4.5s → 0.2–0.5s，冷索引约 4.8s → 1.0–2.3s（多次实测，随机器负载波动）；
- **freshness 与 Profile**：Snapshot freshness 采用 git 的 "racy clean" 规则，mtime 与 size 都没变且文件在快照创建时已足够旧（> 5s）就不再重读并哈希；Profile 加载按 mtime+size 缓存（同样的 racy 规则，信任判断先于缓存），Profile 修改仍立即生效；
- **Git 后置审计有界化**：状态条目先排序并截断到 `maxChangedFiles`，之后才对保留的条目算指纹（此前对所有脏文件哈希后才截断）；`git` 加 `--no-optional-locks`，一次抓取共享 3s 的总时限（不是每次调用各 10s），超时降级为 `available:false`；shell 风险正则不再把 `2>/dev/null`、`> nul`、`> $null`、引号内的 `>`、`npm install`/`mvn clean install`（包括 `cd x && npm install` 这类复合命令）等视为修改风险；
- **token 估算**：`estimateTokens` 识别中日韩字符（约 1 token/字，ASCII 仍为 4 字符/token），此前对中文低估 2–4 倍；Snapshot 在预算放不下时不再硬截断（此前会注入没有闭合的 `<local-convention` 标签），而是返回闭合的最小形式和真实估算值，由调用方跳过；`estimateTokens` 不再为每个字符分配闭包；两处 racy-clean 判断合并为 `isRacyClean`；
- **`/convention-status`**：显示 `project-trusted`、`languages`；根目录有 `package.json` 且有 web 证据（`tsconfig.json` 或依赖 TypeScript/Vue）但未启用 TypeScript/Vue 时给出提示（不改变默认行为）；README 按 Pi 实际信任规则更正；
- **XML 转义**：Snapshot 与 post-change 审计消息中来自仓库的名称、路径统一转义（`src/runtime/xml.ts`，Practice/Profile capsule 复用，删除两份私有拷贝）；
- **分析器上限**：超过 1 MiB 的源码文件不读取不分析（目标 fail-open 为 `analysis-error`，peer 被跳过）；Java 文本块（`"""`）在注释剥离、字符串屏蔽和 Practice 屏蔽中按整体字符串处理，修复块内引号个数为奇数时整个文件状态错位。

### 新增

- **离线真实 Pi 生命周期测试**（`test/pi-integration.test.ts`、`test/support/pi-session.ts`）：用 Pi `0.87.1` 真实的资源加载器、agent loop、工具 runner 与 Extension runner，由 `@earendil-works/pi-ai` 自带的 faux 脚本化模型驱动，无需网络与凭据。覆盖 manifest 加载、Guard 阻断/放行、并行工具时序、`tool_call` 异常 fail-open、checkpoint 与真实分支导航、auto-once 单次续跑及简单修改静默；
- `npm run coverage` 与 CI 覆盖率门槛（行 ≥ 88%、分支 ≥ 78%、函数 ≥ 88%，只统计 `src/` 与 `extensions/`）；CI 增加 `@earendil-works/pi-ai` 版本断言，package job 增加生产依赖 `npm audit`；
- 开发依赖新增 `@earendil-works/pi-ai@0.87.1`（仅测试使用，不进入发布包；因 Pi 自带 `npm-shrinkwrap.json`，它是与 Pi 嵌套副本并存的第二份实例）；
- **全面测试（阶段 D）**：测试从 70 增至 306（含阶段 E），行/分支/函数覆盖率 97.6/94.0/98.6%。新增：对抗输入线性性能测试（`robustness.test.ts`）、配置与 checkpoint 种子化 fuzz（`fuzz-state.test.ts`，`FUZZ_SCALE=N` 可放大）、随机生命周期事件序列 fuzz（`lifecycle-fuzz.test.ts`：乱序/重复/缺字段事件 + 随机文件系统变化，断言 fail-open、Guard 契约、checkpoint 可恢复、日志不含 prompt/命令/源码/工具输出）、Guard 判定表穷举（`convention-guard.test.ts`，16,384 种输入组合）、Profile selector/resolver、Snapshot cache、Git 审计（真实 Git 仓库）、Snapshot/Practice/Knowledge capsule、TS scope、`/convention-status`、Windows 路径与行结束符；真实 Pi 下的 `/convention-*` 命令、compaction 与 reload（`pi-lifecycle.test.ts`）。所有关键测试均做过变异验证；
- `scripts/benchmark-analysis.mjs`：合成大仓库基准（冷分析、重复分析、编辑/新文件后重分析、freshness、堆增长），仅本地使用，不进 CI。
- **阶段 E（清理、发布准备、命令体验）**：
  - `/convention-status` 新增 `last-guard=` 行（最近一次 Guard/Observe 判定的 action、reason code、工具和路径，不含内容），重置后清空；`/convention-snapshot [path]` 可查看指定目标的 Snapshot，并说明为什么没有（未读取、语言未启用）；`/convention-bypass` 增加路径补全（按 Guard 最近问过的目标，仅 guard 模式且允许 bypass 时）；
  - 发布元数据：MIT 许可证与 `LICENSE`、`author`/`repository`/`bugs`/`homepage`、去掉 `private`、`prepublishOnly` 先跑 `npm run verify`；`scripts/` 不再随包发布（它们导入未发布的 `dist/`）；`test/package.test.ts` 断言发布内容与元数据；`scripts/smoke-package-install.mjs` 把 `npm pack` 的包解开、只装生产依赖、用真实 `pi` 装进干净项目并检查扩展加载与生命周期日志（本地发布步骤，不发布任何东西）；
  - 真实 Pi 下验证命令补全与 `last-guard=`（`test/pi-lifecycle.test.ts`）。

### 变更

- `npm test` 改用 `dist/test/*.test.js` glob，新增测试文件不再需要手动登记（此前漏登记会静默不运行）；
- 将产品需求与技术设计同步到三层 Project Intelligence、Project Profile、Knowledge Capsule 和 TypeScript/Vue Adapter 的现行架构；
- 将 Pi 当前开发基线从 `0.85.1` 升级到 `0.87.1`；按 Pi package 官方规范把 peer dependency 改为 `"*"`，同时仅声明已验证版本；
- 稳定指导改用 0.87.1 normalized `systemPromptOptions.sections`，避免替换完整 system prompt；
- 新增 Engineering Practice 设计提案，并明确先完成 Guard 生产准入收尾；
- `/convention-snapshot` 无可用 Snapshot 时改为语言无关提示；
- Analyzer 升级为 `multi-lexical-v6-semantic-peers`：Java service interface 按 declaration kind 隔离，TypeScript/Vue 候选加入文件语义后缀排序，并修复 `*RequestVO`/`*ResponseVO` 分类；
- 完成 Stage 2 Guard 生产准入：24 个 SnailJob/SnailAI 任务、pi-lens `4.2.1` 共存、真实 TUI bypass/Session/Branch/reset 和 HEAD 变化 Shell 审计全部通过，Guard 继续保持 experimental opt-in；
- 实现 Engineering Practice Advisory MVP：`practice-lexical-v1` 确定性 Signal、有界 `<engineering-practice>` Capsule、`off | suggest` 配置、Context 共享预算、隐私日志和 fail-open 边界；不增加 Guard 阻断或第二个 LLM；
- 完成整体架构必要性审查并删除无调用方的 Practice result/reason/details 字段；确认 P1 不需要独立 Resolver、缓存、parser 或 Profile schema；
- 实现 opt-in `auto-once`：task-local Review Runtime、mutation relevance、Pi `agent_before_settle` custom message、当前 Agent 至多 continuation 一次，以及 Session/Branch/reset 防循环边界；
- 完成 auto-once 后置整体架构复审：修正 Pi boundary `canContinue` 预判、简单修改误触发、auto/suggest 重复分析，并把 boundary planner 提取为独立纯函数；
- 完成 Practice P3 真实质量评估：SnailJob/SnailAI 6 个任务 × 3 种模式共 18 次 Pi run，18/18 正确、简单任务干扰 0/2；默认保持 `suggest`，`auto-once` 继续 opt-in，不扩 Profile schema 或 parser；
- 实现 `scope-unknown` 有界 Practice-only fallback：仅分析 successful-read ledger 中的 existing production target，不创建 Snapshot/peer evidence、不改变 Guard；真实 provider 恢复 `variation-axis` Signal，简单 API wrapper 仍为 0 Signal。
- **删除死代码**：`src/runtime/guard.ts`（Stage 0 Guard）、`src/observe/observe-decision.ts`、`examples/legacy/` 及 `GuardDecision` 类型；依赖它们的两个 `core.test.ts` 用例改为测试真实的 `evaluateConventionGuard` 与读取账本；持久化类型名 `pi-convention-sense-spike-state` 保持不变；
- **入口瘦身**：`extensions/index.ts` 中的决策逻辑抽到 `src/` 并有独立测试——活跃目标/已覆盖目标/Practice fallback 目标的选择（`src/observe/active-targets.ts`）、启用语言与 production 判定（`source-selection.ts`）、Snapshot 日志载荷（`snapshot-log.ts`）、工具调用摘要（`src/guard/tool-summary.ts`）、变更文件与证据缺口选择（`post-change-audit.ts`）、命令文本与补全（`src/runtime/command-text.ts`）；行为不变，由原有测试护航；
- 评估后决定**不做**按 `ctx.getContextUsage()` 动态降级注入：注入量本来就有上限，压缩由 Pi 负责，而跳过注入会让 Guard 的 `SNAPSHOT_NOT_INJECTED` 变成无法完成的缺口；理由写入 design §19。

### 文档

- **AGENTS.md**（应用户要求更新）：基线改为 306/306 并写明覆盖率门槛；架构清单补全共享基础设施模块；新增「稳健性与 fail-open」「路径」约束和扩充的状态/Context、隐私、测试要求（真实 Pi 测试、变异验证、对抗输入、fuzz 同步）；Profile 双校验器一致性、文档同步规则和提交卫生（`.claude/worktrees/`）补充；
- **README**：新增完整配置参考（字段、默认值、范围、glob 限制、诊断行为）；`/convention-status` 示例更新；日志隐私补充 `handler_error`；纠正「Session 状态在 `.pi/convention-sense/`」——checkpoint 实际是 Pi Session 文件里的 custom entry，Snapshot 不进入 checkpoint；修复重复的章节编号（两个 §17）；补充 TypeScript/Vue 无 Snapshot 排查、覆盖率与基准命令、限制说明；
- **设计文档**：运行时状态、Freshness（racy-clean、粘性 stale）、checkpoint 持久化、配置校验、异常降级表、可观测性、项目结构和测试组成与实现对齐；删除「V1 先用内存」「appendEntry 保存 Snapshot」等已过时描述；
- **需求/贡献/Profile 文档**：补充有界性与健壮性非功能需求、Adapter 稳健性契约与测试矩阵、Profile 校验规则（与运行时 loader、Skill helper 一致）；Skill 的兼容性声明从 Pi 0.85.x 更正为 0.87.1；Stage 0/1 文档标注为历史记录；
- **`test/docs.test.ts`**：文档与实现一致性的自动检查——相对链接、仓库路径引用、版本/Pi 基线/测试数量一致、README 配置表与 `createDefaultConfig` 一致、design 的配置样例、已注册命令与 README 命令表一致、示例配置无诊断；
- `.gitignore` 增加 `.claude/worktrees/` 与 `.claude/settings.local.json`。

### 验证

- Pi `0.87.1` 下 strict TypeScript、clean build 与 70 个自动测试全部通过；
- 独立无 Session Pi `0.87.1` 子进程验证 Extension 加载、named prompt section、custom Context、Profile 加载及 settle/shutdown 生命周期；SnailJob/SnailAI 真实项目主流程验收通过。
- SnailJob Job Tag Management CRUD v2 完成真实业务开发验收：后端 compile、Admin typecheck/build、六种数据库方言、namespace 隔离和前端 typed API 均通过；业务修改按要求保持未提交。
- SnailAI Admin 原生检查因缺少 `node_modules` 记录为 `ENVIRONMENT_BLOCKED`，未安装依赖或修改 lockfile；
- Guard 准入指标：Top-K 72/77（93.5%）、High Observation 17/17（100%）、潜在误拦截 1/24（4.2%），24/24 Discovery 后放行；
- Practice P1 SnailJob 只读 smoke：1,158 个 production Java 文件中 43 个触发 Signal（3.7%），真实 `RetryWebServiceImpl` Capsule 为 335 tokens 且不含源码正文；
- Practice P2 真实 Pi `0.87.1`：marker-free edit 为 1 次 Agent run、0 review；相关外部副作用 edit 为 2 次 Agent run、1 个 373-token review，第二次 boundary 以 `already-requested` 结束；
- Practice P3：suggest question 人工适用 5/7、auto-once 4/4；3 次 auto review 中 1 次补充有效兼容分支移除条件、2 次确认无需修改，未观察到行为修复；
- `scope-unknown` fallback 评估：SnailAI provider 从 0/1 提升到 1/1 Signal 覆盖，suggest Capsule 186 tokens、auto-once review 273 tokens；简单 API wrapper 0 Signal、0 continuation。

## [0.4.0-alpha.1] - 2026-09-23

> 状态：开发预发布版本，未发布到 npm，也未创建 Git tag。

### 新增

- Project Profile Runtime：信任门控、schema 校验、repository 隔离、fingerprint 和 effective role；
- 有 token 预算的 Knowledge Capsule；
- `java-spring@1.0.0` 与 `typescript-vue@1.0.0` 最小 advisory Packs；
- Project Profiler Skill：`init`、`adopt`、`refresh`、`diff`；
- TypeScript/Vue Adapter：page、component、hook、API service、request client、Pinia store、router、layout 和 workspace package；
- `/convention-reset confirm`：重置当前 Branch 的 read ledger、Snapshot、Guard/bypass 和 post-change 状态；
- `/convention-status` 的 config source、Profile、review、fingerprint 与 active Packs 输出；
- GitHub Actions Windows/Ubuntu × Node 22.19/22.x CI matrix；
- 中文 README、文件生命周期和兼容性矩阵文档；
- SnailJob 后端与 `snail-job-admin` 前端真实全栈验证。

### 变更

- 正式运行时目录从 `src/spike/` 重命名为 `src/runtime/`；checkpoint 持久化类型名保持兼容；
- 示例配置移动到 `examples/config/`，Stage 0 示例移动到 `examples/legacy/`；
- 临时评估目录从 `.evaluation/` 统一为 `.tmp/pi-convention-sense/`；
- `scripts/` 纳入 package 内容；
- Global Pack 只以 `advisory/global-pack` 参与项目知识；
- Profile、Pack id/version 参与 Snapshot freshness；
- 外部仓库 Profile 明确为 `ignored`，候选仍严格限制在目标 repository。

### 修复

- 修复外部仓库 Evidence 污染；
- 修复 MVC View Controller 与 REST Controller 候选混用；
- 修复 generated protobuf Java 源码进入 Snapshot；
- 修复 request/response DTO、Handler DTO 和 additive return wrapper 误判；
- 修复 TypeScript/Vue route-local component、layout module 和 workspace request-client 分类；
- 修复同 Scope 重复 Context 注入与 Snapshot token 裁剪问题。

### 验证

- 自动测试基线：56 个测试；
- TypeScript typecheck；
- `npm pack --dry-run`；
- SnailJob disposable worktree Observe/Guard 人工验证；
- Profile + Pack + Local Evidence 三层主流程；
- Guard `TARGET_NOT_READ` block 与 `SNAPSHOT_VALID` allow；
- 原真实项目 tracked 文件保持未修改。

## [0.3.0-guard.1]

Stage 2 Guard 开发基线：正式 Guard reason code、一次性 bypass、第三方工具映射、Git shell 后置审计和 v3 checkpoint。

## [0.2.0-observe]

Stage 1 Observe 开发基线：Java Scope、Candidate Ranking、Evidence、Snapshot、Context 与 Branch 重建。

## [0.1.0-spike]

Stage 0 Pi Extension 生命周期与安全日志 Spike。
