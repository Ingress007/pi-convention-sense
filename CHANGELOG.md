# 更新日志

本文件记录 `pi-convention-sense` 的重要变化。项目尚未发布稳定版本；版本号用于标记可复现的开发基线。

## [Unreleased]

### 变更

- 将产品需求与技术设计同步到三层 Project Intelligence、Project Profile、Knowledge Capsule 和 TypeScript/Vue Adapter 的现行架构；
- 将 Pi 当前开发基线从 `0.85.1` 升级到 `0.87.1`；按 Pi package 官方规范把 peer dependency 改为 `"*"`，同时仅声明已验证版本；
- 稳定指导改用 0.87.1 normalized `systemPromptOptions.sections`，避免替换完整 system prompt。

### 验证

- Pi `0.87.1` 下 strict TypeScript、clean build 与 56 个自动测试全部通过；
- 独立无 Session Pi `0.87.1` 子进程验证 Extension 加载、named prompt section、custom Context、Profile 加载及 settle/shutdown 生命周期。

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
