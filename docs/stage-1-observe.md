# 阶段 1：V1 Observe 实施与决策记录

> 状态：已完成
> 基线：Pi `0.85.1`、Node.js `>=22.19.0`
> 前置阶段：[stage-0-spike.md](./stage-0-spike.md)
> 历史记录：本文记录当时的决策与验证结果，不随实现更新；当前行为以 [design.md](./design.md)、[knowledge-base.md](./knowledge-base.md) 和代码为准。

## 1. 阶段目标

在已验证的 Pi 生命周期之上实现首个可用的 Observe 链路：

```text
成功读取 Java 目标文件
  -> Scope Detector
  -> Candidate Finder / Ranker
  -> Java deterministic signals
  -> Evidence aggregation
  -> Convention Snapshot
  -> context 临时注入
  -> edit/write wouldBlock 观测
```

本阶段默认不阻断编码流程，不调用第二个 LLM，不修改项目文件或 `AGENTS.md`。

## 2. 根据实际环境作出的决策

### O-01 首版语言和构建系统

- 首版只分析 Java production source；
- 显式支持 Maven `pom.xml`、Gradle `build.gradle` / `build.gradle.kts` 模块边界；
- 测试源码与生产源码不混合计算；
- 非 Java 文件仍进入通用 Read/Mutation Ledger，但不生成 Snapshot。

### O-02 模块识别优先级

按以下顺序识别：

1. 目标文件向上最近的 Maven/Gradle 构建文件；
2. 若最近构建边界就是仓库根，则取 Java package 中角色目录前一段作为业务模块；
3. 若 package 也无法推断，则退化为 source root 或父目录，并降低置信度。

原因：企业仓库既可能是多构建模块，也可能是单体构建下的多业务 package，只使用其中一种信号都会系统性误判。

### O-03 Java 解析策略

V1 选择 **无外部 parser 的词法清洗 + 有边界的结构规则**，而不是完整 Java AST，也不是直接在原始源码上堆正则。

实现要求：

- 先移除注释和字符串内容，避免注释示例和日志文本污染；
- 只提取可明确验证的 imports、annotations、extends/implements、字段、构造器、throw、日志和常见调用；
- 不推断业务语义、领域建模或方法拆分质量；
- 每条信号必须带 category/pattern，允许反例并计算支持率。

原因：当前首批信号不需要完整 AST；引入 Java CST/AST 会显著扩大依赖、遍历和错误恢复成本。若 fixture 显示词法方案准确率不足，再升级 parser，而不是提前承担复杂度。

### O-04 排除路径

使用 `minimatch` 实现配置中的 glob 排除，而不自制不完整 glob 语义。该依赖必须声明为直接 runtime dependency，不能依赖 Pi 的传递依赖。

默认排除：

- `**/generated/**`
- `**/build/**`
- `**/target/**`
- `**/vendor/**`
- `**/node_modules/**`

### O-05 候选发现与排序

采用两阶段排序：

1. 文件名、Role、目录、模块、production/test 等低成本信号做初筛；
2. 只对初筛 Top 20 读取源码，计算 annotation、继承关系、import Jaccard 和文件大小相似度。

默认最终选择 2～4 个 peer。目标文件永不作为 peer。

原因：直接解析仓库内所有 Java 文件违背“不得每轮全仓分析”的性能目标。

### O-06 Evidence 样本口径

- Evidence 只由最终 peer 样本构建，不把目标文件计入支持数；
- 同一 category 中，没有出现该类信号的文件不作为该 category 的反例；
- `samples` 是该 category 可观察的文件数；
- `counterEvidence` 是同 category 中支持其他 pattern 的文件；
- 单文件 Observation 只能是 Low；
- 主导比例不足或多个 pattern 接近时标记 Mixed。

### O-07 Snapshot 与 Branch

- Snapshot 只保存在 Extension 内存；
- Read/Mutation Ledger 继续使用 branch-local custom checkpoint；
- checkpoint 升级为带 `recentReads` 的 v2，同时兼容恢复阶段 0 的 v1；
- Session resume 或 `/tree` 后，根据 active branch 的最近 Java reads 重建 Snapshot；
- 不持久化长期惯例。

### O-08 Freshness

EvidenceRef 保存：

- path；
- mtimeMs；
- size；
- SHA-256 content hash；
- candidate score。

每次 Context 注入前检查目标和 Evidence 文件 freshness。变化后 Snapshot 标记 stale，并按需重建。

### O-09 Context 预算

- 默认 `maxContextTokens=1200`；
- 使用保守的 `ceil(chars / 4)` 估算；
- 先保留 High/Medium，再保留 Mixed 摘要，最后才考虑 Low；
- 超预算时减少 Observation 和候选路径，不截断结构标签或关键指令。

### O-10 Guard 边界

- 阶段 1 默认且推荐 `mode=observe`；
- edit/write 缺少有效 Snapshot 时只记录 `wouldBlock`；
- 阶段 0 的显式 `mode=guard` 只保留为隔离验证能力，不升级为正式 V1 Guard；
- 正式 Snapshot Guard、bypass 和无 peer 策略属于阶段 2。

### O-11 Shell 后置检测

阶段 1 继续记录 shell mutation-risk，不引入常驻 file watcher。

对后续实现的决策倾向：

- 优先 Git diff 快照，而不是 watcher；
- 原因是 watcher 需要生命周期资源管理、容易记录 Extension/构建工具噪声，且无法天然给出任务前基线；
- 正式实现前需设计 dirty working tree 的基线算法，不能简单把所有 `git diff --name-only` 都归因于当前 Agent。

### O-12 第三方工具映射

阶段 1 只对已验证的内置工具提供强语义。第三方工具映射推迟到 Scope/Evidence 链路稳定后，避免在没有统一 payload 契约时误计读取或修改。

## 3. V1 Observe 配置

```json
{
  "enabled": true,
  "mode": "observe",
  "minEvidenceFiles": 2,
  "maxEvidenceFiles": 4,
  "maxContextTokens": 1200,
  "scopeStrategy": "module-role",
  "includeLanguages": ["java"],
  "exclude": [
    "**/generated/**",
    "**/build/**",
    "**/target/**",
    "**/vendor/**",
    "**/node_modules/**"
  ],
  "injectContext": true,
  "persistSessionState": true,
  "logPath": ".pi/convention-sense/observe.ndjson",
  "logging": {
    "level": "info",
    "explainRanking": true
  }
}
```

## 4. 退出条件

- [x] Java Scope fixture 覆盖 Maven、Gradle、单体 package fallback；
- [x] 候选排序不包含目标文件，默认选择不超过 4 个；
- [x] 一致、混合和低样本 Evidence 测试通过；
- [x] Snapshot freshness、mutation invalidation 和 Branch rebuild 测试通过；
- [x] Context 注入包含真实路径、支持数和置信度，并遵守预算；
- [x] Observe 缺 Snapshot 时不阻断；
- [x] 真实 Pi 中完成 Java Snapshot 生成和下一轮 Context 注入验证；
- [x] 文档记录实测结果和阶段 2 剩余事项。

## 5. 实施产物

### 5.1 分析链路

- `src/observe/java-analyzer.ts`：注释/字符串安全的 Java 词法分析和确定性信号；
- `src/observe/scope-detector.ts`：Maven/Gradle/package fallback Scope；
- `src/observe/repository-index.ts`：带 glob exclude 的 Java 文件索引；
- `src/observe/candidate-ranker.ts`：两阶段候选发现和可解释评分；
- `src/observe/evidence-builder.ts`：support/samples/counterEvidence/confidence/Mixed 聚合；
- `src/observe/analyzer.ts`：目标分析编排；
- `src/observe/snapshot-cache.ts`：mtime、size、SHA-256 freshness 和路径失效；
- `src/observe/snapshot-formatter.ts`：Token 预算和 Evidence Context；
- `src/observe/observe-decision.ts`：Observe `allow/wouldBlock` 判定。

### 5.2 Pi 生命周期集成

- 成功 Java read 后同步生成 Snapshot；
- `context` 前校验 freshness，并重建最近 active-branch Snapshot；
- edit/write 前记录 `SNAPSHOT_VALID`、`SNAPSHOT_WEAK` 或 `SNAPSHOT_MISSING_OR_STALE`；
- Observe 模式永不返回 block；
- 成功 edit/write 后使相关目标和 Evidence Snapshot stale；
- Session resume 和 `/tree` 后由 v2 `recentReads` checkpoint 重建；
- 兼容读取阶段 0 的 v1 checkpoint；
- 新增 `/convention-snapshot` 诊断命令；
- 状态栏显示 read、valid/weak Snapshot 和 pending read 数量。

### 5.3 Fixture

- Maven 多模块 + 一致/混合 ServiceImpl；
- Gradle 子模块 + 低样本 Controller；
- 单体 Maven + package 业务模块 fallback；
- test/generated 排除样本；
- 注释和字符串假信号样本。

## 6. 自动验证结果

| 验证 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 20/20 通过 |
| `npm run verify` | 通过 |
| `npm pack --dry-run` | 通过 |
| Pi 无模型 Extension 加载 | 通过 |

关键自动验证：

- Maven 子模块识别为 `java:order:service-impl`，Scope High；
- Gradle 子模块识别为 `inventory`，单 peer Snapshot 为 weak；
- 单体 Maven 从 `com.acme.billing.service.impl` 推断模块 `billing`；
- 目标文件、test source、generated/target 文件不进入生产 peer；
- 3 个 peer 中 2 个构造注入、1 个字段注入，输出 `constructor 2/3` 及 1 个 counterEvidence；
- SLF4J `3/3` 输出 High；
- 注释中的 `@Autowired` 和字符串中的 `throw new` 不产生假信号；
- Evidence 修改使 Snapshot stale；
- edit/write 路径失效生效；
- 220-token 单 Snapshot 预算下输出保持结构完整，多 Snapshot 总 Context 不超过配置预算；
- `/tree` mock branch 回退后只重建目标分支的最近 Snapshot；
- v1 checkpoint 可迁移到 v2 `recentReads`。

## 7. 真实 Pi 验证

### 7.1 Snapshot 生成与 Context 注入

在 Maven fixture 中要求 Agent 只读取 `OrderServiceImpl.java`。真实日志结果：

```text
scope=java:order:service-impl
status=valid
candidateCount=3
consideredCandidateCount=3
durationMs=46
tokenEstimate=306
```

下一轮 `context` 日志包含：

```text
scopes=["java:order:service-impl"]
```

模型实际读取到注入证据并总结出：

- mapper 依赖/辅助方法；
- SLF4J 与参数化日志；
- `@Service`；
- 构造注入；
- `BizException + ErrorCode`；
- direct null check；
- method-level transaction；
- 存在反例，证据不是绝对规则。

`agent_settled` 记录 `validSnapshotCount=1`、`staleSnapshotCount=0`。

### 7.2 Observe 不阻断

在没有 read 和 Snapshot 的情况下直接 edit 一个现有 Java 文件：

```text
action=wouldBlock
reasonCode=SNAPSHOT_MISSING_OR_STALE
```

edit 仍实际执行，文件从 `"before"` 改为 `"after"`。这确认 V1 Observe 只采集潜在阻断指标，不影响主流程。

## 8. 经实现验证后的最终决策

- Maven/Gradle 最近构建边界优先，仓库根构建下使用业务 package fallback；
- V1 使用词法清洗 + 有边界结构规则，不引入完整 Java parser；
- 直接依赖 `minimatch`，不依赖 Pi 传递依赖；
- 候选采用低成本初筛 + Top 20 深分析；
- Evidence 的 samples 按 category 可观察文件计算；
- Snapshot 内存保存，Ledger 以 branch-local v2 checkpoint 持久化；
- freshness 同时校验 mtime、size 和 SHA-256；
- Context 使用字符/4 的保守 Token 估算和结构化裁剪；
- Stage 1 只支持内置工具强语义；
- Shell 后置检测倾向 Git diff 基线，不采用常驻 watcher。

## 9. 阶段 2 入口事项

- 用 20～30 个真实企业任务评估 Top-K 认可率和 Observation 准确率；
- 定义正式 Snapshot Guard 条件和 reason code；
- 设计单次 bypass 和项目级例外；
- 处理新文件、无 peer、weak/mixed Snapshot，避免永久阻塞；
- 设计 dirty working tree 下的 Git diff 基线；
- 增加第三方读取/修改工具映射；
- 根据真实误判样本决定是否升级 Java parser；
- 与 pi-lens 做死循环和重复拦截联调。
