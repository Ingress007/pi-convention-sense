# SnailAI Pi 0.87.1 验收结果

> 运行编号：`20260923T082341Z-snailjob`  
> 后端 HEAD：`10c1d3e50b701be62da23a3403d79a41187ab8cd`  
> Admin HEAD：`3b2db48d7849554631f7b6f726c41b99af7c3462`  
> 结果：**通过，但存在环境阻塞项**

## 静态泛化结果

| 指标 | 后端 | Admin |
| --- | ---: | ---: |
| 目标数 | 20 | 21 |
| 有效 / 弱证据 / 失败 | 17 / 3 / 0 | 19 / 2 / 0 |
| Candidate 数量 | 80 | 76 |
| 跨仓库违规 | 0 | 0 |
| 同角色率 / 角色违规 | 100% | 0 个违规 |
| 同模块率 | 96.25% | 100% |
| Workspace 违规 | 不适用 | 0 |
| 排除项进入 Candidate 的违规 | 0 | 0 |
| 首次冷分析耗时 | 687 ms | 285 ms |
| 分析耗时 P95 | 62 ms | 144 ms |
| Snapshot token P95 / 最大值 | 345 | 232 |

后端 3 个弱证据 Mapper 样本和 Admin 2 个弱证据样本都缺少足够的重复证据，因此正确保持 fail-open。一个 agent-chat starter Controller 优先选择了唯一的本模块 peer，并仅在本模块候选耗尽后扩展到跨模块候选；该结果保留供人工审查，没有提升为长期规则。

## 真实生命周期、Profile 与 Guard

- 两个仓库在无 Profile 的 fresh Observe 中均成功创建有效 Snapshot。
- 测试专用 draft Profile 均遵循 candidate-first 流程生成，校验无 diagnostics，并完成指纹和语义差异检查：
  - 后端：`d9198570244eec90`；
  - Admin：`6814ee8010c6a01d`。
- Draft Profile 中的 hard knowledge 在运行时保持 advisory。
- Admin 加载 Profile 后识别出 `vue-route-page`，并注入一个有界 Capsule 和一个有效 Snapshot。
- 后端加载 Profile 后正确区分 MVC Controller；缺少等价 peers 时保持弱证据状态。
- Admin 未读取目标即修改时被 `TARGET_NOT_READ` 阻断，文件哈希保持不变。
- 执行 read → valid Snapshot → Context → edit 后，以 `SNAPSHOT_VALID` 放行；测试注释随后被恢复，文件回到原始哈希。
- 从 SnailAI Admin Session 读取 SnailJob Admin 绝对路径时，Candidate 仅来自 SnailJob，且没有应用启动仓库的 Profile。
- 生命周期日志覆盖启动、turn、Context、工具完成、settled 和 shutdown，未出现未捕获异常。
- 元数据日志隐私扫描中，源码正文、完整 prompt、edit/write 正文和完整命令字段均为 0。

更完整的 bypass、reset、Branch 和 Shell 矩阵已在 SnailJob 上通过；SnailAI 项目特有的 Guard 与仓库边界路径未发现回归。

## 项目原生检查

- 后端使用 JDK `21.0.8` 和 Maven `3.9.11`，对 `snail-ai-server-admin` 执行 reactor compile：**构建成功**，耗时 3 分 07 秒。
- Admin 原生检查：**环境阻塞（`ENVIRONMENT_BLOCKED`）**。仓库缺少 `node_modules`，因此无法调用 `vue-tsc`。测试计划只允许在 disposable worktree 中安装依赖，而本轮执行约束仅允许为插件启用/禁用对比创建 worktree。因此没有执行安装，也没有修改 lockfile 或任何 tracked 文件。

## 清理结果

两个 SnailAI 仓库均已恢复到各自基线 HEAD，`git status` 为空。测试专用 `.pi` 和 `.convention-sense` 目录已删除，未创建任何 commit。
