# 更新日志

本文件记录 `pi-convention-sense` 的重要变化。项目尚未发布稳定版本；版本号用于标记可复现的开发基线。

## [Unreleased]

### 变更

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
