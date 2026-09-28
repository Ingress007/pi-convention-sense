# pi-convention-sense

为 Pi Coding Agent 提供**基于真实项目证据的编码惯例感知**。

它会在 Agent 读取代码后，从同仓库、同模块、同角色的实现中提取重复模式，生成有边界的 Local Evidence；项目也可以显式维护受审核的 Project Profile。默认模式是只观察、不阻断的 `observe`，`guard` 仍是实验性显式选项。

> 当前状态：功能闭环已经完成，适合本地开发和受控试用；尚未发布稳定版。
> 当前开发版本：`0.4.0-alpha.1`（未发布）
> Pi 当前验证基线：`0.87.1`（package peer dependency 按 Pi 规范使用 `*`，不代表所有版本均已验证）

## 1. 它解决什么问题

Agent 修改项目代码时，通常不知道：

- 当前文件属于哪个模块和架构边界；
- 应该参考哪些同类实现；
- 项目里的重复模式是主流规则、混合现状还是偶然样本；
- MVC Controller 和 REST Controller、页面和组件、应用代码和 workspace package 是否应该隔离；
- 项目明确知识与当前源码证据冲突时应该相信谁。

`pi-convention-sense` 使用三层 Project Intelligence：

1. **Global Baseline Pack**：通用技术栈知识，只能是 advisory；
2. **Project Profile**：项目审核后的技术栈、模块、角色、知识和规范；
3. **Local Evidence**：当前仓库中与目标 Scope 最相关的真实代码证据。

它不会自动重构代码，也不会因为风格差异直接阻断修改。

## 2. 当前支持范围

### 语言与文件

- Java
- TypeScript
- Vue SFC

### 项目边界

- Git repository
- Maven 单体与多模块项目
- Gradle 单体与多模块项目
- `package.json`
- pnpm workspace
- `packages/*`、`apps/*` workspace package

### 已识别角色

Java 包括 Controller、Service、ServiceImpl、Mapper、Repository、Client、Request/Response DTO 等。

TypeScript/Vue 包括：

- page
- component
- hook/composable
- API service
- request client
- Pinia store
- router
- layout
- workspace package

当前内置最小 Pack：

- `java-spring@1.0.0`
- `typescript-vue@1.0.0`

## 3. 安装要求

- Node.js `>=22.19.0`
- Pi `0.87.1`：当前开发与真实生命周期验证基线；其他版本见兼容矩阵
- Git：可选；Shell 后置审计需要 Git

插件仓库安装依赖并验证：

```bash
npm install
npm run verify
```

## 4. 在目标项目中使用

### 方式 A：一次性加载本地源码

适合开发和验证插件。请从**目标项目根目录**启动 Pi：

```powershell
pi --approve --no-extensions `
  -e C:\path\to\pi-convention-sense\extensions\index.ts `
  --skill C:\path\to\pi-convention-sense\skills\project-profiler
```

Bash：

```bash
pi --approve --no-extensions \
  -e /path/to/pi-convention-sense/extensions/index.ts \
  --skill /path/to/pi-convention-sense/skills/project-profiler
```

`--no-extensions` 会关闭自动发现的其他 Extension，但显式 `-e` 仍然加载本插件。

### 方式 B：项目本地安装

在目标项目根目录执行：

```bash
pi install /path/to/pi-convention-sense -l
pi --approve
```

安装后，Pi 会从 package 中发现 Extension 和 Project Profiler Skill。

### 为什么必须从目标项目根目录启动

Project Profile 按 Pi 启动仓库加载。比如要使用 SnailJob Profile，应从 SnailJob Git 根目录启动 Pi。

如果从插件仓库启动 Pi，再读取另一个仓库的绝对路径：

- 目标会解析到自己的 Git repository root；
- 候选和 Snapshot 仍严格限制在该外部 repository；
- 即使外部仓库存在 `.convention-sense/profile.json`，其状态也会是 `ignored`；
- 外部 Profile、effective role、Knowledge Capsule 和 Pack 不会进入当前受信会话；
- 只能得到 base role 和 Local Evidence；
- Snapshot 日志会记录 `profileStatus=ignored` 及原因。

这是安全边界，不是自动发现缺陷。Pi 的项目受信任状态属于启动仓库，不能隐式扩展到任意外部路径。若要使用外部仓库的 Profile，应退出当前 Pi，并从该外部仓库根目录使用 `--approve` 启动新的 Pi。`/convention-status` 展示的也是启动仓库的配置与 Profile。

## 5. 最小项目配置

在目标项目中创建：

```text
.pi/convention-sense.json
```

Java Observe 可以复制：

```powershell
New-Item -ItemType Directory -Force .pi
Copy-Item C:\path\to\pi-convention-sense\examples\config\java-observe.json `
  .pi\convention-sense.json
```

TypeScript/Vue Observe 使用：

```text
examples/config/typescript-vue-observe.json
```

Guard 使用：

```text
examples/config/java-guard.json
```

推荐先运行 Observe，确认候选和 Evidence 质量后再启用 Guard。

配置只有在项目受信任时加载，因此启动 Pi 时需要 `--approve`，或者通过 Pi 的项目信任流程批准项目。

### 第一次使用的最小流程

1. 从目标项目 Git 根目录启动 Pi，并确认项目已受信任。
2. 复制对应的 Observe 配置，运行 `/convention-status` 检查配置和 Profile 来源。
3. 先 `read` 目标文件和同类实现，再进行 `edit`/`write`；下一轮 Context 会注入 Snapshot。
4. 若显式启用 Guard，遇到 `TARGET_NOT_READ`、`SNAPSHOT_NOT_INJECTED` 等 reason code 时按提示补读并重试。
5. 仅在明确知道无需补读时使用精确路径的 `/convention-bypass <path>`；完成任务或切换上下文后可使用 `/convention-reset confirm`。

## 6. Observe 模式

Observe 是默认模式：

```json
{
  "enabled": true,
  "mode": "observe"
}
```

行为：

- 成功 read 后分析目标文件；
- 按 repository、module、role 选择候选；
- 在下一轮 Context 注入 `<local-convention>`；
- 有 Project Profile 时同时注入有预算限制的 `<project-knowledge>`；
- `practiceReview.mode="suggest"` 时，对已有 production target 的确定性结构信号注入有界 `<engineering-practice>` 审查问题；
- 记录潜在 `wouldBlock`，但不阻止 edit/write；
- Evidence 不足、无 peer、低置信或分析错误时 fail-open。

典型流程：

1. Agent 使用 `read` 读取目标文件；
2. Extension 创建 Snapshot；
3. 下一轮 Context 注入 Snapshot；
4. Agent 将其作为局部一致性证据，而不是绝对规则。

## 7. Guard 模式

Guard 必须显式启用：

```json
{
  "enabled": true,
  "mode": "guard"
}
```

Guard 只阻断缺少 Discovery 的情况：

- 已存在的目标文件尚未成功 read；
- valid Snapshot 尚未注入近期 Context；
- Snapshot 已过期。

Guard 不会因为以下情况永久阻断：

- weak 或 mixed Evidence；
- 无可用 peer；
- 低置信 Scope；
- generated、unsupported 或排除路径；
- 分析异常；
- 新文件没有足够 Evidence。

Guard 是实验性能力，建议只在 disposable worktree 或受控项目中启用。

### Engineering Practice Advisory 与 auto-once

默认 `suggest` 分析已经成功读取并形成 Snapshot 的现有 production target；若 Observe 对同类目标返回 `scope-unknown`，则只执行有界的 Practice-only fallback：

```json
{
  "practiceReview": {
    "mode": "suggest",
    "maxContextTokens": 400
  }
}
```

- `mode` 支持 `off | suggest | auto-once`，默认 `suggest`；
- 首批 Signal 覆盖事务与外部副作用、职责维度集中、状态与持久化、fallback/retry/compensation、兼容分支和多分支变化轴；
- Signal 只产生审查问题，不要求机械注释、强制拆方法或指定设计模式；
- Practice Capsule 在总 `maxContextTokens` 内使用独立上限，且不会挤掉已注入的 Local Snapshot；
- fallback 必须是 successful-read ledger 中的 existing production target，最多占用既有 4-target 上限；它不创建 Snapshot、Scope、peer evidence，也不改变 Guard；
- 简单代码、prospective target、test/generated/vendor/build output、低价值信号和分析错误不会产生 Practice Capsule；
- 日志只记录 Signal id、计数、reason、预算和耗时，不记录源码、完整问题正文或 diff。

`auto-once` 必须显式启用。它不在普通 Context 重复注入 suggest Capsule，而是在 `agent_before_settle` 只对当前任务成功修改、已读取且命中相关结构 Signal 的 production target 追加一条有界 review message，并请求当前 Agent 继续一次。正常 Snapshot 不可用且原因仅为 `scope-unknown` 时，可使用同一 Practice-only fallback。受控 edit/write 会先把输入归纳为 `relevant | unknown | irrelevant`，不保存正文；marker-free 的简单文字修改不会因为文件其他位置复杂而触发自审。Shell 只复用既有 Git 后置审计确认的 source path。

同一 task generation 即使 review 中继续修改也不会再次触发；Session/Branch 切换会清空 generation。已有其他 continuation、无 mutation、无相关 mutation、无 Signal、分析错误或预算不足都 fail-open。Practice Advisor 不改变 Guard 决策，也不调用第二个 LLM。

## 8. Project Profile

可共享的项目知识文件位于：

```text
.convention-sense/profile.json
```

Profile 可以描述：

- 技术栈和版本；
- 模块与架构；
- base role 到 effective role 的细分；
- 项目知识与项目规范；
- 启用的 Global Packs；
- review 状态和证据来源。

安全规则：

- 未信任、无效或跨仓库 Profile 不加载；
- Selector 只允许声明式白名单字段，不允许脚本；
- draft Profile 的 hard 规则降级为 advisory；
- Global Pack 永远不会成为现有项目的 Guard 硬规则；
- 完整 Profile 不会每轮注入，只生成当前 Scope 的 Knowledge Capsule；
- Extension 不会修改 `AGENTS.md`。

## 9. Project Profiler Skill

仅运行 Observe **不会自动生成 Project Profile**。这是有意的安全设计，避免把一次观察直接升级为项目规范。

标准采用流程：

1. 生成候选 Profile；
2. 校验 schema 和 repository root；
3. 查看语义 diff；
4. 用户明确批准；
5. adopt 为 active Profile；
6. 通过项目代码审查后提交。

Skill 命令：

```text
/skill:project-profiler init
/skill:project-profiler adopt
/skill:project-profiler refresh
/skill:project-profiler diff
```

中间文件：

```text
.convention-sense/profile.candidate.json
```

active 文件：

```text
.convention-sense/profile.json
```

Profiler 使用当前 Agent，不会引入第二个 LLM；默认生成 `draft`，且不会静默覆盖 active Profile。

## 10. 为什么真实测试后项目里可能没有 Profile

如果测试使用 disposable Git worktree：

- Profile 和配置只复制到临时 worktree；
- 原仓库保持只读；
- worktree 清理后，测试配置随之删除；
- 永久结论保留在 `docs/evaluations/`，原始日志属于临时产物。

这叫“验证”，不是“项目采纳”。只有执行 Profiler 的 adopt 流程，真实项目才会留下 `.convention-sense/profile.json`。

## 11. 文件生命周期

| 路径 | 类型 | 建议提交 |
|---|---|---:|
| `.pi/convention-sense.json` | 项目运行配置 | 是 |
| `.convention-sense/profile.json` | 审核后的项目知识 | 是 |
| `.convention-sense/profile.candidate.json` | 审核中间文件 | 否 |
| `.pi/convention-sense/` | 本地日志和 Session 状态 | 否 |
| `.tmp/pi-convention-sense/` | 本地临时评估产物 | 否 |
| `docs/evaluations/` | 永久评估结论 | 是 |
| `test/fixtures/` | 自动测试资产 | 是 |

插件仓库中的 `.pi/settings.json` 只是本插件开发时的 package 自加载配置，不是用户项目配置。

完整说明见：[文件与目录生命周期](docs/file-lifecycle.md)。

## 12. Pi 命令

```text
/convention-status
/convention-reset confirm
/convention-snapshot
/convention-bypass <path>
/convention-audit
```

- `/convention-status`：查看配置来源、Profile、fingerprint、Packs、Practice mode、read、mutation、Guard、Snapshot 和日志状态；
- `/convention-reset confirm`：清空当前 Branch 的 read ledger、Snapshot、Guard/bypass 和 post-change 状态，并写入空 checkpoint；保留配置、Profile 和审计日志；
- `/convention-snapshot`：查看当前 Snapshot；
- `/convention-bypass <path>`：为精确路径提供一次性 bypass；
- `/convention-audit`：检查 Shell 修改后的 Discovery 缺口。

`/convention-status` 的项目信息示例：

```text
config-source=project
practice=suggest, practice-tokens=400
profile=loaded, review=draft, fingerprint=60e259b2419659a4
packs=java-spring@1.0.0
```

Bypass 只在原本会阻断时消费，不跨 Session 或 Branch。

## 13. 第三方工具映射

受信项目可以声明第三方工具的 read/edit/write 语义：

```json
{
  "toolMappings": [
    { "toolName": "custom_read", "operation": "read", "pathField": "file.path" },
    { "toolName": "custom_patch", "operation": "edit", "pathField": "path" }
  ]
}
```

内置映射不能覆盖。未映射工具不会被误判为 mutation 工具。

## 14. Shell 后置审计

对存在修改风险的 Bash/PowerShell 调用，Extension 会在执行前记录 Git baseline，并在执行后比较真实 diff。

它不会记录完整 Shell 命令，只记录长度、风险标签、文件路径和审计结果。

非 Git 项目或 Git 状态不可用时 fail-open。

## 15. 日志与隐私

默认日志：

```text
.pi/convention-sense/observe.ndjson
```

日志允许记录：

- 路径；
- Scope；
- 候选分数和数量；
- Evidence support；
- Guard reason code；
- Profile fingerprint；
- 生命周期事件。

日志禁止记录：

- 源码正文；
- edit old/new text；
- write 内容；
- 完整 prompt；
- 完整 Shell 命令。

## 16. 真实项目验收与业务开发记录

SnailJob 后端和 `snail-job-admin` 已在 Pi `0.87.1` 下完成 Profile、Pack、Local Evidence、Observe、Guard、Session/Branch、仓库信任边界和隐私验收。除插件链路外，还在真实 `master` 分支完成了一套未提交的 Job Tag Management CRUD，用于验证插件辅助真实业务开发：

- 后端采用 Controller → Service → Mapper/PO 分层，并由服务端从 `UserSessionUtils.currentUserSession()` 推导 namespace；
- 更新、删除同时限定记录 ID 与 namespace，覆盖分页、关键词和 `tagStatus` 筛选；
- 数据库定义覆盖 MySQL、PostgreSQL、Kingbase、Oracle、DM8、SQL Server；
- Admin 覆盖 typed API、`Api.*` 类型、表格/抽屉、路由局部搜索和中英文 i18n；
- 后端 compile、Admin typecheck/build、`git diff --check` 均通过，业务修改按要求保持未提交供人工审查。

SnailAI 后端和 Admin 已完成静态分析及真实 Pi 主流程验收；SnailAI Admin 的原生 typecheck、lint、format、build 因缺少 `node_modules` 暂列 `ENVIRONMENT_BLOCKED`，未安装依赖或修改 lockfile。Stage 2 还完成了 24 个 SnailJob/SnailAI Observe/Shadow Guard 任务、真实 TUI bypass、pi-lens 共存和 HEAD 变化 Shell 审计。Engineering Practice 已完成 P1 Advisory、P2 `auto-once` 真实 Pi 生命周期、P3 的 18 次真实任务质量评估，以及 `scope-unknown` provider 正例和简单 wrapper 负例的有界 fallback 验证。详见：[SnailJob 报告](docs/evaluations/snail-job-pi-0.87.1-results.md)、[SnailAI 报告](docs/evaluations/snail-ai-pi-0.87.1-results.md)、[Guard 生产准入报告](docs/evaluations/guard-production-readiness-results.md)、[Practice Advisory MVP](docs/evaluations/practice-advisory-mvp-results.md)、[Practice auto-once](docs/evaluations/practice-auto-once-results.md)、[Practice P3](docs/evaluations/practice-quality-p3-results.md)、[`scope-unknown` fallback](docs/evaluations/practice-scope-unknown-fallback-results.md)和[发布就绪报告](docs/evaluations/release-readiness-results.md)。

## 17. 常见问题

### Profile 显示 missing

检查：

1. 是否从目标 Git repository 根目录启动 Pi；
2. `.convention-sense/profile.json` 是否存在；
3. 是否使用 `--approve`；
4. Profile 的 `repositoryRoot` 是否为当前仓库；
5. Profile schema 是否通过校验。

### 修改 Extension 后行为没有变化

Extension 实现代码不会热加载，需要重启 Pi。

### 修改配置后行为没有变化

`.pi/convention-sense.json` 在启动时加载，修改后需要重启 Pi。

### 为什么仍看到以前读取文件的 Snapshot

如果恢复了原 Session，read ledger 和 Snapshot 可以从 checkpoint 恢复。优先执行：

```text
/convention-reset confirm
```

该命令只重置当前 Branch，保留日志，并通过空 checkpoint 防止重启后再次恢复旧状态。已经进入当前 LLM Context 的消息无法撤回，但下一轮不会再次注入。

如果需要同时删除本地日志，可以退出 Pi 后删除 `.pi/convention-sense/`，再启动全新 Session。

### 为什么 generated 文件没有 Snapshot

这是预期行为。generated、test、vendor、build output 和声明文件会被排除或 fail-open。

### 为什么 MVC 与 REST 仍混在一起

如果 Profile missing，只能使用 base role `controller`。创建并审核 Project Profile 后，effective role 可以将其分为 `mvc-view-controller` 与 `rest-controller`。

## 17. 开发与验证

```bash
npm run check
npm test
npm run verify
npm pack --dry-run
```

当前自动测试基线：`npm run verify` **70/70** 通过。

GitHub Actions 在 Windows/Ubuntu、Node `22.19.0`/`22.x` 上运行 `npm run verify`，并单独检查 package 内容。详见：[兼容性与验证矩阵](docs/compatibility.md)。

真实仓库评估工具：

```bash
node scripts/evaluate-java-repository.mjs <repository-root>

node scripts/evaluate-profile-repository.mjs \
  --root <repository-root> \
  --sample <relative-target-path>
```

临时输出统一写入：

```text
.tmp/pi-convention-sense/evaluations/
```

## 18. 当前成熟度与限制

- Observe：适合受控试用；
- Guard：既定生产准入门槛已通过，继续保持 experimental opt-in、默认 Observe 和 Discovery-only；
- Engineering Practice：advisory MVP、opt-in `auto-once`、前后两轮架构审查、P3 真实质量评估和 `scope-unknown` 有界 fallback 已完成；默认继续为 `suggest`，`auto-once` 保持 opt-in；
- Project Profile：已完成首个垂直闭环；
- Pack catalog：目前只有 Java/Spring 与 TypeScript/Vue 最小 baseline；
- 未覆盖小程序、移动端、React Native、UniApp、桌面端和其他客户端；
- 当前只将 Pi `0.87.1` 列为现行验证基线；`0.85.1` 仅保留历史验证记录，其他版本未进入当前回归矩阵；
- Practice Advisor 只提出结构信号支持的审查问题，不断言业务语义、注释必要性、架构优劣或方法必须拆分，也不会把这些主观判断加入 Guard；
- Profile 目前按 Pi 启动仓库加载，不会为任意外部路径动态切换。

## 19. 文档索引

- [项目知识库](docs/knowledge-base.md)
- [Agent 工作规范](AGENTS.md)
- [更新日志](CHANGELOG.md)
- [文件与目录生命周期](docs/file-lifecycle.md)
- [兼容性与验证矩阵](docs/compatibility.md)
- [产品需求](docs/requirements.md)
- [技术设计](docs/design.md)
- [Project Intelligence](docs/project-intelligence.md)
- [Engineering Practice 设计与任务顺序](docs/engineering-practice.md)
- [Practice Advisory MVP 验证](docs/evaluations/practice-advisory-mvp-results.md)
- [Practice auto-once 验证](docs/evaluations/practice-auto-once-results.md)
- [P1 整体架构必要性审查](docs/evaluations/architecture-necessity-review.md)
- [auto-once 后置整体架构复审](docs/evaluations/auto-once-architecture-review.md)
- [Practice P3 真实质量评估](docs/evaluations/practice-quality-p3-results.md)
- [`scope-unknown` Practice fallback 评估](docs/evaluations/practice-scope-unknown-fallback-results.md)
- [Pack/Adapter 贡献与测试规范](docs/contributing-adapters-and-packs.md)
- [Stage 0 Spike](docs/stage-0-spike.md)
- [Stage 1 Observe](docs/stage-1-observe.md)
- [Stage 2 Guard](docs/stage-2-guard.md)
- [Guard 生产准入结果](docs/evaluations/guard-production-readiness-results.md)
- [Web 技术栈覆盖调研](docs/research/web-technology-stack-coverage.md)
- [SnailJob 全栈验证](docs/evaluations/snail-job-fullstack-results.md)
- [SnailJob Pi 0.87.1 验收](docs/evaluations/snail-job-pi-0.87.1-results.md)
- [SnailAI Pi 0.87.1 验收](docs/evaluations/snail-ai-pi-0.87.1-results.md)
- [SnailJob/SnailAI 发布就绪评估](docs/evaluations/release-readiness-results.md)
- [双项目测试计划与执行记录](docs/evaluations/snail-job-snail-ai-test-plan.md)
