# AGENTS.md

本文件适用于整个 `pi-convention-sense` 仓库。它是人类维护的仓库级 Agent 工作规范；只有用户明确要求时才修改，不得由一次 Local Evidence 或自动观察静默改写。

## 1. 开始工作前

按任务需要阅读：

1. [README.md](README.md)：安装、配置、命令和用户流程；
2. [项目知识库](docs/knowledge-base.md)：架构、约束、变更路径和验证门槛；
3. [产品需求](docs/requirements.md) 与 [技术设计](docs/design.md)：产品边界和系统设计；
4. [Project Intelligence](docs/project-intelligence.md)：Pack、Profile、Local Evidence 和信任模型；
5. [兼容性与验证矩阵](docs/compatibility.md)：哪些环境真正验证过；
6. `.convention-sense/profile.json`：机器可解析的 draft 项目知识；
7. `CLAUDE.md`：命令、测试写法和跨文件结构的补充（Claude Code 自动读取；与本文件冲突时以本文件为准）。

当前基线：

- Node.js `>=22.19.0`；运行时唯一第三方依赖是 `minimatch`；
- Pi 当前开发与真实生命周期验证基线为 `0.87.1`；package peer dependency 按 Pi 规范使用 `*`，不得据此宣称其他版本已验证；
- TypeScript `5.9.3`，strict + NodeNext；
- 开发版本 `0.4.0-alpha.1`，尚未发布；
- 完整测试基线 `npm run verify`，306/306；`npm run coverage` 的门槛为行 88% / 分支 78% / 函数 88%（只统计 `src/` 与 `extensions/`）。

不要擅自扩大兼容范围或把未验证环境写成“已支持”。

## 2. 指令和证据优先级

发生冲突时按以下顺序处理：

1. 用户当前明确要求；
2. 安全边界、编译器、类型系统、lint 和测试等可执行检查；
3. 本文件中的仓库级约束；
4. reviewed Project Profile 中的 hard knowledge；
5. 当前 Scope 的多文件 Local Evidence；
6. reviewed advisory Profile；
7. draft Profile；
8. Global Pack；
9. 通用最佳实践。

Local Evidence 是局部事实，不是自动生成长期规则的依据。不要为了匹配观察结果而重构无关代码。

## 3. 项目架构

- `extensions/index.ts`：Pi Extension 入口和生命周期编排；
- `src/runtime/`：配置、状态、checkpoint、Context、日志、状态展示，以及共享的基础设施——路径身份（`path-key`）、日志安全（`log-safety`）、handler 异常（`handler-errors`）、glob 缓存与限制（`glob`）、racy-clean 判定、XML 转义、`/convention-*` 命令文本与补全（`command-text`）；
- `src/observe/`：repository、Scope、候选、Evidence 和 Snapshot；Java 与 TypeScript/Vue 各有 analyzer、scope detector 和 ranker；分析器上限在 `limits.ts`，仓库相对路径分类在 `repository-path.ts`；入口委托的纯决策在 `active-targets.ts`（活跃/已覆盖/Practice fallback 目标）、`source-selection.ts` 和 `snapshot-log.ts`；
- `src/guard/`：Discovery Guard（含按证据身份判断“已注入”）、工具映射、工具调用摘要和 Git 后置审计；
- `src/practice/`：Practice Signal、Capsule formatter 和 one-shot Review Runtime；
- `src/profile/`：Profile、Pack、selector、resolver 和 Knowledge Capsule；
- `skills/project-profiler/`：显式 Project Profile authoring 工作流；
- `scripts/`：可复用的真实仓库评估工具、合成仓库基准和发布包冒烟（本地使用，不进 CI，也不随 npm 包发布，因为它们导入未发布的 `dist/`）；
- `test/`：Node 测试与固定 fixtures；`test/support/` 放假 Pi API、真实 Pi 离线会话和 fuzz 辅助；
- `docs/`：需求、设计、规范、研究和永久评估结论。

保持 Extension 为核心、Skill 为辅助。`extensions/index.ts` 负责接线，确定性分析和决策逻辑放入 `src/` 并独立测试。

## 4. 不可破坏的产品约束

### Observe 与 Guard

- 默认 `observe` + fail-open；
- `guard` 必须显式启用，并继续标记为 experimental；
- Guard 只阻断可完成的 Discovery 缺口；
- Guard 不得因风格差异直接阻断修改；
- unsupported、excluded、low confidence、weak/mixed、analysis error 和 no-peer 必须 fail-open；
- bypass 必须精确路径、单次消费、不跨 Session/Branch。

### Engineering Practice

- 默认 `suggest`；`auto-once` 必须显式启用，并继续保持每 task generation 最多一次；
- `scope-unknown` fallback 仅面向 successful-read ledger 中的 existing production target；
- fallback 不得创建或伪造 Scope、Snapshot、candidate、peer evidence，也不得改变 Guard reason code、bypass、counter 或 checkpoint；
- 无 Signal、未读、prospective、non-production、excluded、超大文件和分析错误必须 fail-open；
- 不因 Practice 引入 Profile `practices` schema、完整 parser、method-level diff、测试映射器、平行 Git runtime 或第二个 LLM，除非新的真实证据和明确产品决策支持。

### Repository 与 Profile

- 目标文件决定 Candidate Finder 的 Git repository root；
- 候选、Snapshot 和缓存不得跨 repository 复用；
- Profile 只按 Pi 启动仓库加载；
- 从仓库 A 读取仓库 B 时，B 的 Profile 必须为 `ignored`；
- Global Pack 永远 advisory；
- draft Profile 中的 hard 项运行时降级为 advisory；
- 完整 Profile 不得每轮注入，只生成目标相关的有界 Knowledge Capsule。

### 状态与 Context

- 只有成功 `tool_result` 才能进入 read ledger；
- pending 或失败的 read 不满足 Guard；
- checkpoint 保持 branch-local，并兼容 v1/v2/v3；只在 `agent_settled` 与 `session_shutdown` 写入，最多保留最近 300 条读取，计数必须是非负整数，损坏的 checkpoint 回退到上一份有效 checkpoint；Snapshot 不进入 checkpoint，恢复后按需重建；
- 历史持久化类型名 `pi-convention-sense-spike-state` 为兼容契约，不因目录改名而删除；
- 标记为 stale 的 Snapshot 在目标被重新分析之前不得再作为 fresh 使用；“Snapshot 已注入模型”按证据身份判断（peer 路径与内容、Observation、Scope、配置），不得按 Snapshot 的创建时间判断；
- 稳定原则和动态 Snapshot/Capsule 分开注入；
- 注入模型的、来自仓库的文本（路径、名称、Profile 文本）必须经过 `escapeXml`；token 预算使用 `estimateTokens`，不得硬截断出未闭合的标签；
- Extension 源码变化需要重启 Pi 才会加载。

### 稳健性与 fail-open

- 所有 Pi 生命周期 handler 必须自己捕获异常并 fail-open：Pi 不捕获 `tool_call` handler 的异常，抛出会阻断用户的工具；被吞掉的错误只记录 `handler_error`（事件名、错误名、错误码、栈顶定位帧，不含错误消息）；
- 分析、命令分类和 Git 审计在 Pi 事件循环上同步运行：对任意不超过 1 MiB 的输入必须线性或有界。禁止对每个锚点都可能扫到文件末尾的无界模式（无界的 `[^x]*`、`[\s\S]*?`、`\w*关键字\w*`）；超过 1 MiB 的源码文件不分析；Git 审计共享 3 秒总时限；
- 损坏、超大或恶意的配置、checkpoint、Profile 不得影响 Pi 主流程：非法字段给诊断并回退默认值；
- glob 只通过 `src/runtime/glob.ts`（`isSupportedGlob`）使用，不支持的模式视为永不匹配；
- 项目配置的 `logPath` 只能位于 `<configDir>/convention-sense/` 内，日志文件及其上的目录不得是符号链接或 junction。

### 路径

- 路径身份、Set/Map key 和比较一律使用 `pathKey`/`PathSet`：Windows/macOS 折叠大小写与盘符，Linux 保持大小写敏感；显示、日志和 checkpoint 保留磁盘原样；
- generated/test/role/workspace 分类只使用仓库相对路径，仓库上层目录名不得影响分类；
- Windows 的 `\\?\` 扩展前缀在 `pathKey`/`normalizeToolPath` 中剥离；junction/符号链接不做 realpath 规范化，属于已知限制，不得据此声称已解决。

### 隐私

日志只能记录必要元数据、规范化路径、计数、reason code、fingerprint、耗时和状态。不得记录：

- 源码正文；
- edit/write 正文；
- 完整 prompt；
- 完整 Shell 命令；
- 工具输出和错误消息正文；
- 密钥、token 或凭据。

正常编码链路不得调用第二个 LLM。

## 5. 代码约定

- 使用 ESM 和 NodeNext；相对 TypeScript import 使用显式 `.js` 后缀；
- 保持 `strict`、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`；
- 对外结果优先使用明确类型和 reason code，不把可预期分析失败抛入 Pi 生命周期；
- 路径比较必须考虑 Windows 与 POSIX 分隔符及大小写边界；
- 注释/字符串屏蔽按 UTF-16 下标写入，缓冲区用 `text.split("")`，不用 `[...text]`；行结束符按 LF/CR/CRLF 处理；
- selector 只能使用 schema 声明的白名单字段，禁止脚本、命令和可执行规则；
- 不为一次性便利引入完整 parser、第二个模型或跨仓库索引；
- 优先复用邻近生产代码已经重复出现的模式；证据弱或混合时保留不确定性；
- 不做与当前请求无关的重构。

不要直接修改 `dist/`。它由 TypeScript 构建生成。

## 6. 测试要求

任何行为变化都必须有对应自动测试；修复缺陷先写出会失败的测试，再修复。至少覆盖：

- 正常路径；
- fail-open/排除路径；
- repository 和 module 隔离；
- generated/test/vendor/build output；
- Session/Branch checkpoint；
- Context freshness 和 token budget；
- Guard reason code 与 bypass；
- 日志不含敏感正文。

测试写法的硬性要求：

- 涉及 Pi runner 语义（fail-open、生命周期顺序、命令、compaction、reload）的行为用真实 Pi 离线测试（`test/pi-integration.test.ts`、`test/pi-lifecycle.test.ts`），不只靠手写假 API；
- 扩展会吞掉 handler 异常，所以 happy path 测试必须断言没有 `handler_error`（`afterEach`/`withHarness` 已内置；故障注入测试显式声明）；
- 新增或修改正则，要把它的最坏输入加进 `test/robustness.test.ts`；新增配置项，要同步 `test/fuzz-state.test.ts` 的生成器与不变量；
- 保护关键行为的测试要做变异验证：临时破坏 `dist/` 中的被测行为，确认测试失败，再 `npm run build` 恢复；
- 测试不得依赖用户机器上的外部仓库、运行日志或网络；真实模型 smoke 只在一次性克隆里手动做，不进自动测试。

完整验证：

```bash
npm run verify
npm run coverage
npm pack --dry-run
```

`npm run verify` 必须同时通过 typecheck、clean build 和全部 Node tests。不得以 LSP silent-on-clean 代替 TypeScript 和测试。

改变 package、README、examples、scripts 或发布文件时，还要检查 package tarball 内容。扩大 Node/Pi/OS 兼容范围前，更新 `.github/workflows/ci.yml` 和 `docs/compatibility.md`，并运行真实 Pi 生命周期。

## 7. Profile 更新规则

修改 `.convention-sense/profile.json` 时必须使用 Project Profiler 流程：

1. 生成 `.convention-sense/profile.candidate.json`；
2. validate；
3. fingerprint；
4. semantic diff；
5. 显式用户批准；
6. adopt；
7. 删除或忽略 candidate。

不得静默覆盖 active Profile，不得自动保留 reviewed 状态，不得把一次 Snapshot 提升为项目惯例。当前 Profile 是 `draft`，fingerprint 以实际工具输出为准。

Profile 校验规则在运行时 loader（`src/profile/profile-loader.ts`）和 Skill 的独立 helper（`skills/project-profiler/scripts/profile-tools.mjs`）里各有一份，必须保持一致；`test/profile-differential.test.ts` 会在两者对任何 Profile 判断不同时失败。

## 8. 文件生命周期和提交卫生

应提交：

- `extensions/`、`src/`、`test/`；
- `skills/`、`scripts/`、`examples/`；
- `docs/` 和 `docs/evaluations/` 中经审阅的永久结论；
- `.convention-sense/profile.json`；
- `.pi/settings.json`、CI、manifest、lockfile 和仓库文档（含 `AGENTS.md`、`CLAUDE.md`）。

不得提交：

- `node_modules/`、`dist/`、coverage；
- `.pi/convention-sense/`、`.tmp/`、日志；
- `.convention-sense/profile.candidate.json`；
- `.env*`、密钥、证书、编辑器状态、`.claude/worktrees/` 与 `.claude/settings.local.json`；
- `npm pack` 生成的 `.tgz`。

注意：`test/fixtures/java-maven/order/target/generated-sources/` 是刻意提交的 generated-source 测试 fixture，不要用全局 `target/` ignore 误删。

提交前执行：

```bash
git diff --check
git status --short
npm run verify
npm pack --dry-run
```

确认 staged diff 不包含运行日志、临时产物、源码正文日志或外部仓库文件。

## 9. 文档维护

以下变化必须同步文档：

- 产品行为或命令变化 → README、requirements/design；
- 配置项、默认值或校验规则变化 → README 配置参考、design 的配置章节、`examples/config/`；
- Profile/Pack/trust/precedence 变化 → project-intelligence，Profile 校验变化还要同步 `skills/project-profiler/references/PROFILE-SCHEMA.md`；
- 文件路径或临时目录变化 → file-lifecycle；
- 兼容范围或测试矩阵变化 → compatibility；
- 新增、移动或删除源码模块 → 本文件 §3、knowledge-base 架构地图、design 项目结构、`CLAUDE.md`；
- 发布版本变化 → CHANGELOG；
- 架构或不可破坏约束变化 → knowledge-base 与本文件；
- 测试数量或覆盖率基线变化 → 本文件 §1、README、knowledge-base、compatibility（`test/docs.test.ts` 会检查这些文档里的数字彼此一致，以及文档内的相对链接和仓库路径引用有效）。

历史评估报告记录当时版本和结果。除非修正事实错误，不要把历史报告中的版本号批量替换为当前版本。
