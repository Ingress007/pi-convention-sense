# 阶段 2：V1 Guard 决策与验证记录

> 状态：实验实现、SnailJob/SnailAI 主流程验证完成；生产准入仍待补充任务矩阵
> 默认运行模式：`observe`
> Guard 发布状态：实验性、必须显式启用

## 1. 启动边界

阶段 2 可以实现和进行合成验证，但在真实企业 Java 项目完成 20～30 个任务评估之前：

- 不把 `guard` 设为默认模式；
- 不声明 Guard 已达到生产发布门槛；
- 不根据 Fixture 结果虚构 Top-K、Observation 或误拦截指标；
- 真实项目到位后继续使用同一日志 schema 做准入评估。

## 2. Guard 判定决策

Guard 只约束“Discovery 流程是否完成”，不判断代码是否采用某种风格。

### 2.1 现有 Java 文件

放行条件：

1. 目标文件有当前 Branch 的成功 read；
2. Scope 可可靠识别；
3. Snapshot fresh；
4. Discovery 已完成；
5. valid Snapshot 已在最近 Context 中实际注入。

阻断场景：

- `TARGET_NOT_READ`；
- `SNAPSHOT_MISSING`；
- `SNAPSHOT_STALE` 且无法重建；
- `SNAPSHOT_NOT_INJECTED`。

### 2.2 weak、mixed 与无 peer

- Mixed/Low 只表达证据不确定，不作为风格硬阻断条件；
- 已完成全仓候选发现但 peer 少于阈值时，使用 `INSUFFICIENT_PEERS_AVAILABLE` 放行；
- 完全没有 peer 时使用 `NO_PEERS_AVAILABLE` 放行；
- 有足够 peer 但没有主导 Evidence 时，使用 `SNAPSHOT_WEAK_DISCOVERY_COMPLETE` 放行；
- 上述场景保留日志，避免无法通过补读解决的永久阻塞。

### 2.3 新文件

- write 前根据目标路径、文件名、构建边界和 package 路径创建 prospective Snapshot；
- 有 valid peer Evidence 但尚未注入时，首次 write 可阻断，下一轮 Context 注入后重试；
- 无 peer 或 peer 不足时 fail-open，不永久阻塞；
- 成功创建文件后 prospective Snapshot 立即失效，后续按真实文件重建。

### 2.4 fail-open

以下情况放行并记录原因：

- Extension 禁用；
- 非 Java 或语言未启用；
- 配置 exclude 或 Guard path exception；
- Scope 无法可靠识别；
- 分析器异常；
- 无法确认仓库有足够同类实现。

## 3. Context 有效窗口

只有实际进入 Token 预算的 Snapshot 才记为已注入。默认同时满足：

- Snapshot `createdAt` 与注入记录一致；
- 距离注入不超过 2 个 turn；
- 距离注入不超过 10 分钟。

Session resume、Session switch 和 `/tree` 后清空注入记录；下一轮 Context 可重新建立。

## 4. Bypass 与项目级例外

### 4.1 单次 bypass

```text
/convention-bypass <path>
```

- 只对标准化后的精确目标路径生效一次；
- 只在原本会 block 时消费；
- 不跨 Session/Branch 持久化；
- 每次授予和消费都写审计日志；
- `guard.allowBypass=false` 时命令拒绝授予。

### 4.2 项目级例外

`guard.pathExceptions` 使用相对于项目根的 minimatch glob。例外只绕过 Convention Guard，不改变分析排除项，也不承载编码规则。

## 5. 第三方工具映射

采用显式、受信项目配置：

```json
{
  "toolMappings": [
    { "toolName": "custom_read", "operation": "read", "pathField": "file.path" },
    { "toolName": "custom_patch", "operation": "edit", "pathField": "path" }
  ]
}
```

- operation 仅允许 `read/edit/write`；
- `pathField` 为安全点路径，不执行表达式；
- 内置工具映射不可覆盖；
- 未映射第三方工具不宣称具有强语义；
- pi-lens 工具默认不映射为修改工具，避免重复阻断。

## 6. Shell 后置检测

不使用常驻文件 watcher。对检测到 mutation risk 的 bash/powershell：

1. 工具执行前捕获 Git HEAD、porcelain 状态和既有 dirty/untracked 文件 fingerprint；
2. 工具成功后再次捕获；
3. 比较状态、内容 fingerprint 和 HEAD diff，识别任务新增变更；
4. 对 Java production path 进行 Evidence coverage 审计；
5. 使相关 Snapshot stale；
6. 在下一轮 Context 注入缺口，并在 `agent_settled` 输出摘要。

限制：非 Git 仓库、ignored 文件、外部目录和无法解析的工具保持 fail-open，只记录不可用原因。

## 7. 验证状态

> 未勾选项均为本轮明确未完成的准入或交互验证，不是遗漏：Guard 继续保持 `experimental opt-in`，不默认阻断。

- [x] formal Guard reason code 单元测试；
- [x] valid/weak/no-peer/new-file/prospective 测试；
- [x] bypass 单次消费和 path exception；
- [x] pending sibling read 不放行；
- [x] Branch 切换清除注入与 bypass；
- [x] 第三方 read/edit 映射；
- [x] dirty working tree 的 Git 后置检测；
- [x] 真实 Pi 中 block → read → Context → retry allow；
- [x] 真实 Pi 中 prospective write block → Context → retry allow；
- [x] 真实 Pi 中 Shell 后置缺口注入；
- [x] bypass Extension 集成测试；
- [ ] 真实 Pi TUI 手动 `/convention-bypass` 交互验证；
- [ ] HEAD 变化的真实 Pi Shell 验证；
- [ ] 企业项目 20～30 个 Observe/Shadow Guard 任务；
- [ ] pi-lens 同时安装后的真实任务联调。

## 8. 实施产物

新增：

- `src/guard/convention-guard.ts`：正式 Guard 决策、reason code 和补救信息；
- `src/guard/runtime.ts`：最近 Context 与单次 bypass；
- `src/guard/tool-mapping.ts`：内置/第三方工具语义映射；
- `src/guard/git-auditor.ts`：dirty-safe Git baseline 和后置 diff；
- `src/guard/post-change-audit.ts`：Shell Evidence 缺口和 Context 消息；
- `test/guard.test.ts`：Guard 单元测试；
- `examples/config/java-guard.json`：实验 Guard 配置。

增强：

- prospective Java Snapshot；
- Snapshot schema 增加 `targetKind`；
- Analyzer 版本升级为 `java-lexical-v2-guard`；
- checkpoint 升级到 v3，并兼容 v1/v2；
- Mutation/Read Ledger 支持显式第三方工具映射；
- `/convention-bypass` 和 `/convention-audit`；
- Context 只把实际进入 Token 预算的 Snapshot 计为已注入；
- 状态增加 bypass、post-change audit/gap 指标。

## 9. 自动验证结果

| 验证 | 结果 |
| --- | --- |
| `npm run verify` / TypeScript check | 通过 |
| 自动测试 | 34/34 通过 |
| `npm pack --dry-run` | 通过，34 个发布文件，无 test/dist/log 泄漏 |
| Pi 显式 Extension / 项目级安装无模型加载 | 通过 |
| Guard valid/weak/no-peer/low-scope/fail-open | 通过 |
| prospective Snapshot | 通过 |
| 单次 bypass 与 Branch 清理 | 通过 |
| 第三方工具映射与日志隐私 | 通过 |
| dirty working tree Shell 检测 | 通过 |
| v1/v2 checkpoint 迁移 | 通过 |

## 10. 真实 Pi 合成验证

### 10.1 现有文件 Guard

在 Maven fixture 中按“先 edit、再 read、再 edit”的顺序执行：

```text
TARGET_NOT_READ -> block
Snapshot: java:order:service-impl, valid, candidateCount=3
SNAPSHOT_VALID -> allow
```

本次 Snapshot 分析约 50 ms、约 306 tokens，第二次 edit 实际成功。

### 10.2 prospective 新文件

对尚不存在的 `ShippingServiceImpl.java` 执行 write：

```text
SNAPSHOT_NOT_INJECTED -> block
prospective Snapshot -> Context
SNAPSHOT_VALID -> allow
```

第二次 write 实际创建文件，确认不会要求读取不存在的目标。

### 10.3 dirty working tree Shell 审计

在目标 Java 文件执行前已经 dirty 的情况下，通过 bash 再次修改：

```text
changedFileCount=1
evidenceGapCount=1
headChanged=false
truncated=false
```

下一轮 Context 收到 `convention-post-change-audit`，证明 baseline 不仅比较 dirty path 集合，也比较文件 fingerprint。

## 11. 当前完成度

阶段 2 的**实验实现**以及 SnailJob/SnailAI 的真实主流程验证已经完成，可继续保持 Observe 或在 Fixture/专用 Branch 显式启用 Guard。阶段 2 的**生产准入**尚未完成：真实 TUI 手动命令、HEAD 变化 Shell 场景、20～30 个 Observe/Shadow Guard 任务和 pi-lens 同时安装联调仍是待办门槛。这些未完成项不是本轮产品失败；它们决定 Guard 是否可以扩大启用范围。

企业项目到位后优先执行：

1. Observe/Shadow Guard 跑 20～30 个真实任务；
2. 人工标注 Top-K 候选与高置信 Observation；
3. 统计 `wouldBlock` 中真实误拦截；
4. 验证多模块、遗留 mixed style、generated、dirty tree 和 pi-lens 组合；
5. 达到 80% / 90% / 10% 门槛后再讨论 Guard 默认策略。
