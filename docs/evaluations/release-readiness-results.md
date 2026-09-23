# Pi Convention Sense 发布就绪评估结果

> 评估运行编号：`20260923T082341Z-snailjob`  
> Pi 生命周期基线：`0.87.1`  
> 结论：**具备发布就绪条件，但有一项已记录的环境限制**

## 结果矩阵

| 门禁 | SnailJob 后端 | SnailJob Admin | SnailAI 后端 | SnailAI Admin |
| --- | --- | --- | --- | --- |
| 静态 Candidate 隔离 | 通过 | 通过 | 通过 | 通过 |
| Observe fail-open 生命周期 | 通过 | 通过 | 通过 | 通过 |
| Profile、Pack 与 Capsule | 通过 | 通过 | 通过 | 通过 |
| Guard 未读目标哈希安全 | 通过 | 通过 | 无回归，tracked 文件未变化 | 通过 |
| 有效 Snapshot 后恢复放行 | 通过 | 通过 | 由共享后端路径覆盖 | 通过 |
| Session、Branch、bypass 与 reset | 通过 | 通过 | 共享运行时回归通过 | 共享运行时回归通过 |
| 跨仓库信任边界 | 通过 | 通过 | 通过 | 通过 |
| 隐私 | 通过 | 通过 | 通过 | 通过 |
| 项目原生检查 | 通过 | 通过 | 通过 | 环境阻塞 |
| 最终仓库卫生 | 仅保留业务 diff | 仅保留业务 diff | clean | clean |

## P0 门禁

- 跨仓库 Candidate：**0**。
- test、generated、vendor、build output 进入生产 Evidence：**0**。
- Observe 阻断：**0**。
- Guard 永久死锁：**0**。
- Guard 因纯风格差异阻断：**0**。
- 未读目标被阻断后仍发生文件变化：**0**。
- weak、no-peer、unsupported、error 未正确 fail-open：**0**。
- Profile 信任跨仓库泄漏：**0**。
- Session、Branch、bypass 状态泄漏：**0**。
- 日志敏感内容发现数：**0**。
- Pi 生命周期未捕获异常：**0**。
- 遗留 disposable worktree：**0**。

## P1 指标

所有已测冷分析和热分析耗时均低于计划门槛：冷分析 P95 ≤ 5 秒，热分析 P95 ≤ 1 秒。Snapshot token 估算始终低于默认 1200 token 预算。同角色选择率为 100%，同 leaf module/workspace 优先率不低于 96.2%。弱证据和 mixed Observation 均保留为不确定性，没有被提升为 hard rule。

## 限制与分类

SnailAI Admin 缺少 `node_modules`，因此无法启动原生 typecheck、lint、format 和 build 命令。该问题分类为 `ENVIRONMENT_BLOCKED`，而非 `PRODUCT_DEFECT`：仓库最终保持 clean，静态分析以及真实 Pi Observe、Profile、Guard 生命周期均已通过。测试计划仅允许在 disposable worktree 中安装依赖，而执行约束将 worktree 限定于插件启用/禁用对比，因此本轮没有尝试安装。

## 业务修改处置

验收通过的 SnailJob Job Tag v2 修改将**保留并保持未提交**，供人工审查。它已经通过后端编译、Admin typecheck/build、六种 SQL 方言审查、namespace 安全审查和第二轮规范符合度审查。所有测试专用 Profile、Pi 配置与日志、生成的路由产物和项目临时文件均已删除；永久评估结论和本地证据副本予以保留。
