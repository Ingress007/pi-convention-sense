# 兼容性与验证矩阵

本文区分“声明支持”“CI 自动验证”“真实项目验证”和“尚未验证”，避免把单一环境测试误写成普遍兼容。

## 1. 运行时基线

| 组件 | 当前范围 | 状态 |
|---|---|---|
| Node.js | `>=22.19.0` | 支持 |
| Pi | peer `*`；当前开发基线 `0.87.1` | `0.87.1` 已验证 |
| TypeScript | `5.9.x` | 开发与 CI |
| Git | 可选 | Shell 后置审计需要 |

Pi package 官方规范要求把 `@earendil-works/pi-coding-agent` peer dependency 设为 `"*"`，由宿主 Pi 提供运行时依赖。该范围只是安装契约，不是兼容承诺；当前现行兼容声明仅覆盖 `0.87.1`。`0.85.1` 保留为 Stage 0 和早期真实 Guard 流程的历史基线。

## 2. CI 矩阵

GitHub Actions：`.github/workflows/ci.yml`

| 操作系统 | Node 22.19.0 | Node 22.x | 验证内容 |
|---|---:|---:|---|
| Ubuntu latest | CI | CI | TypeScript、306 个自动测试 |
| Windows latest | CI | CI | TypeScript、306 个自动测试 |

独立 package job 运行：

```text
npm pack --dry-run
npm audit --omit=dev --audit-level=high
```

Ubuntu + Node 22.x 单元格额外运行 `npm run coverage`（行 ≥ 88%、分支 ≥ 78%、函数 ≥ 88%，只统计 `src/` 与 `extensions/`）。audit 只针对会发布的生产依赖；开发依赖里属于 Pi 自身锁定依赖树（`npm-shrinkwrap.json`）的发现无法在此处修复。

CI 使用 `npm ci`，不修改 lockfile。lockfile 与 `devDependencies` 将 Pi 固定为 `0.87.1`，并有独立 step 断言实际安装版本，因此 TypeScript 编译和 306 个测试均针对该 API 运行。

## 3. Pi 行为验证

### 3.1 离线真实 Pi 生命周期测试（自动，CI）

`test/pi-integration.test.ts` 使用 Pi `0.87.1` 的**真实**资源加载器（jiti 加载 TypeScript 源码）、agent loop、工具 runner 和 Extension runner，由 `@earendil-works/pi-ai` 自带的脚本化 faux 模型驱动，无需网络、凭据或模型费用。它覆盖：package manifest 的 Extension/Skill 加载、Guard 阻断→补读→放行、同批并行工具中 pending read 不满足 Guard（`tool_call` hook 先于任何执行）、observe/guard 下分析异常不会被 Pi 的 `tool_call` fail-safe 阻断、checkpoint 随 run 落盘并随真实 `navigateTree` 重建、auto-once 在真实 `agent_before_settle` 下只续跑一次且简单修改静默。`test/pi-lifecycle.test.ts` 在同一套离线真实 Pi 上继续覆盖：五个 `/convention-*` 命令经 Pi 的命令分发执行（不触发模型调用，通过会记录 `notify`/`setStatus` 的 UI 上报）、bypass 单次且精确路径、**compaction**（读台账与 Snapshot 注入在上下文被压缩后仍然有效）、**reload**（扩展工厂重新运行，台账由 checkpoint 恢复，`session_shutdown:reload → session_start:reload` 顺序）。辅助代码集中在 `test/support/pi-session.ts`；SDK 会话必须调用 `session.bindExtensions()` 才会触发 `session_start`（CLI 各模式会自动调用）。

这些测试不能替代真实模型与真实交互式 TUI 的人工评估，也不扩大 Pi 版本、Node 或操作系统的兼容声明。

2026-10-01 另用本机 Pi `0.87.1` 与真实模型（`deepseek/deepseek-flash`，print 模式，`read,edit,write`）在 SnailJob 后端与 Admin 的**一次性浅克隆**上做了 4 次 smoke（原仓库只读）：Java observe 编辑（读后生成 `valid` Snapshot、下一轮注入、edit 以 `SNAPSHOT_VALID` 放行）、Java guard 新建文件（`write` 先被 `SNAPSHOT_NOT_INJECTED` 阻断，下一轮注入 Snapshot 后模型重试并放行）、Vue observe 编辑、Java guard + draft Profile + `auto-once`（Profile `loaded`，无 Signal 时 `no-review-capsule` 静默）。4 次 run 均无 `handler_error`。这是单模型、单次的行为证据，不构成模型兼容声明。

### 3.2 真实 Pi 与历史记录

自动测试均使用 Pi `0.87.1` 类型和运行时依赖。真实 Pi 证据按当前与历史基线分开记录：

| 行为 | 自动测试 0.87.1 | 真实 Pi 0.87.1 | 历史 Pi 0.85.1 |
|---|---:|---:|---:|
| Extension 加载与 lifecycle hooks | 是 | 是 | 是 |
| named system prompt section 与 custom Context | 是 | 是 | 不适用/旧实现 |
| read ledger 只接受成功 tool result | 是 | 真实 Pi 主流程已验证 | 是 |
| Snapshot 创建与 Context 注入 | 是 | 真实 Pi 主流程已验证 | 是 |
| Branch checkpoint 恢复 | 是 | 真实 TUI Session/Branch 隔离已验证 | 是 |
| Guard block → read → Context → allow | 是 | 真实 Pi 主路径已验证 | 是 |
| 一次性 bypass | 是 | 真实 TUI 精确路径、一次消费、Session/Branch 隔离已验证 | 部分人工验证 |
| Shell Git 后置审计 | 是 | 真实 Pi dirty 与 HEAD 变化场景均已验证 | 是 |
| Project Profile / Knowledge Capsule | 是 | Profile 启动加载与 Capsule 已验证 | 是 |
| Practice `suggest` / Capsule | 是 | SnailJob disposable smoke 已通过 | 不适用 |
| Practice `auto-once` | 是 | Pi `0.87.1` negative/positive 当前 Agent continuation 已验证 | 不适用 |
| Practice P3 质量 | 是 | SnailJob/SnailAI 6 task × 3 mode，18/18 正确；简单任务干扰 0/2 | 不适用 |
| `/convention-reset confirm` | 是 | 真实 TUI 已验证清除未消费 bypass | 未人工复验 |

当前真实评估同时覆盖了 `--print` 生命周期和带工具的 Observe/Guard 主路径，验证 `session_start → before_agent_start → context → agent_settled → session_shutdown`、read ledger、Snapshot/Context、未读目标阻断、补读后放行、真实 TUI bypass/reset/Session/Branch、dirty/HEAD 变化 Shell 审计、pi-lens `4.2.1` 共存和 Profile 加载。Practice P1 复用既有 Context hook，已通过 Extension harness 和 SnailJob disposable worktree 只读 smoke。P2 `auto-once` 已在独立 Pi `0.87.1` 进程验证 marker-free 修改不增加调用、相关修改只 continuation 一次，以及第二次 boundary `already-requested`。P3 进一步完成 18 个真实 mode run，结论为默认保持 `suggest`、`auto-once` opt-in；这不扩大语言或 Pi 版本兼容范围。

## 4. 真实项目证据

SnailJob 后端与 Admin 的完整结果见 [SnailJob Pi 0.87.1 验收](evaluations/snail-job-pi-0.87.1-results.md)；SnailAI 结果见 [SnailAI Pi 0.87.1 验收](evaluations/snail-ai-pi-0.87.1-results.md)；Stage 2 指标、TUI、pi-lens 和 HEAD 审计见 [Guard 生产准入结果](evaluations/guard-production-readiness-results.md)；Practice P1 结果见 [Advisory MVP 验证](evaluations/practice-advisory-mvp-results.md)，P2 结果见 [auto-once 验证](evaluations/practice-auto-once-results.md)，P3 结果见 [真实质量评估](evaluations/practice-quality-p3-results.md)。SnailAI Admin 原生检查因缺少 `node_modules` 标记为 `ENVIRONMENT_BLOCKED`，不扩展为已验证的前端兼容声明。

## 5. 语言与项目结构

| 能力 | Fixture | 真实项目 | 状态 |
|---|---:|---:|---|
| Java + Maven multi-module | 是 | SnailJob 后端 | 已验证 |
| Java + Gradle multi-module | 是 | 否 | Fixture 验证 |
| Java 单体项目 | 是 | 否 | Fixture 验证 |
| TypeScript + Vue SFC | 是 | snail-job-admin | 已验证 |
| pnpm workspace | 是 | snail-job-admin | 已验证 |
| package workspace 隔离 | 是 | snail-job-admin | 已验证 |

## 6. 操作系统

| 系统 | 自动测试 | 真实交互式 Pi | 状态 |
|---|---:|---:|---|
| Windows | CI | 是 | 主要开发环境；`path-key.test.ts` 的 Windows 专属用例（盘符/大小写/`\\?\` 扩展前缀/UNC/超过 MAX_PATH 的路径）只在 win32 运行；junction/符号链接不做 realpath 规范化，同一文件的不同拼写会被视为不同文件 |
| Linux | CI | 否 | 自动测试覆盖 |
| macOS | 否 | 否 | 尚未验证 |

没有真实验证的环境不得仅根据相似性声明为已支持。

## 7. Project Profile 与仓库边界

| 场景 | Profile 行为 | Candidate 行为 |
|---|---|---|
| 从目标仓库根目录启动且受信 | loaded | 仅当前 repository |
| Profile missing | missing，fail-open | Local Evidence |
| Profile invalid | invalid，fail-open | Local Evidence |
| Profile 存在但项目未信任 | ignored | Local Evidence |
| 从仓库 A 读取仓库 B | B 的 Profile ignored | 仅 B repository，不回退到 A |

外部仓库策略有 Extension 集成测试覆盖。若要加载 B 的 Profile，必须从 B 根目录显式批准并启动新的 Pi。

## 8. Pack 与 Adapter

| 项目 | 当前状态 |
|---|---|
| `java-spring@1.0.0` | 最小 advisory baseline |
| `typescript-vue@1.0.0` | 最小 advisory baseline |
| Java lexical adapter | SnailJob 与 fixtures 已验证 |
| TypeScript/Vue lexical adapter | snail-job-admin 与 fixtures 已验证 |

Global Pack 只能是 advisory。未审核 draft Profile 的 hard 规则同样降级为 advisory。

## 9. 发布前兼容门槛

扩大兼容声明前必须：

1. 将目标版本加入 CI matrix；
2. 全量 `npm run verify` 通过；
3. `npm pack --dry-run` 通过；
4. 至少运行一个独立真实 Pi 生命周期；
5. 对 Extension API 或 Pi 版本变化记录真实日志；
6. 更新本文档和 Changelog；
7. 不得以 silent-on-clean 的 LSP 结果替代 TypeScript 编译和自动测试。

### 9.1 发布流程（发布由维护者手动执行，工具和 CI 都不会自动发布）

包已具备发布元数据（`license: MIT`、`author`、`repository`、`bugs`、`homepage`，没有 `private` 标志），`prepublishOnly` 会先跑 `npm run verify`。发布前按顺序：

1. 确定版本号，更新 `package.json`、README/知识库里的开发版本和 `CHANGELOG.md`（把 `[Unreleased]` 改成带日期的版本节）；
2. `npm run verify`、`npm run coverage`、`npm pack --dry-run`、`git diff --check`；
3. `node scripts/smoke-package-install.mjs --provider <provider> --model <model>`：把 `npm pack` 的 tarball 解开、只装生产依赖、用真实 `pi` 安装进一个干净的临时项目并跑一个最短 prompt，检查扩展加载、生命周期日志齐全且没有 `handler_error`（需要本机 `pi`、一个已配置的模型和 npm 网络；不会发布任何东西）；
4. 确认 CI 的 Windows/Ubuntu × Node 22.19/22.x 全部通过；
5. 维护者手动 `npm publish`，之后验证 `pi install npm:pi-convention-sense -l` 在一个干净项目里可用。

发布包只含 `extensions/`、`src/`、`docs/`、`examples/`、`skills/`、`README.md`、`CHANGELOG.md` 和 `LICENSE`；`scripts/` 不随包发布（它们导入未发布的 `dist/` 构建产物，只在本仓库内使用）。Pi 不支持把 `.tgz` 作为本地安装源，`pi install` 只接受 `npm:`、`git:` 和目录。

## 10. 当前不在范围内

- 除 `0.87.1` 外的 Pi 版本（`0.85.1` 仅保留历史验证记录）；
- Node.js 20 及更低版本；
- 小程序、移动端、React Native、UniApp、桌面端；
- 非 Java/TypeScript/Vue 语言；
- macOS 真实运行验证；
- 跨仓库自动信任或动态加载外部 Profile。
