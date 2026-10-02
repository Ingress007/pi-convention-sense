# 文件与目录生命周期

本文说明 `pi-convention-sense` 插件仓库和使用该插件的目标项目中，各类文件的用途、是否应该提交以及何时可以删除。

## 1. 目标项目中的文件

| 路径 | 类型 | 建议提交 | 用途 |
|---|---|---:|---|
| `.pi/convention-sense.json` | 项目运行配置 | 是 | 启用 Observe/Guard、语言、预算、排除路径和工具映射 |
| `.convention-sense/profile.json` | 项目知识 | 是 | 已采用的项目技术栈、模块、effective role、知识和规范；审核状态由 `review.status` 明确记录 |
| `.convention-sense/profile.candidate.json` | 审核中间文件 | 否 | Profiler Skill 生成的候选 Profile；批准后替换 active Profile |
| `.pi/convention-sense/` | 本地运行状态 | 否 | NDJSON 运行日志和诊断（Session/Branch checkpoint 不在这里，见下） |
| `.tmp/pi-convention-sense/` | 本地临时产物 | 否 | 仓库评估原始 JSON、临时日志、一次性研究结果 |

### `.pi/convention-sense.json`

这是项目级插件配置，不是日志目录中的文件。典型来源：

```text
examples/config/java-observe.json
examples/config/typescript-vue-observe.json
examples/config/java-guard.json
```

配置只有在项目受信任时加载。修改配置后应重启 Pi。

### `.convention-sense/profile.json`

这是一个 Git repository 对应的 Project Profile。Extension 不会根据一次 Observe 自动创建或覆盖它。标准流程是：

1. Profiler Skill 生成 `profile.candidate.json`；
2. 校验并展示语义 diff；
3. 用户明确批准；
4. adopt 为 `profile.json`；
5. 团队通过代码审查提交。

`draft` Profile 可以直接用于验证，但其中的 hard 规则运行时降级为 advisory。

### `.pi/convention-sense/`

这是本地运行状态目录，例如：

```text
.pi/convention-sense/observe.ndjson
```

日志不包含源码、edit/write 正文、完整 prompt、完整 Shell 命令或工具输出。该目录不应提交，可以随时删除；删除后只会失去历史运行日志和诊断记录。`spike.ndjson` 是 Stage 0 的历史默认文件名，当前默认只写 `observe.ndjson`。

read ledger 的 checkpoint **不在这个目录**：它是 Pi 自己的 Session 文件里的一条 custom entry（类型名 `pi-convention-sense-spike-state`，格式 v3，只含读取/修改记录和计数，不含源码、prompt 或 Snapshot），只在 `agent_settled` 与 `session_shutdown` 时写入，随 Session/Branch 恢复。因此删除 `.pi/convention-sense/` 不会清除已恢复 Session 的账本，要清除请用 `/convention-reset confirm` 或开启全新 Session。

配置项 `logPath` 只能指向该目录内的文件；日志文件本身及其上的目录都不得是符号链接或 junction（仓库内容不可信，git 可以提交符号链接），否则回退到默认的 `.pi/convention-sense/observe.ndjson` 并在配置诊断中说明原因。默认路径本身不安全时会关闭日志（`logging.level=silent`）而不是写穿链接。

## 2. 插件仓库中的永久目录

| 路径 | 用途 |
|---|---|
| `extensions/` | Pi Extension 入口与生命周期接线 |
| `src/` | Observe、Guard、Profile 和基础运行时源码 |
| `skills/` | Project Profiler Skill 与辅助脚本 |
| `scripts/` | 可复用的仓库评估、性能基准和发布包冒烟工具；属于源码，不是临时输出，不随 npm 包发布 |
| `examples/` | 可复制到目标项目的配置示例 |
| `test/` | 自动测试与固定 fixture |
| `docs/` | 设计、需求、研究、规范和永久评估结论 |
| `docs/evaluations/` | 经人工审阅、可版本控制的评估报告 |
| `test/fixtures/profiles/` | 测试专用 Profile，不会自动安装到真实项目 |

`docs/evaluations/` 保存结论和方法，不保存大批原始运行日志。

## 3. 插件仓库中的本地或生成目录

| 路径 | 是否可删除 | 说明 |
|---|---:|---|
| `node_modules/` | 是 | npm 依赖，执行 `npm install` 可恢复 |
| `dist/` | 是 | TypeScript 构建产物，执行 `npm run build` 可恢复 |
| `.pi/convention-sense/` | 是 | 当前插件开发会话的运行日志 |
| `.tmp/pi-convention-sense/` | 是 | 评估、研究和调试的原始临时产物 |

自动测试和基准脚本只在系统临时目录（`os.tmpdir()`，名称以 `pi-convention-` 开头）里创建一次性项目，用完即删，不会写入插件仓库；手动做真实模型 smoke 时，请用 `git clone --depth 1` 把目标仓库克隆到系统临时目录再运行，结束后删除克隆，原仓库保持只读。

历史目录 `.evaluation/` 已废弃。新的评估工具默认输出到：

```text
.tmp/pi-convention-sense/evaluations/
```

## 4. 插件开发专用配置

插件仓库中的：

```text
.pi/settings.json
```

内容为：

```json
{
  "packages": [".."]
}
```

它用于让 Pi 在开发本插件时加载当前 package。它不是用户项目的 `convention-sense` 配置，也不会替代 `.pi/convention-sense.json`。

## 5. Git 建议

插件仓库自身的 `.gitignore` 还忽略 `.claude/worktrees/` 与 `.claude/settings.local.json`（Claude Code 的 worktree 和本地设置）。目标项目推荐忽略：

```gitignore
.pi/convention-sense/
.tmp/pi-convention-sense/
.convention-sense/profile.candidate.json
```

推荐提交：

```text
.pi/convention-sense.json
.convention-sense/profile.json
```

如果团队不希望共享 Pi 运行配置，也可以不提交 `.pi/convention-sense.json`，但应在项目开发文档中记录安装和配置方式。

## 6. 清理命令

仅清理当前 Branch 的 read ledger、Snapshot、Guard/bypass 和 post-change 状态，优先在 Pi 中执行：

```text
/convention-reset confirm
```

该命令保留配置、Profile 和审计日志，并写入空 checkpoint。若需要同时删除本地日志和所有本地运行文件，再退出 Pi 后执行以下文件系统命令。

PowerShell：

```powershell
Remove-Item -Recurse -Force .pi/convention-sense -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .tmp/pi-convention-sense -ErrorAction SilentlyContinue
```

Bash：

```bash
rm -rf .pi/convention-sense .tmp/pi-convention-sense
```

清理只删除日志与临时产物；已恢复的 Session 仍会从 Pi Session 文件里的 checkpoint 恢复账本，需要 fresh 状态请先 `/convention-reset confirm` 或开启全新 Session。清理不会删除 Project Profile 或项目运行配置。

## 7. 快速判断

- 需要团队共同审阅的知识：放入 `.convention-sense/profile.json`。
- 需要团队共同使用的运行参数：放入 `.pi/convention-sense.json`。
- 只为本机运行产生的数据：放入 `.pi/convention-sense/`。
- 一次性分析原始数据：放入 `.tmp/pi-convention-sense/`。
- 需要长期保留的评估结论：整理后写入 `docs/evaluations/`。
