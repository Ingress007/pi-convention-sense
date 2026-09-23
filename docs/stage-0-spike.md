# 阶段 0：技术 Spike 计划与决策记录

> 状态：已完成
> 目标 Pi 版本：`@earendil-works/pi-coding-agent@0.85.1`
> 目标 Node.js：`>=22.19.0`
> 对应需求：[requirements.md](./requirements.md)
> 对应设计：[design.md](./design.md)

## 1. Spike 目标

阶段 0 不实现 Java Scope、候选排序或 Evidence 推断，而是用一个最小 Extension 验证后续方案依赖的运行时事实：

1. 生命周期事件和 payload 是否与设计一致；
2. 成功读取是否能在 `tool_result` 阶段可靠确认；
3. `context` 是否能在每次模型调用前注入非持久的动态信息；
4. `tool_call` 是否能模拟或实际阻止 edit/write；
5. 并行 Tool Call 中，同批尚未完成的 read 是否不会被误算为证据；
6. Session 替换和 `/tree` 分支切换时，状态是否能正确重建；
7. `agent_settled` 是否适合作为后置审计时机。

## 2. 官方接口核对结果

当前环境：

- Pi CLI：`0.85.1`；
- Node.js：`22.22.2`；
- npm：`10.9.7`。

已核对官方文档、类型定义和示例，确认以下接口在目标版本存在：

- 生命周期：`session_start`、`session_shutdown`、`session_tree`、`before_agent_start`、`context`、`agent_start`、`agent_end`、`agent_settled`、`turn_start`、`turn_end`；
- 工具：`tool_execution_start`、`tool_call`、`tool_result`、`tool_execution_end`；
- 状态：`ctx.sessionManager.getBranch()`、`getSessionId()`、`getSessionFile()`、`getLeafId()`、`pi.appendEntry()`；
- 阻断：`tool_call` 返回 `{ block: true, reason }`；
- 动态上下文：`context` 返回替换后的 `messages`；
- 稳定指令：`before_agent_start` 返回追加后的 `systemPrompt`；
- 诊断：`registerCommand()`、`ctx.ui.notify()`、`ctx.ui.setStatus()`。

关键时序事实：

- 默认并行工具模式下，同一 Assistant Message 的 sibling tool calls 先顺序 preflight，再并行执行；
- `tool_call` 不保证看到同批 sibling 的 `tool_result`；
- `tool_result` 和 `tool_execution_end` 可能按完成顺序交错；
- 最终 toolResult 消息仍按 Assistant 中的源顺序写入；
- `agent_settled` 只在自动重试、压缩重试和队列消息全部结束后触发；
- `/new`、`/resume`、`/fork`、`/clone` 会销毁旧 Extension runtime，并为新 Session 重新绑定实例；
- `/tree` 不替换 Session，应监听 `session_tree` 并按当前 active branch 重建状态。

## 3. 阶段 0 已作出的决策

### D-01 版本基线

- **决策**：Spike 针对 Pi `0.85.1` 开发和验证；包声明 Node.js `>=22.19.0`，Pi peer 版本锁定在 `>=0.85.1 <0.86.0`。
- **原因**：当前环境和官方类型均为 0.85.1；生命周期语义属于强兼容边界，不在未验证情况下宣称跨次版本兼容。
- **后续**：进入 V1 前建立至少一个额外 Pi 版本的兼容测试。

### D-02 工具名与 payload

- **决策**：V1 基线直接使用内置工具名：
  - 读取：`read`；
  - 受控修改：`edit`、`write`；
  - 可能绕过受控修改：`bash`、Windows 下的 `powershell`。
- **已确认 payload**：
  - read：`{ path, offset?, limit? }`；
  - edit：`{ path, edits: [{ oldText, newText }] }`；
  - write：`{ path, content }`；
  - bash/powershell：`{ command, timeout? }`。
- **原因**：这些名称和结构由 0.85.1 的导出类型明确定义。
- **后续**：第三方修改工具不会在阶段 0 自动识别，V1 再增加可配置工具映射。

### D-03 成功读取的唯一入账点

- **决策**：只在 `tool_result` 且 `isError === false` 时将 read 写入 Read Ledger。
- **原因**：`tool_call` 只表示模型计划调用；工具可能被其他 Extension 阻止、失败或取消。
- **并行语义**：`tool_execution_start` 只进入 pending 集合，不能满足 Guard。

### D-04 Guard Spike 行为

- **决策**：默认 `observe`，仅记录 `wouldBlock`；配置为 `guard` 时才实际 block。
- **阶段 0 判据**：
  - 现有文件 edit/write 前必须有该目标文件的成功 read；
  - 新文件在 Spike 中临时 fail-open，并记录 `new-file-bypass`；
  - 阶段 0 不伪装 peer Evidence，不以“读过目标文件”等同于已完成 Convention Discovery。
- **原因**：此判据足以验证 block 和并行时序，但不会冒充阶段 1 的完整证据模型。

### D-05 Context 注入方式

- **决策**：
  - 稳定原则通过 `before_agent_start` 追加固定、短小的 system prompt 段；
  - 动态状态通过 `context` 追加 `role: "custom"`、`display: false` 的临时消息；
  - 动态消息不调用 `sendMessage()`，因此不写入 Session。
- **原因**：稳定原则保持一致，动态状态每轮可更新且不会污染持久对话。

### D-06 Session 与 Branch 状态

- **决策**：
  - Session 替换依赖新 Extension 实例和 `session_start` 重建；
  - `/tree` 后监听 `session_tree`，从 `ctx.sessionManager.getBranch()` 重建；
  - 状态 checkpoint 使用 `pi.appendEntry("pi-convention-sense-spike-state", data)`，不进入 LLM Context；
  - 不使用 `getLeafId()` 作为稳定 Branch ID，因为 leaf 会随每条新 entry 变化。
- **原因**：Pi 没有独立、稳定的 branch UUID；正确隔离方式是以 Session tree 的 active path 为状态来源。

### D-07 不修改内置工具结果结构

- **决策**：不把状态塞入内置 read/edit/write 的 `details`。
- **原因**：官方要求覆盖或修改内置工具时保持精确 result shape；直接改写 details 可能破坏渲染和状态逻辑。扩展自身状态使用 custom entry。

### D-08 日志隐私与位置

- **决策**：默认写入 `.pi/convention-sense/spike.ndjson`；只记录事件元数据、路径、计数、判定和 reason code，不记录源码、edit 文本、write 内容、完整 prompt 或完整 shell 命令。
- **原因**：Spike 需要可回放时序，但不应复制源码或敏感命令。
- **实现要求**：日志失败必须 fail-open，不影响 Pi 主流程。

### D-09 项目配置与 Trust

- **决策**：配置路径沿用 `.pi/convention-sense.json`；只有 `ctx.isProjectTrusted()` 为真时才读取项目配置，否则使用安全默认值。
- **原因**：CLI `-e` 扩展可在项目资源信任前加载，不能绕过 Pi 的 Project Trust 边界。

### D-10 后置审计

- **决策**：阶段 0 在 `agent_settled` 只输出/记录账本摘要和 shell 风险信号，不尝试推断实际 Shell 改动文件。
- **原因**：仅从命令文本无法可靠得知文件变化；Git diff/file watcher 的选择保留到阶段 1 入口评估。

## 4. Spike 配置子集

阶段 0 只实现完整配置中的以下字段：

```json
{
  "enabled": true,
  "mode": "observe",
  "injectContext": true,
  "persistSessionState": true,
  "logPath": ".pi/convention-sense/spike.ndjson",
  "logging": {
    "level": "info"
  }
}
```

非法或未知值不会让 Extension 崩溃；实现应回退默认值并记录配置诊断。

## 5. 阶段 0 不做

- Java Scope Detector；
- 候选搜索和 Ranker；
- Convention Observation/Evidence 推断；
- Snapshot freshness/hash；
- Git diff 或 watcher；
- Shell 修改的可靠阻断；
- 长期持久化；
- 深度审计 Skill。

## 6. 验证矩阵

| 验证项 | 自动测试 | 真实 Pi 验证 |
| --- | --- | --- |
| Extension 可加载、事件可注册 | 是 | 是 |
| 成功 read 才入账 | 是 | 是 |
| sibling pending read 不满足 Guard | 是 | 记录实际日志 |
| Observe 返回 `wouldBlock` 但不 block | 是 | 是 |
| Guard 返回 `{ block: true }` | 是 | 可选隔离目录验证 |
| context 动态消息不持久化 | 是 | 检查 Session JSONL |
| `/tree` 后按 active branch 重建 | 是（mock branch） | 交互验证 |
| Session replacement 重建 | 是（mock session） | 交互验证 |
| `agent_settled` 最终触发 | 注册验证 | 真实日志 |
| 日志不包含源码/写入内容 | 是 | 抽查 NDJSON |

## 7. 退出条件

- [x] TypeScript 类型检查通过；
- [x] 自动测试覆盖核心时序和 Guard 判定；
- [x] Extension 能由当前 Pi `0.85.1` 加载；
- [x] 完成无模型的 Extension 加载验证；
- [x] 完成真实 Pi 的 read、并行 read/edit、Guard block、Session resume 和 `agent_settled` 验证；
- [x] 完成真实 TUI `/tree` 分支切换与 active-branch 状态恢复验证；
- [x] 记录验证结果、已决事项和剩余风险。

## 8. 实施产物

- `extensions/index.ts`：最小 Pi Extension，注册生命周期日志、Context 注入、Guard Spike 和 `/convention-status`；
- `src/runtime/config.ts`：受 Project Trust 约束的配置读取和降级；
- `src/runtime/state.ts`：Read/Mutation Ledger、pending read、active-branch checkpoint 恢复；
- `src/runtime/guard.ts`：Observe/Guard 的阶段 0 判定；
- `src/runtime/context.ts`：稳定原则和非持久动态 Context；
- `src/runtime/logger.ts`：fail-open NDJSON 日志；
- `test/`：核心逻辑和 Extension 事件集成测试；
- `examples/legacy/stage-0-spike.json`：阶段 0 配置示例。

## 9. 验证结果

### 9.1 静态和自动测试

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 9/9 通过 |
| `npm run verify` | 通过 |
| `npm pack --dry-run` | 通过；包内 15 个文件，无测试、dist 或日志泄漏 |
| 无模型加载：`pi --no-extensions -e ./extensions/index.ts --list-models` | 通过 |

自动测试已覆盖：

- 未信任项目不读取 `.pi/convention-sense.json`；
- 非法配置回退；
- pending read 不满足 Guard；
- read 失败不入账；
- Observe/Guard/new-file bypass；
- active branch 最新 checkpoint 恢复；
- system prompt 指令幂等；
- Context 明确声明“无真实 Evidence”；
- Extension 必要 Hook 注册；
- Context 不持久化；
- 日志不包含源码、write 内容和完整 shell 命令。

### 9.2 真实 Pi 0.85.1 验证

#### A. Observe read 生命周期

真实运行中观察到：

```text
session_start
before_agent_start
agent_start
turn_start
context
  tool_execution_start(read)
  tool_call(read)
  tool_result(read, isError=false)
  tool_execution_end(read)
turn_end
turn_start
context
turn_end
agent_end
agent_settled
session_shutdown
```

第二次 `context` 前 `successfulReadCount` 已从 0 变为 1；`agent_settled` 中 `isIdle=true`。

#### B. Guard 实际阻断

在隔离目录中启用 `mode: guard`，只开放 edit，要求直接修改未读的现有文件。结果：

- Guard 返回 `action=block`；
- `reasonCode=TARGET_NOT_READ`；
- Agent 收到阻断结果并回复 `BLOCKED_OK`；
- 文件内容保持 `before`，没有发生修改；
- `agent_settled` 正常触发。

#### C. sibling read/edit 并行时序

要求模型在同一首批工具调用中并行发出 read 和 edit。真实日志顺序为：

```text
tool_execution_start:read
tool_execution_start:edit
guard_decision:edit
tool_result:read
```

Guard 判定时：

- `pendingReadCount=1`；
- `successfulReadCount=0`；
- edit 被 block；
- 文件未修改。

由此确认：同批 pending read 不能作为已完成证据。

#### D. Session resume 状态恢复

首次持久 Session 成功 read 后退出，再用 `-c` 恢复同一 Session，并在不重复读取的情况下 edit。结果：

- 第二次 `session_start`：`restoredFromCheckpoint=true`；
- Guard：`action=allow`、`reasonCode=TARGET_ALREADY_READ`；
- 文件从 `before` 成功改为 `after`。

#### E. 动态 Context 不持久化

对真实 Session JSONL 检查：

- `pi-convention-sense-spike-context` 的 `custom_message` 数量为 0；
- 说明 `context` 返回的动态消息只进入当轮模型上下文，没有写入 Session。

### 9.3 `/tree` 真实 TUI 验证

人工交互验证已完成：

1. 首次成功读取 `README.md` 后，Read Ledger 为 1；
2. 随后成功读取 `docs/design.md`，Read Ledger 为 2；
3. 使用 `/tree` 从 leaf `2ea589fe` 回退到第一次读取后的 leaf `22d31f25`；
4. Extension 收到真实 `session_tree` 事件；
5. 日志记录 `restoredFromCheckpoint=true`、`successfulReadCount=1`；
6. `/convention-status` 输出与日志一致。

由此确认：TUI 分支切换后，Extension 会从当前 active branch 的最新 checkpoint 重建状态，不会继续沿用被放弃分支中的第二次读取。

## 10. Spike 后的确认结论

以下待确认项已根据实际接口和运行结果关闭：

- Pi 目标/最小兼容版本：V1 当前基线为 `0.85.1`，未验证前不宣称兼容 0.86；
- 内置工具名称和 payload：采用 0.85.1 导出的 `read/edit/write/bash/powershell` 类型；
- 成功读取入账时机：只使用成功 `tool_result`；
- 并行工具策略：pending read 永不满足 Evidence 前置条件；
- Session 恢复：使用 branch-local custom checkpoint；
- Branch 语义：不虚构稳定 branch UUID，以 active branch path 重建状态；
- Context 注入：使用 `context` 临时 custom message，不持久化；
- Guard 默认策略：Observe + fail-open，Guard 需要显式配置；
- `agent_settled`：适合作为无自动后续动作时的审计时机；
- 诊断入口：V1 保留 `/convention-status` 命令。

## 11. 进入阶段 1 前仍需决策

- Java 模块识别中 Maven/Gradle 构建边界与业务目录的优先级；
- Java 确定性信号采用轻量 AST、现有 parser 还是受限正则；
- 第三方读取/修改工具的可配置映射格式；
- Shell 后置检测采用 Git diff、watcher 或组合方案；
- Observe 真实任务样本量和开启 Guard 的最终阈值；
