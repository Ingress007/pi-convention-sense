# Stage 2 Guard 生产准入结果

> 执行日期：2026-09-25
> 运行编号：`20260925T040734Z-guard-closeout`
> 产品版本：`0.4.0-alpha.1`（未发布）
> Pi：`0.87.1`
> pi-lens：`4.2.1`
> Node.js：`22.22.2`
> Analyzer：`multi-lexical-v6-semantic-peers`

## 1. 结论

Stage 2 Guard 的既定生产准入门槛通过：24 个 SnailJob/SnailAI Observe/Shadow Guard 真实任务全部完成 Discovery 恢复，Top-K、High Observation 和潜在误拦截指标均达标；真实 Pi TUI bypass、Session/Branch/reset、pi-lens 共存和 HEAD 变化 Shell 审计也已完成。

该结论允许 Guard 进入**受控项目的 experimental opt-in 使用**，不改变以下产品策略：

- 默认仍为 `observe` + fail-open；
- `guard` 必须显式启用；
- Guard 只阻断可补救的 Discovery 缺口，不执行风格或 Engineering Practice 审查；
- unsupported、excluded、low confidence、weak/mixed、analysis error、no-peer 和 insufficient-peer 继续 fail-open；
- 本结论不扩大 Pi、Node、操作系统或技术栈兼容范围。

## 2. 固定评估样本

评估在 detached disposable worktree 上进行，每个仓库固定 6 个目标，共 24 个任务：

| 仓库 | HEAD | 任务数 | 覆盖 |
| --- | --- | ---: | --- |
| SnailJob backend | `d837ef0bad8f3182ad1fd262249d198ce0df2f5e` | 6 | controller、service impl、mapper、request/response DTO |
| snail-job-admin | `9797d1f53c41d56a03d8d1af30d37d5d6d480e72` | 6 | page、component、hook、API service、layout |
| SnailAI backend | `10c1d3e50b701be62da23a3403d79a41187ab8cd` | 6 | controller、mapper、request/response DTO、service interface |
| SnailAI Admin | `3b2db48d7849554631f7b6f726c41b99af7c3462` | 6 | page、component、API service、request client、layout |

原始任务清单和逐任务结果保存在：

```text
.tmp/pi-convention-sense/guard-closeout/20260925T040734Z-guard-closeout/
```

该目录是本地评估证据，不进入 package；永久结论以本文为准。

## 3. Observe / Shadow Guard 指标

人工认可规则：候选必须是同用途或同层次的有效比较；High Observation 必须能在其 Evidence 文件中逐项确认；若 valid Snapshot 仍不足以证明额外 Guard round 有价值，则按任务计为潜在误拦截风险。

| 指标 | 结果 | 门槛 | 结论 |
| --- | ---: | ---: | --- |
| 真实任务数 | 24 | 20～30 | 通过 |
| valid / weak Snapshot | 17 / 7 | 信息项 | 通过 |
| 初始 `wouldBlock/TARGET_NOT_READ` | 24/24 | 应识别 Discovery 缺口 | 通过 |
| 完成 Discovery 后放行 | 24/24 | 100% | 通过 |
| weak/no-peer/insufficient-peer fail-open | 7/7 | 100% | 通过 |
| Top-K 人工认可 | 72/77（93.5%） | ≥ 80% | 通过 |
| 同 leaf module/workspace | 70/77（90.9%） | ≥ 90% | 通过 |
| High Observation 准确 | 17/17（100%） | ≥ 90% | 通过 |
| 潜在误拦截风险 | 1/24（4.2%） | ≤ 10% | 通过 |
| 最大 Snapshot | 347 tokens | ≤ 1200 | 通过 |
| cold P95 | 701 ms | ≤ 5 s | 通过 |
| warm P95 | 约 130 ms | ≤ 1 s | 通过 |
| analysis error | 0 | 0 | 通过 |
| permanent block | 0 | 0 | 通过 |

唯一保留的候选风险是 SnailJob `server-ui/WebController`：精确的 `server-web/WebController` peer 有效，另外三个 REST Controller 只提供较宽泛的结构 Evidence。该任务被保守计为一次潜在误拦截风险，没有用同 Role 分数代替业务语义判断。

## 4. 评估中发现并修复的问题

首次 24 任务运行暴露三项确定性候选相关性问题：

1. Vue `*-search.vue` 将通用 workflow drawer 排在同类 search form 前；
2. Java service interface 混入名称以 `Service` 结尾的实现类，并产生 implementation-only High Observation；
3. 不位于 `request/` 目录的 `*RequestVO.java` 被识别成 response DTO。

修复措施：

- TypeScript/Vue 候选加入文件语义后缀初筛和评分；
- Java `service-interface` 候选按 declaration kind 隔离；
- 增加 `RequestVO` / `ResponseVO` 后缀识别；
- Analyzer 版本升级为 `multi-lexical-v6-semantic-peers`；
- 增加回归测试，并用同一固定任务集完整重跑。

本报告全部指标来自修复后的重跑，不混用首次结果。

## 5. pi-lens 共存

真实 Pi `0.87.1` 同时加载 pi-convention-sense 与 pi-lens `4.2.1`：

- `lens_diagnostics` 成功，但 Convention Sense 日志保持 `successfulReadCount: 0`、`invalidatedSnapshots: 0`；
- `lens_diagnostics → read target → edit` 正向流程得到 `allow / SNAPSHOT_VALID`；
- settle 时 `successfulReadCount: 1`、`mutationCount: 1`；
- 未出现重复阻断、死循环或未捕获异常；
- 日志不含 prompt body、edit body 或 source body。

这证明 pi-lens 诊断不会被误计为 Convention Discovery Evidence 或 mutation。为单独验证 Convention Guard，TUI bypass 用例使用 pi-lens 的 `--no-read-guard`，避免两个独立门禁的结果互相混淆。

## 6. 真实 TUI bypass、Session/Branch/reset

真实 TUI 验证结果：

- 为精确目标授予 `/convention-bypass <path>` 后，其他路径仍被 `TARGET_NOT_READ` 阻断；
- 精确目标首次 edit 以 `BYPASS_GRANTED` 放行并消费授权；
- 第二次对同一目标 edit 被阻断，确认一次消费；
- grant 后执行 `/convention-reset confirm`，目标再次被阻断，确认 reset 清除授权；
- 新 Session 和 `--fork` Branch 均未继承父 Session 中未消费的 bypass。

因此 bypass 保持精确路径、单次消费、Branch-local，且不跨 Session。

## 7. HEAD 变化 Shell 审计

在 SnailJob detached worktree 中创建临时 commit `c3c4faaafccf674adbc0f0502d055a67cb2917b5`，只包含 `GuardHeadAuditProbe.java`。`post_change_audit` 记录：

- `headChanged: true`；
- `changedFileCount: 1`；
- `evidenceGapCount: 1`；
- 下一轮 Context `postChangeFindingCount: 1`；
- 既有 dirty `README.md` 未被纳入临时 commit；
- 审计前后既有工作区状态无差异；
- 日志不含 prompt、完整 Shell command 或源码正文。

验证后已将临时 commit reset 到原 HEAD。测试证明 HEAD diff、既有 dirty 隔离、下一轮 Context 和日志隐私按设计工作。

## 8. 自动验证与发布检查

准入收尾完成后执行：

- `npm run verify`：strict TypeScript、clean build、59/59 Node tests 通过；
- `npm pack --dry-run`：通过，无测试、`dist/`、日志或临时证据泄漏；
- `git diff --check`：通过；
- changed TypeScript 主验证以 `npm run verify` 为准；LSP silent-on-clean 不被当作独立通过证据。

## 9. 剩余限制

- Guard 仍为 experimental opt-in，默认 Observe；准入通过不等于默认开启。
- SnailJob UI `WebController` 的宽候选风险继续保留在观测指标中。
- SnailAI Admin 缺少 `node_modules`，其原生 typecheck/lint/format/build 仍为 `ENVIRONMENT_BLOCKED`；本轮没有安装依赖或修改 lockfile。
- 复杂 rename、超大 dirty worktree、macOS、真实 Linux TUI、其他 Pi 版本和未声明技术栈不在本次兼容结论内。
- Extension 源码变化不会热加载；使用 `multi-lexical-v6-semantic-peers` 前必须重启 Pi。

## 10. 准入决定

Stage 2 Guard 的既定证据门槛全部满足，生产准入收尾完成。后续可开始 Engineering Practice advisory MVP，但必须继续保持 Guard Discovery-only、默认 Observe、显式 opt-in 和 fail-open 边界；Practice 不得新增 `MISSING_COMMENT`、`METHOD_TOO_COMPLEX`、`DESIGN_PATTERN_REQUIRED` 等 Guard reason code。
