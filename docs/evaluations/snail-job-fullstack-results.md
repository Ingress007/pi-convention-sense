# SnailJob 全栈 Project Intelligence 验证结果

> 验证日期：2026-09-22
> 后端提交：`d837ef0bad8f3182ad1fd262249d198ce0df2f5e`
> 前端提交：`9797d1f53c41d56a03d8d1af30d37d5d6d480e72`
> Analyzer：`multi-lexical-v5-typescript-vue-profile`

## 1. 验证边界

验证全部在 detached disposable Git worktree 中完成。原 `snail-job` 与 `snail-job-admin` tracked 文件未修改。

三层输入：

1. Global Baseline Pack；
2. draft Project Profile / Knowledge；
3. 当前 Scope 的 Local Evidence。

使用的 Profile：

- 后端：`test/fixtures/profiles/snail-job/.convention-sense/profile.json`
- 前端：`test/fixtures/profiles/snail-job-admin/.convention-sense/profile.json`

## 2. Pack 与 Profile

| Repository | Profile fingerprint | Active Pack | Review |
|---|---|---|---|
| snail-job | `60e259b2419659a4` | `java-spring@1.0.0` | draft |
| snail-job-admin | `5276d8f8709b256e` | `typescript-vue@1.0.0` | draft |

Pack 结论始终是 advisory；draft Profile 中的 hard 结论运行时降级为 advisory。Guard 仍只阻断 Discovery 缺口。

## 3. 后端真实样本

### MVC View Controller

`server-ui/WebController`：

- base role：`controller`
- effective role：`mvc-view-controller`
- 候选：仅 `server-web/WebController`
- Snapshot：`weak`
- 结果：不再使用 REST Controller 作为主要 Evidence，Evidence 不足时 fail-open。

`server-web/WebController` 同样解析为 `mvc-view-controller`，只与 `server-ui/WebController` 互为 peer。

### REST Controller

`server-web/JobController`：

- effective role：`rest-controller`
- Snapshot：`valid`
- Top candidates：`WorkflowController`、`SceneConfigController`、`NotifyRecipientController`、`GroupConfigController`
- 所有候选均为同 REST subtype。

### Generated 与既有 Java 回归

- `SnailJobGrpcRequest.java`：`target-excluded`
- `RetryWebServiceImpl`：保持 `service-impl` / `valid`
- ServiceImpl 候选仍来自同 module/role，未因 Profile 退化。

## 4. 前端真实样本

真实 `snail-job-admin` 样本结果：

| Target | Effective role | Status |
|---|---|---|
| `src/views/job/batch/index.vue` | `vue-page` | valid |
| `src/views/job/batch/modules/job-batch-search.vue` | `view-local-component` | valid |
| `src/hooks/common/table.ts` | `application-hook` | valid |
| `src/service/api/job.ts` | `typed-api-service` | valid |
| `src/service/request/index.ts` | `application-request-client` | valid |
| `src/store/modules/app/index.ts` | `pinia-setup-store` | valid |
| `src/router/index.ts` | `application-router` | valid |
| `src/layouts/base-layout/index.vue` | `application-layout` | weak（仅一个 peer） |
| `packages/axios/src/index.ts` | `workspace-request-client` | valid |
| `packages/hooks/src/use-table.ts` | `workspace-hook` | valid |

边界结果：

- page 不与 route-local component 混为同 Scope；
- API service、request client、store、router、layout 和 hook 分开；
- `packages/axios` 的 4 个候选全部来自 `packages:axios`；
- `packages/hooks` 的 4 个候选全部来自 `packages:hooks`；
- 主应用不使用 workspace package 文件作为默认 peer。

真实项目检查还修复了两个 Adapter 边界：

- `src/views/**/modules/*.vue` 与 `src/layouts/modules/**/*.vue` 识别为 component；
- `packages/alova`、`packages/ofetch` 识别为 request-client package。

## 5. 独立 Pi 生命周期

### 后端 Observe

独立 `pi --print` 新进程日志确认：

- `projectProfileStatus=loaded`
- fingerprint=`60e259b2419659a4` 前一版生命周期验证为 `ef0ff898767b1a93`；Pack-aware 复验使用新 fingerprint
- scope=`java:...:mvc-view-controller`
- Snapshot `weak`
- 下一 turn `injectedSnapshotCount=1`
- 无写入、无循环。

### 前端 Observe + Knowledge Capsule

独立 Pi 新进程读取真实 Vue page 后明确返回：

> project-knowledge block is present; effective role: `vue-page`

日志确认：

- Profile loaded；
- scope=`vue:...:vue-page`；
- 4 个 page peer；
- `component-style: script-setup`、`source-language: vue-sfc`、`style-scope: scoped`；
- 下一 turn成功注入 Context。

### Guard

真实后端 worktree 中，仅启用 `edit` 且未 read：

- `TARGET_NOT_READ → block`
- edit 前后 Git blob hash 均为 `258b7d0a53beb8ee6a3663fcb09d0ac5195f830f`
- 目标文件未变化。

自动 Extension 测试另覆盖 TypeScript/Vue 的 read → valid Snapshot → Context → allow 主流程。

### 人工交互式后端验证

在重新创建的 disposable worktree 中，由用户通过真实交互式 Pi 完成完整流程：

- 启动日志确认 `mode=observe`、Profile loaded、fingerprint=`60e259b2419659a4`；
- `server-ui/WebController` 解析为 `mvc-view-controller`、`weak`，只有一个 MVC peer；
- `JobController` 解析为 `rest-controller`、`valid`，4 个候选全部为 REST Controller；
- generated protobuf read 成功，但记录 `snapshot_skipped / target-excluded`，Snapshot 总数保持 2；
- 重启到 Guard 后，未 read 的 `WorkflowController` edit 被 `TARGET_NOT_READ` 阻断，文件 hash 未变化；
- read → valid Snapshot → Context 后，同一 edit 以 `SNAPSHOT_VALID` allow；
- 测试注释随即恢复，最终 hash 回到 `e8cb64b702cf39d99ba43df10e958cb057ed2627`；
- Knowledge Capsule 显示 draft Profile、`server-web`、`rest-controller`、架构与技术栈；
- Pack 规则以 `[advisory/global-pack] controller-boundary` 注入；
- `/quit` 产生 `session_shutdown.reason=quit`；
- disposable worktree 已移除，原 SnailJob tracked working tree 保持干净（仅保留用户原有未跟踪 `.pi/`）。

人工验证期间的原始日志属于本地临时产物，路径约定为被 Git 忽略的 `.tmp/pi-convention-sense/evaluations/snail-job/`；永久结论仅保留在本文档中。

## 6. 隐私与安全

日志只记录路径、scope、候选分数、计数、fingerprint 和 reason code。未记录源码、edit 文本、write 内容、完整 prompt 或完整 Shell 命令。

Profile 无效、未信任或跨仓库时继续 fail-open；Pack/Profile 风格差异不成为 Guard 硬阻断。

## 7. 自动验证

- `npm run verify`：54/54
- 后端/前端 Profile schema：通过
- Pack-aware 真实样本断言：通过
- 独立 Pi Observe 生命周期：通过
- 真实 Guard 未读阻断：通过
