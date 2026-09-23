# 兼容性与验证矩阵

本文区分“声明支持”“CI 自动验证”“真实项目验证”和“尚未验证”，避免把单一环境测试误写成普遍兼容。

## 1. 运行时基线

| 组件 | 当前范围 | 状态 |
|---|---|---|
| Node.js | `>=22.19.0` | 支持 |
| Pi | `>=0.85.1 <0.86.0` | `0.85.1` 已验证 |
| TypeScript | `5.9.x` | 开发与 CI |
| Git | 可选 | Shell 后置审计需要 |

Pi `0.86.x` 尚未验证。更新 peer dependency 范围前，必须重新验证 Extension API、事件顺序、Context、Session checkpoint、命令和工具映射。

## 2. CI 矩阵

GitHub Actions：`.github/workflows/ci.yml`

| 操作系统 | Node 22.19.0 | Node 22.x | 验证内容 |
|---|---:|---:|---|
| Ubuntu latest | CI | CI | TypeScript、56 个自动测试 |
| Windows latest | CI | CI | TypeScript、56 个自动测试 |

独立 package job 运行：

```text
npm pack --dry-run
```

CI 使用 `npm ci`，不修改 lockfile。

## 3. Pi 行为验证

| 行为 | 自动测试 | 真实 Pi |
|---|---:|---:|
| Extension 加载与 lifecycle hooks | 是 | 是 |
| read ledger 只接受成功 tool result | 是 | 是 |
| Snapshot 创建与 Context 注入 | 是 | 是 |
| Branch checkpoint 恢复 | 是 | 是 |
| Guard block → read → Context → allow | 是 | 是 |
| 一次性 bypass | 是 | 部分人工验证 |
| Shell Git 后置审计 | 是 | 是 |
| Project Profile / Knowledge Capsule | 是 | 是 |
| `/convention-reset confirm` | 是 | 待重启当前开发实例后人工复验 |

真实 Pi 基线版本为 `0.85.1`。

## 4. 语言与项目结构

| 能力 | Fixture | 真实项目 | 状态 |
|---|---:|---:|---|
| Java + Maven multi-module | 是 | SnailJob 后端 | 已验证 |
| Java + Gradle multi-module | 是 | 否 | Fixture 验证 |
| Java 单体项目 | 是 | 否 | Fixture 验证 |
| TypeScript + Vue SFC | 是 | snail-job-admin | 已验证 |
| pnpm workspace | 是 | snail-job-admin | 已验证 |
| package workspace 隔离 | 是 | snail-job-admin | 已验证 |

## 5. 操作系统

| 系统 | 自动测试 | 真实交互式 Pi | 状态 |
|---|---:|---:|---|
| Windows | CI | 是 | 主要开发环境 |
| Linux | CI | 否 | 自动测试覆盖 |
| macOS | 否 | 否 | 尚未验证 |

没有真实验证的环境不得仅根据相似性声明为已支持。

## 6. Project Profile 与仓库边界

| 场景 | Profile 行为 | Candidate 行为 |
|---|---|---|
| 从目标仓库根目录启动且受信 | loaded | 仅当前 repository |
| Profile missing | missing，fail-open | Local Evidence |
| Profile invalid | invalid，fail-open | Local Evidence |
| Profile 存在但项目未信任 | ignored | Local Evidence |
| 从仓库 A 读取仓库 B | B 的 Profile ignored | 仅 B repository，不回退到 A |

外部仓库策略有 Extension 集成测试覆盖。若要加载 B 的 Profile，必须从 B 根目录显式批准并启动新的 Pi。

## 7. Pack 与 Adapter

| 项目 | 当前状态 |
|---|---|
| `java-spring@1.0.0` | 最小 advisory baseline |
| `typescript-vue@1.0.0` | 最小 advisory baseline |
| Java lexical adapter | SnailJob 与 fixtures 已验证 |
| TypeScript/Vue lexical adapter | snail-job-admin 与 fixtures 已验证 |

Global Pack 只能是 advisory。未审核 draft Profile 的 hard 规则同样降级为 advisory。

## 8. 发布前兼容门槛

扩大兼容声明前必须：

1. 将目标版本加入 CI matrix；
2. 全量 `npm run verify` 通过；
3. `npm pack --dry-run` 通过；
4. 至少运行一个独立真实 Pi 生命周期；
5. 对 Extension API 或 Pi 版本变化记录真实日志；
6. 更新本文档和 Changelog；
7. 不得以 silent-on-clean 的 LSP 结果替代 TypeScript 编译和自动测试。

## 9. 当前不在范围内

- Pi `0.86.x` 及更高版本；
- Node.js 20 及更低版本；
- 小程序、移动端、React Native、UniApp、桌面端；
- 非 Java/TypeScript/Vue 语言；
- macOS 真实运行验证；
- 跨仓库自动信任或动态加载外部 Profile。
