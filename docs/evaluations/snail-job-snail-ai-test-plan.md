# SnailJob 与 SnailAI 真实项目全场景测试计划

> 状态：已执行；SnailJob/SnailAI P0 主流程已完成，SnailAI Admin 原生检查存在环境阻塞
> 执行顺序：已按计划先完成 SnailJob，再进入 SnailAI
> Pi 基线：`0.87.1`
> 编排方式：Tabby MCP + 独立本地 Git Bash + 真实 Pi 子进程
> 安全策略：插件链路修改场景使用 detached disposable worktree；另有用户明确批准的 SnailJob 真实业务 CRUD 验收例外，直接保留在 master 未提交供人工审查

## 1. 新会话交接摘要

### 1.1 pi-convention-sense 当前基线

| 项目 | 当前值 |
| --- | --- |
| 仓库 | `C:/Users/ingre/Desktop/DevProject/pi-convention-sense` |
| 当前提交 | `55d80d749402be42ab89634562819301a76162fe` |
| 提交主题 | `chore(peer-deps): 升级 Pi 依赖版本并同步相关依赖项` |
| 开发版本 | `0.4.0-alpha.1`，未发布 |
| Pi 开发与真实生命周期基线 | `0.87.1` |
| Pi peer dependency | `*`；仅表示宿主提供依赖，不表示所有版本已验证 |
| Node.js | `>=22.19.0`；本机 `v22.22.2` |
| 自动测试 | `npm run verify`，56/56 |
| Profile | `0.2.0`、`draft`、fingerprint `f806157678d37814` |
| 默认模式 | `observe` + fail-open |
| Guard | experimental opt-in |

当前插件仓库只有未跟踪的 `.mcp.json`；不要把它误判为产品源码变化，也不要在没有明确决定时提交。它只包含：

```json
{
  "mcpServers": {
    "tabby-mcp": {
      "url": "http://127.0.0.1:13001/mcp"
    }
  }
}
```

已完成的关键工作：

- Project Intelligence 已融合进 `docs/requirements.md` 和 `docs/design.md`；
- Pi 依赖、lockfile、文档和 Profile 已升级到 `0.87.1`；
- 稳定指导改用 `systemPromptOptions.sections["pi-convention-sense"]`；
- fresh Pi 0.87.1 子进程已验证 Extension 加载、Context、Profile、settle 和 shutdown；
- Profile 已按 candidate → validate → diff → 显式批准 → adopt 更新；
- Markdown 链接、JSON、package dry-run 和仓库卫生检查已通过。

### 1.2 Tabby MCP 基线

- MCP 注册名：`tabby-mcp`；
- URL：`http://127.0.0.1:13001/mcp`；
- 已验证本地 Git Bash 可执行命令、读取输出并返回退出码；
- Tabby MCP 的 `exec_command` 包装器使用 Bash 语法，PowerShell profile 会进入 `>>` continuation prompt，因此本计划统一使用 **Git Bash**；
- Tabby 中存在生产 SSH 会话，测试期间不得选择、聚焦、发送输入或执行命令；
- 新会话必须先调用 `get_session_list`，按 `type=local` 和 `profileName=Git Bash` 选择会话，不得依赖 tab index；
- 若没有独立本地会话，使用 `open_profile(profileId="local:git-bash")` 新建；
- 长命令使用 `waitForOutput=false`，再以 `get_command_status` 和 `get_terminal_buffer` 轮询；
- 不得使用 `close_all_tabs`。

### 1.3 当前真实仓库基线

| 项目 | 用途 | 路径 | 分支 | 基线提交 | 原始状态 |
| --- | --- | --- | --- | --- | --- |
| SnailJob 后端 | 测试 | `C:/DevelopmentProjectFiles/snail-job/snail-job` | `master` | `d837ef0bad8f3182ad1fd262249d198ce0df2f5e` | 仅未跟踪 `.pi/`，必须保留 |
| SnailJob Admin | 测试 | `C:/DevelopmentProjectFiles/snail-job/snail-job-admin` | `master` | `9797d1f53c41d56a03d8d1af30d37d5d6d480e72` | clean |
| SnailJob Demo | 排除 | `C:/DevelopmentProjectFiles/snail-job/snail-job-demo` | `master` | `dd7db0ed2b716e6f30c169daf88a6fdd5ec550ac` | 不测试 |
| SnailAI 后端 | 测试 | `C:/DevelopmentProjectFiles/snail-ai/snail-ai` | `master` | `10c1d3e50b701be62da23a3403d79a41187ab8cd` | clean |
| SnailAI Admin | 测试 | `C:/DevelopmentProjectFiles/snail-ai/snail-ai-admin` | `master` | `3b2db48d7849554631f7b6f726c41b99af7c3462` | clean |
| SnailAI Chat | 排除 | `C:/DevelopmentProjectFiles/snail-ai/snail-ai-chat` | `master` | `d7f649c25cbbcd6b8cee876f809553bce7997b90` | 不测试 |

技术栈差异：

- SnailJob 后端：Java 21、Spring Boot 4.0.3、Maven 多模块、gRPC/protobuf、MyBatis；
- SnailAI 后端：Java 21、Spring Boot 4.1.0、Spring AI 2.0.0、Maven 多模块、gRPC/protobuf、MyBatis、多个模型/provider/starter 模块；
- SnailJob Admin：Vue 3.5、TypeScript 5.8、Vite 7、Pinia、pnpm workspace；
- SnailAI Admin：Vue 3.5、TypeScript 5.9、Vite 7、Pinia、pnpm workspace，并使用 oxlint/oxfmt。

## 2. 执行结果摘要

本计划已执行完成，永久结果见：[SnailJob Pi 0.87.1 验收](snail-job-pi-0.87.1-results.md)、[SnailAI Pi 0.87.1 验收](snail-ai-pi-0.87.1-results.md)、[发布就绪评估](release-readiness-results.md)。SnailJob P0 通过后才进入 SnailAI；两项目的静态分析、Observe、Profile、Guard 主路径、仓库信任边界和日志隐私均通过。

SnailJob 另外完成 Job Tag Management CRUD v2 真实业务开发验收：后端 compile、Admin typecheck/build、六种 SQL 方言、namespace 隔离、分页/筛选、typed API、drawer/i18n 均通过。该业务 diff 不创建 commit，按用户要求保留在真实 `master` 分支供人工审查。

SnailAI Admin 缺少 `node_modules`，原生 typecheck、lint、format、build 分类为 `ENVIRONMENT_BLOCKED`；本轮未安装依赖、未修改 lockfile。真实 TUI 手动 bypass、HEAD 变化 Shell 和 pi-lens 同时安装联调仍是 Guard 生产准入待办，不影响本轮 P0 结论。

## 3. 测试目标

1. 在 Pi `0.87.1` 下验证 Extension 的完整真实生命周期，而不只验证类型兼容；
2. 验证 Java、TypeScript、Vue 和 workspace Adapter 在两个独立项目上可泛化；
3. 验证 Global Pack、Project Profile、Knowledge Capsule 与 Local Evidence 三层模型；
4. 验证 Observe 永不阻断，Guard 只阻断可完成的 Discovery 缺口；
5. 验证 repository、module、role、Session、Branch、Profile trust 和 cache 隔离；
6. 验证 generated/test/vendor/build output 排除；
7. 验证 read ledger、Snapshot freshness、Context freshness、token budget、reset 和 bypass；
8. 验证 Shell 后置审计和日志隐私；
9. 收集候选准确率、潜在误拦截率、性能和 token 指标；
10. 形成发布前可复现的永久报告，不覆盖历史 0.85.1 评估。

## 4. 非目标

本轮不执行：

- `snail-job-demo`；
- `snail-ai-chat`；
- 生产 SSH 服务器上的任何操作；
- npm publish、Git tag、Git push；
- 真实数据库、消息队列、外部模型、对象存储或生产服务联调；
- 把测试生成的 draft Profile 写入原始真实仓库；
- 将一次测试结果自动提升为 reviewed Profile 或修改 `AGENTS.md`；
- 为了匹配单个项目而进行无关重构。

项目原生 compile/typecheck/build 属于修改后的安全验证，不等于业务服务端到端测试。若依赖下载、私服、凭据或外部服务不可用，必须记录为环境阻塞，不得伪造通过。

## 5. 安全和隔离规则

### 4.1 原始仓库只读

每个阶段前后记录：

```text
repository root
branch
HEAD
status --short
tracked-file hash summary
```

禁止在原始仓库执行：

- edit/write；
- `git clean`、`git reset --hard`、强制 checkout；
- dependency update；
- commit、rebase、merge；
- 修改 `.gitignore` 或现有 `.pi/`。

SnailJob 后端已有未跟踪 `.pi/`，不得删除、覆盖或把它计为测试污染。

### 4.2 修改测试只在 disposable worktree

建议目录：

```text
C:/DevelopmentProjectFiles/.pi-convention-sense-worktrees/<run-id>/<repository-name>
```

规则：

1. `git worktree add --detach` 创建；
2. 记录源 commit 和 worktree HEAD；
3. 测试配置、test-only Profile、日志和修改都留在 worktree；
4. 每个场景记录修改前后 blob/hash；
5. 测试后恢复文件并检查 clean；
6. `git worktree remove --force` 后执行 `git worktree prune`；
7. 最后重新检查四个原始被测仓库状态。

### 4.3 日志和隐私

本地临时产物统一保存到：

```text
.tmp/pi-convention-sense/evaluations/<run-id>/<project>/<repository>/
```

允许保存：事件、规范化路径、Scope、计数、reason code、fingerprint、耗时、hash 和状态。禁止写入永久报告：源码正文、edit/write 内容、完整 prompt、完整 Shell 命令、密钥、token、Cookie 或私有配置。

Tabby terminal buffer 只用于实时判断；永久报告只保留脱敏结论。

## 6. 执行总顺序与闸门

```text
插件预检
  ↓
SnailJob 后端静态分析
  ↓
SnailJob Admin 静态分析
  ↓
SnailJob 四仓库边界/真实 Pi Observe/Profile
  ↓
SnailJob disposable worktree Guard/Branch/Shell
  ↓
SnailJob 原生安全检查与总结
  ↓ 仅当所有 P0 通过、无未解决产品缺陷
SnailAI 后端无 Profile 泛化测试
  ↓
SnailAI Admin 无 Profile 泛化测试
  ↓
SnailAI test-only Profile/Pack 测试
  ↓
SnailAI Guard/Branch/Shell/原生安全检查
  ↓
回归 SnailJob 关键 P0 场景
  ↓
联合发布就绪报告
```

若 SnailJob 有任何 P0 产品失败，不得进入 SnailAI。修复流程为：

1. 在插件仓库定位并修复；
2. 添加自动回归测试；
3. `npm run verify`；
4. 重跑失败场景；
5. 重跑 SnailJob 全部 P0；
6. 全部通过后才进入 SnailAI。

SnailAI 暴露出的通用修复同样必须回归 SnailJob，防止为了第二个项目破坏第一个项目。

## 7. 阶段 0：插件与环境预检

### 6.1 插件仓库

- 确认当前 commit 和 worktree 状态；
- `pi --version` 必须为 `0.87.1`；
- `node --version` 满足 `>=22.19.0`；
- `npm run verify` 必须 56/56；
- `npm pack --dry-run` 必须成功；
- active Profile validate/fingerprint 必须通过；
- `.mcp.json` 不进入 npm package；
- Extension 绝对路径可读。

### 6.2 Tabby

- MCP server connected；
- 只选择或创建 local Git Bash session；
- 用 marker 命令验证 cwd、Pi、Node 和 exit code；
- 验证 async command、status、buffer 和 Ctrl+C；
- 记录 sessionId，但每次重连后重新发现；
- 不触碰任何 SSH session。

### 6.3 被测仓库

- 校验上述 commit 是否仍一致；
- 记录 dirty 基线；
- 检查 Java/Maven、Node/pnpm 可用性；
- 检查磁盘空间和 worktree 可创建性；
- 不在原始仓库安装依赖。

## 8. 阶段 1：静态 Adapter 与候选质量

### 7.1 抽样规模

每个后端抽取 24～32 个 production Java 目标；每个 Admin 抽取 18～24 个 TypeScript/Vue 目标。若角色存在，至少覆盖 2 个；总样本不少于 84 个。

选择固定排序和文件大小分位，避免只挑简单或高度相似文件。样本清单必须保存相对路径和 commit，确保可复现。

### 7.2 后端角色矩阵

两个后端均覆盖：

- REST Controller；
- MVC/View Controller（若存在）；
- Service interface；
- Service implementation；
- Mapper/Repository；
- Request DTO；
- Response DTO；
- Entity/PO/VO 的受支持与不受支持边界；
- Client/adapter；
- 配置类或未知角色 fail-open；
- test source；
- generated protobuf/gRPC；
- prospective new Java file。

SnailAI 额外覆盖：

- agent 模块与 server 模块隔离；
- model/provider/starter 模块隔离；
- Spring AI 与 LangChain4j 相关实现不因共同后缀跨模块混用；
- chat、embedding、rerank provider 的同角色异模块边界。

### 7.3 Admin 角色矩阵

两个 Admin 均覆盖：

- Vue page；
- route-local component；
- shared component；
- hook/composable；
- typed API service；
- application request client；
- Pinia store；
- router；
- layout；
- `packages/*` workspace request client；
- `packages/*` workspace hook/library；
- generated declaration；
- test、build output、vendor/node_modules 排除；
- prospective new page/component/API file。

### 7.4 每个样本的断言

记录并检查：

- repository root；
- language/source kind；
- module/workspace package；
- base role/effective role；
- Scope confidence；
- indexed/considered/selected 数量；
- candidate path、score 和 breakdown；
- Evidence support/samples/counterEvidence；
- Snapshot status、token、duration；
- config/analyzer/Profile/Pack fingerprint；
- reason code。

硬性断言：

- 跨 repository candidate = 0；
- test/generated/vendor/build output candidate = 0；
- 同 role/effective role 比例 = 100%，除非明确 fail-open；
- workspace candidate 不跨 package；
- 目标文件不作为自己的 peer；
- unsupported/unknown 不抛出到 Pi lifecycle。

### 7.5 性能

每个仓库至少执行：

- 1 次 cold index；
- 5 次 warm analysis；
- 3 个不同 role 的 Snapshot formatting；
- 1 次低 token budget；
- 1 次 Profile/Pack fingerprint 变化后的 stale 检查。

记录平均值、P95、最大值和文件数，不用单次最快结果替代总体数据。

## 9. 阶段 2：真实 Pi 0.87.1 Observe

每个被测仓库都必须从自身 worktree 根目录启动 fresh Pi，不能从插件仓库读取外部路径来替代。

启动原则：

- `--no-extensions` 后显式加载当前 Extension；
- 首轮优先 `--no-session`/`--print` 做确定性流程；
- 交互命令、Branch 和 Guard 使用独立 TUI Session；
- 每个仓库使用独立日志目录和配置；
- 不复用上一个仓库的 Session、checkpoint、cache 或 Profile。

### 8.1 生命周期

验证事件序列：

```text
session_start
before_agent_start
agent_start
turn_start
context
turn_end
agent_end
agent_settled
session_shutdown
```

同时验证：

- named system prompt section 生效；
- 无 Snapshot 时只注入 unavailable disclaimer；
- 成功 read 后创建 Snapshot；
- 下一轮注入 Snapshot/Knowledge Capsule；
- 同 Scope 不重复注入；
- failed/pending read 不进入 ledger；
- 日志无源码、完整 prompt 和完整命令。

### 8.2 Observe shadow

对已有文件、新文件、weak/no-peer、excluded、unsupported 和 analysis error 分别触发模拟 mutation，确认：

- Observe 不阻断；
- `wouldBlock` 和 reason code 正确；
- Low/Mixed 只表达不确定性；
- 不出现永久 Discovery deadlock。

### 8.3 跨仓库信任

至少测试：

1. 从 SnailJob 后端 Session 读取 SnailJob Admin 绝对路径；
2. 从 SnailJob 后端 Session 读取 SnailAI 后端绝对路径；
3. 从 SnailAI Admin Session 读取 SnailJob Admin 绝对路径。

断言：

- Candidate 只来自目标文件所属 repository；
- 启动仓库 Profile 不作用到外部 repository；
- 外部 Profile 状态为 `ignored`；
- Snapshot/cache 不跨 repository 复用。

## 10. 阶段 3：Profile、Pack 与 Knowledge Capsule

### 9.1 SnailJob

使用现有 test fixture Profile 复制到 disposable worktree：

- 后端 fingerprint 基线：`60e259b2419659a4`；
- Admin fingerprint 基线：`5276d8f8709b256e`。

先验证无 Profile 的纯 Local Evidence，再验证 Profile loaded 的 effective role、Pack 和 Capsule，避免 Profile 掩盖 Adapter 缺陷。

### 9.2 SnailAI

先在无 Profile 状态完成全部基础泛化测试。然后在 disposable worktree 内生成 **test-only draft Profile**：

1. candidate-first；
2. validate；
3. fingerprint；
4. semantic diff；
5. 只用于测试 worktree；
6. 不复制回原仓库；
7. 不声明 reviewed。

重点验证 module/effective role 是否能隔离 server、agent、model/provider/starter 及 Admin workspace package。

### 9.3 共同断言

- Global Pack 永远 advisory；
- draft Profile hard 项运行时降级为 advisory；
- 完整 Profile 不进入 Context；
- Capsule 只包含目标相关条目；
- Capsule + Snapshot 不超过预算；
- Profile、Pack 和 config 变化使旧 Snapshot stale；
- selector 不接受未知字段、脚本或命令。

## 11. 阶段 4：真实 Guard（仅 disposable worktree）

后端和 Admin 均执行以下 P0 场景：

| 场景 | 预期 |
| --- | --- |
| 未读取已有目标直接 edit | `TARGET_NOT_READ` block，文件 hash 不变 |
| read 成功但 Snapshot 未注入 | `SNAPSHOT_NOT_INJECTED` block |
| read → valid Snapshot → Context → edit | `SNAPSHOT_VALID` allow |
| stale Snapshot | block，重新读取/分析后可恢复 |
| weak/mixed/no-peer | fail-open |
| excluded/generated/unsupported | fail-open |
| prospective new file，有 peers | 先建立 Evidence/Context，再允许 write |
| prospective new file，无 peers | fail-open |
| path exception | explicit allow reason |
| one-time bypass | 只允许精确路径的一次 mutation |
| bypass 第二次使用 | 不再生效 |
| 其他路径消费 bypass | 不得消费 |
| reset 后再 edit | 重新要求 Discovery |

每次 block 都必须比较 edit 前后 blob/hash，不能只相信 Agent 文本。

允许的测试修改应是最小、可逆、无业务语义的注释或 test-only 文件；验证后立即恢复。

## 12. 阶段 5：Session、Branch、命令与 reset

通过 Tabby 驱动真实 TUI，覆盖：

- `/convention-status`：mode、config source、Profile、review、fingerprint、Packs、counts；
- `/convention-snapshot`：目标 Scope 与状态；
- `/convention-audit`：post-change finding；
- `/convention-bypass <path>`：精确单次 bypass；
- `/convention-reset`：无 `confirm` 时拒绝；
- `/convention-reset confirm`：当前 Branch reads/mutations/Snapshots/Guard 状态归零；
- `/tree`：切换 Branch 后只恢复目标 Branch checkpoint；
- resume：重启后恢复当前 Branch 的 v3 checkpoint；
- `/quit`：记录正常 shutdown。

断言 bypass、recent Context 和 post-change authorization 均不跨 Session/Branch。

## 13. 阶段 6：Shell 后置审计

在 disposable worktree 中分别验证：

1. clean → shell 修改 tracked file；
2. already dirty → 同一文件再次修改；
3. shell 新建文件；
4. shell 删除后恢复文件；
5. shell commit 导致 HEAD 变化；
6. 已有 fresh Evidence 与无 Evidence 的差异；
7. post-change gap 在下一轮 Context 出现；
8. 重新读取并注入 fresh Evidence 后 gap 消除；
9. 完整 Shell 命令不进入日志。

所有 commit 只允许发生在 detached worktree，测试结束后整体销毁。

第三方工具映射作为 P1：若新会话能创建临时 helper Extension，则注册 test-only read/mutation tool，验证显式 `toolName + operation + pathField`；否则以现有自动测试为证据并记录未做真实联调，不伪造通过。

## 14. 阶段 7：异常、预算与隐私

每个技术栈至少覆盖：

- malformed config → fallback，不崩溃；
- invalid Profile → `invalid` + fail-open；
- missing Profile → Local Evidence；
- external Profile → `ignored`；
- 低 token budget → bounded/budget-exhausted，不超预算；
- 文件在 read 后变化 → stale；
- Profile/Pack fingerprint 变化 → stale；
- target 删除或 rename → 明确 reason，不抛出生命周期；
- tool failure → 不记成功 read；
- repeated Context → 无同 Scope 重复；
- 路径包含 Windows 分隔符、POSIX 分隔符和大小写变化；
- 日志敏感内容扫描为 0。

不得为构造异常而破坏原仓库；全部在 worktree 或临时目录完成。

## 15. 阶段 8：项目原生安全检查

这些检查用于证明 Guard 放行的最小修改不会破坏项目，不作为 Adapter 判定的替代品。

### 后端

- 记录 `java -version`、`mvn -version`；
- 优先执行受影响 leaf module 的 compile/test；
- 必要时执行根级 Maven verify，但不得依赖真实数据库或外部服务；
- 先使用项目既有 wrapper/命令；
- 网络、私服或依赖不可用时记录环境 blocker。

### Admin

- 使用项目声明的 pnpm 版本；
- `pnpm install --frozen-lockfile` 只允许在 disposable worktree；
- SnailJob Admin：`pnpm typecheck`、必要时 `pnpm build`；
- SnailAI Admin：`pnpm typecheck`、`pnpm lint`、`pnpm fmt` 检查和必要时 `pnpm build`；
- 测试不得改 lockfile；若 formatter 修改文件，应恢复并记录。

## 16. 通过门槛

### 15.1 P0：进入下一个项目的硬门槛

- 原始四个被测仓库 tracked 文件变化 = 0；
- 跨 repository candidate = 0；
- generated/test/vendor/build output 进入生产 Evidence = 0；
- Observe block = 0；
- Guard 永久阻塞 = 0；
- Guard 因纯风格差异 block = 0；
- unread block 后文件变化 = 0；
- read + valid Snapshot + Context 后可恢复并放行；
- weak/no-peer/unsupported/error 全部 fail-open；
- Profile trust 跨仓库泄漏 = 0；
- Session/Branch/bypass 泄漏 = 0；
- 日志源码、完整 prompt、完整命令或凭据泄漏 = 0；
- Pi 生命周期未捕获异常 = 0；
- reset 后状态符合预期；
- disposable worktree 全部清理。

### 15.2 P1：质量与性能门槛

| 指标 | 门槛 |
| --- | ---: |
| Top-K 候选语义认可率 | ≥ 80% |
| High confidence Observation 准确率 | ≥ 90% |
| Observe 潜在误拦截率 | ≤ 10% |
| 同 leaf module/workspace 优先率 | ≥ 90%，角色确有跨模块语义时单独解释 |
| Snapshot token | ≤ 配置上限，默认 1200 |
| cold analysis P95 | ≤ 5 秒 |
| warm analysis P95 | ≤ 1 秒 |
| 同 Scope 重复注入 | 0 |

指标由机器统计和人工语义复核共同决定；不能用路径相似度自动替代业务语义判断。

## 17. 结果分类与停止条件

每个失败必须分类：

- `PRODUCT_DEFECT`：Extension/Analyzer/Guard/Profile Runtime 缺陷；
- `TEST_HARNESS_DEFECT`：Tabby、脚本、超时或场景构造问题；
- `ENVIRONMENT_BLOCKED`：依赖、网络、凭据、JDK、pnpm 或外部服务缺失；
- `PROJECT_EXPECTED`：项目真实混合约定或无 peers，产品已正确保留不确定性；
- `NEEDS_HUMAN_REVIEW`：技术上同 role/module，但业务语义无法自动确认。

出现以下情况立即停止当前阶段：

- 原始仓库 tracked 文件变化；
- 命令目标落到生产 SSH；
- 日志出现密钥或源码正文；
- Guard 造成无法通过 read/Context/bypass/reset 修复的死锁；
- Candidate 跨 repository；
- 测试进程无法安全中止或 worktree 无法清理。

## 18. 产物

### 17.1 本地临时产物

每次运行生成：

```text
.tmp/pi-convention-sense/evaluations/<run-id>/
  manifest.json
  snail-job/backend/
  snail-job/admin/
  snail-ai/backend/
  snail-ai/admin/
  metrics/
  review-queue/
  cleanup-report.json
```

`manifest.json` 记录插件 commit、Pi/Node/Java/Maven/pnpm 版本、被测 commit、配置 fingerprint、场景清单和结果，不记录敏感正文。

### 17.2 永久文档

执行后新增，不覆盖历史报告：

- `docs/evaluations/snail-job-pi-0.87.1-results.md`；
- `docs/evaluations/snail-ai-pi-0.87.1-results.md`；
- `docs/evaluations/release-readiness-results.md`。

必要时同步：

- `docs/compatibility.md`；
- `CHANGELOG.md`；
- `docs/knowledge-base.md`；
- Adapter/Pack 贡献说明。

不得把本地原始 NDJSON、terminal buffer、candidate Profile 或 worktree 文件提交。

## 19. 新会话启动清单

新会话按以下顺序开始：

1. 阅读 `AGENTS.md`、`docs/knowledge-base.md` 和本计划；
2. 检查 `git status --short`，确认只有预期的 `.mcp.json` 或用户已决定其归属；
3. 连接 `tabby-mcp`；
4. `get_session_list`，避开所有 SSH/生产会话；
5. 选择或新建 local Git Bash；
6. 验证项目 cwd、Pi 0.87.1、Node 和退出码；
7. 为本轮创建唯一 `<run-id>` 和临时产物目录；
8. 记录插件与四个被测仓库 baseline；
9. 运行插件 `npm run verify` 与 package dry-run；
10. 从 SnailJob 后端阶段 1 开始，不提前触碰 SnailAI；
11. 每完成一个阶段立即写机器结果和简短 checkpoint；
12. SnailJob 所有 P0 通过后，明确记录 gate 结论，再进入 SnailAI。

执行期间若需要用户介入，只限于：

- 私有依赖或凭据；
- 无法自动判定的业务语义；
- 是否接受环境 blocker；
- 是否把测试发现提升为正式 Profile/Pack；
- 发布、tag、push 等不可逆操作。
