# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

`pi-convention-sense` 是 **Pi Coding Agent 的 Extension**（不是独立应用）：Agent 成功 `read` 源码后，它在目标 Git 仓库内找同模块、同角色的 peer 实现，提取重复模式生成 Snapshot，并在下一轮 Context 注入；可选 Guard 只检查 Discovery 是否完成。支持 Java、TypeScript、Vue。正常链路是确定性本地代码，**不调用第二个 LLM**。

`AGENTS.md` 是人类维护的仓库级规范（指令/证据优先级、不可破坏的产品约束、隐私、提交卫生），**开始工作前先读，且只有用户明确要求才能修改它**。`docs/knowledge-base.md` 是架构、变更路径和验证门槛的入口。本文件不重复它们，只补充命令和需要跨文件才能看清的结构。

## 常用命令

Node `>=22.19.0`。测试跑的是编译后的 `dist/`，所以**测试前必须 build**。

```bash
npm ci                # 首次安装
npm run verify        # check（tsc --noEmit）+ clean build + 全部测试；提交前必跑
npm run check         # 仅类型检查
npm test              # build 后运行 dist/test/*.test.js（glob，新增测试文件无需登记）
npm run coverage      # 同上并强制覆盖率门槛（行 88 / 分支 78 / 函数 88，只统计 src/ 与 extensions/）
npm pack --dry-run    # 检查发布 tarball 内容（改 package/README/examples/scripts 后必跑）
```

运行单个测试文件或按名称过滤（必须从仓库根目录运行，fixtures 通过 cwd 解析 `test/fixtures`）：

```bash
npm run build && node --test dist/test/guard.test.js
npm run build && node --test --test-name-pattern="bypass" dist/test/guard.test.js
```

测试文件：`core`（配置/状态/checkpoint）、`observe`、`guard`、`profile`、`practice`、`extension`（用**手写的假 Pi API** 驱动 `extensions/index.ts`，快但不等于真实 Pi 语义；假 API 在 `test/support/fake-pi.ts`）、`pi-integration` 与 `pi-lifecycle`（用 Pi 的**真实**加载器、agent loop、工具 runner 和 Extension runner，由 `pi-ai` 自带的 faux 脚本化模型驱动，离线运行；辅助代码在 `test/support/pi-session.ts`，`captureUi: true` 让扩展拿到会记录 `notify`/`setStatus` 的 UI，用来测 `/convention-*` 命令；`compaction: { keepRecentTokens: 1 }` 才能让短会话 compact）。

稳健性测试：`robustness`（对抗输入线性性能，每个分析器 1 s 预算）、`fuzz-state`（配置与 checkpoint 种子化 fuzz）、`lifecycle-fuzz`（随机/乱序/残缺事件序列 + 随机文件系统变化）、`convention-guard`（判定表穷举）、`line-endings`、`path-key`（含 Windows 专属用例，非 win32 自动跳过）、`docs`（文档与实现一致性：相对链接、仓库路径引用、测试数量/版本基线一致、README 配置参考与 `createDefaultConfig` 一致、design 的配置样例、已注册命令与 README 命令表一致、示例配置无诊断）。fuzz 失败信息带 seed，可原样复现；`FUZZ_SCALE=20 npm test` 放大循环做一次性深度运行。新写 fuzz/属性测试后，临时破坏 `dist/` 里被保护的行为确认测试会失败（变异验证），并检查测试里的活动计数器（如 `lifecycle-fuzz` 的 blocks/checkpoints）不为零，避免空转。

写真实 Pi 测试的注意点：SDK 会话必须调用 `session.bindExtensions({ mode: "print" })` 才会触发 `session_start`；每次模型请求末尾都会被追加我们动态注入的 `<local-convention>` 消息，所以“最后一条 user 消息”不是续跑复盘消息，应按内容匹配；对话记录里本来就含 `read` 返回的源码，隐私断言只能针对我们注入的那条消息。扩展会吞掉 handler 异常（fail-open）并只记录 `handler_error`，所以测试默认会在 `afterEach`/`withHarness` 里断言没有被吞掉的错误；故障注入测试要显式设置 `allowHandlerErrors`。涉及 Pi runner 语义的修复（如 fail-open）要用真实 Pi 测试，并对被测行为做变异检查（临时改 `dist/` 破坏它，确认测试会失败，再 `npm run build` 恢复）。

`scripts/evaluate-*.mjs` 与 `scripts/benchmark-analysis.mjs` 直接 import `dist/`，运行前需先 `npm run build`。评估输出写入 `.tmp/pi-convention-sense/`；基准用合成仓库，只在本地跑，不进 CI。

用本机 `pi` CLI 做真实模型 smoke 时：在**一次性克隆**里跑（`git clone --depth 1 file:///<原仓库>` 到系统临时目录，原仓库只读），加 `-p --offline --no-extensions -e <本仓库>/extensions/index.ts --no-skills --no-context-files --no-session --tools read,edit,write --approve`，**必须 `< /dev/null`**（否则非 TTY 的 stdin 会让 Pi 启动后无输出地挂住），配置写到克隆里的 `.pi/convention-sense.json`，结果看克隆里的 `.pi/convention-sense/observe.ndjson`。

没有 lint/format 工具；约束靠 `tsconfig.json`：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、NodeNext（相对 import 必须带 `.js` 后缀）。可选属性不能显式赋 `undefined`，要用 `...(x ? { x } : {})` 的条件展开（代码里到处是这种写法）。

不要直接编辑 `dist/`。Extension 源码改动后需要**重启 Pi** 才生效；`.pi/convention-sense.json` 也只在启动时加载。

## 架构大图

### 入口与编排

`extensions/index.ts`（约 1000 行）是唯一入口，只做 Pi 生命周期接线；所有闭包状态（`config`、`state`、`snapshotCache`、`guardRuntime`、`practiceReviewRuntime` 等）都在 `registerConventionSenseSpike` 内。确定性逻辑应放进 `src/` 并独立测试，不要堆回入口。函数名中的 `Spike` 是历史遗留，持久化类型名 `pi-convention-sense-spike-state` 是兼容契约，不能改。

核心数据流（跨 `extensions/index.ts` 的多个 hook）：

1. `tool_call`：登记 pending read / mutation 意图；对 edit/write 先做 preflight 分析再跑 `evaluateConventionGuard`，`guard` 模式下可 `block`，`observe` 模式只记 `wouldBlock`。
2. `tool_result`：**只有成功结果**才进入 read ledger，并触发 `analyzePath` 生成 Snapshot；mutation 使相关 Snapshot 失效。Shell 工具走 Git baseline → 执行后 diff 的后置审计。
3. `context`：`ensureActiveSnapshots` 保证 freshness，`createDynamicContextMessage` 在统一 token 预算内拼装 `<local-convention>`、`<project-knowledge>`、`<engineering-practice>`，作为 custom message 追加。
4. `before_agent_start`：稳定原则写入 `systemPromptOptions.sections["pi-convention-sense"]`（动态内容绝不放这里，避免破坏 prompt cache）。
5. `agent_before_settle`：仅 `practiceReview.mode="auto-once"` 时，对本任务相关 mutation 追加一次自审并 `continue: true`；靠 task generation 保证每任务最多一次。

### `src/` 子系统与依赖方向

- `runtime/`：配置加载（仅受信项目）、`SpikeRuntimeState` 与 checkpoint（v1/v2 迁移到 v3，branch-local）、Context 拼装、NDJSON 日志、路径规范化（Windows/POSIX）。
- `observe/`：`ObserveAnalyzer` 串起 repository root → 语言分析（`java-analyzer` / `typescript-analyzer`）→ Scope detector → Profile 应用（`applyProjectProfileToScope`）→ Candidate ranker → Evidence builder → Snapshot。`SnapshotCache.getFresh` 用配置 fingerprint + 目标/peer 的 mtime/size/hash 判定 freshness。Java 与 TS/Vue 各有一套 scope-detector 和 ranker，改一边要想想另一边。
- `profile/`：Profile 加载校验（selector 只允许白名单字段）、内置 Pack、resolver（base role → effective role）、Knowledge Capsule。`LoadedProjectProfile.status` 为 `missing | ignored | invalid | loaded`；跨仓库一律 `ignored`。
- `guard/`：`evaluateConventionGuard` 是纯函数，输出 reason code；`GuardRuntime` 管 bypass（精确路径、单次消费）和 Context 注入记录；`git-auditor` 做 Shell 前后 Git 状态比对。
- `practice/`：`signal-analyzer` 从源码文本提取结构 Signal，`capsule-formatter` 生成审查问题，`review-runtime` 管 task generation 与 mutation relevance。`scope-unknown` fallback 走 `analyzePracticeTarget`（`basis: "successful-read"`），不产生 Snapshot。

依赖大致是 `extensions → {runtime, observe, guard, profile, practice}`，`guard` 和 `profile` 只依赖 `observe`/`runtime` 的类型；`observe` 反向可选依赖 Profile 解析。

### 容易踩的跨文件约束

- **repository 边界有两个不同的 root**：Pi 启动仓库（`ctx.cwd`，决定 Profile 与 trust）和目标文件所在的 Git root（`resolveAnalysisRepositoryRoot`，决定候选/Snapshot）。`profileForRepository` 用 `resolve(repositoryRoot) === resolve(ctx.cwd)` 做门禁——任何新增的分析路径都必须经过它，否则会泄漏外部仓库的 Profile。
- **配置 fingerprint 贯穿 freshness**：Profile、Pack、config 变化都要反映到 `createConfigFingerprint`，否则旧 Snapshot 不会失效。
- **Guard 与 Practice 相互隔离**：Practice（含 fallback）不得改变 Guard reason code、bypass、counter 或 checkpoint；Guard 只阻断 `TARGET_NOT_READ / SNAPSHOT_MISSING / SNAPSHOT_STALE / SNAPSHOT_NOT_INJECTED` 这类可完成的 Discovery 缺口，其余一律 fail-open。
- **日志不能含源码正文**、edit/write 内容、完整 prompt 或完整 Shell 命令（Shell 只记长度和风险标签）。
- **分析和命令分类在 Pi 事件循环上同步运行**：正则必须在 1 MiB 内任意输入上线性或有界（不要写对每个锚点都可能扫到文件末尾的 `[^x]*`、`[\s\S]*?`、`\w*关键字\w*`；用 `{0,N}` 或手写扫描），新增正则要把最坏输入加进 `test/robustness.test.ts`。屏蔽/剥离缓冲区用 `text.split("")`（UTF-16），不是 `[...text]`。glob 只用 `src/runtime/glob.ts`（`isSupportedGlob` 拒绝会让 minimatch 指数爆炸或抛错的模式）。

## 测试夹具与特殊文件

- `test/fixtures/` 被 `tsconfig` 排除，不会编译。其中 `java-maven/order/target/generated-sources/` 是**刻意提交**的 generated-source 夹具，不要因 `target/` 看起来像构建产物而删除。
- `.convention-sense/profile.json` 是本仓库自己的 draft Project Profile。修改它必须走 `skills/project-profiler/` 流程（candidate → validate → fingerprint → diff → 用户批准 → adopt），其校验/diff 工具是 `node skills/project-profiler/scripts/profile-tools.mjs <validate|fingerprint|diff> ...`。不得静默覆盖，也不要自行把状态标为 reviewed。
- `.pi/settings.json` 只是让 Pi 在本仓库开发时加载当前 package，不是目标项目配置模板；用户配置示例在 `examples/config/`。

## 文档同步

行为/命令变化同步 README 与 `docs/requirements.md`、`docs/design.md`；Profile/Pack/信任变化同步 `docs/project-intelligence.md`；路径/临时目录变化同步 `docs/file-lifecycle.md`；兼容范围变化同步 `docs/compatibility.md` 与 `.github/workflows/ci.yml`；发布变化更新 `CHANGELOG.md`。上述基线和默认值若与文档不一致，`test/docs.test.ts` 会失败，按失败信息改文档（或同步改代码）。`docs/evaluations/` 里的历史报告记录当时版本，不要批量替换版本号。当前基线（Pi `0.87.1`、测试数量与覆盖率等）出现在 README、`docs/knowledge-base.md`、`docs/compatibility.md` 等多处文档里，变化时需一并更新。
