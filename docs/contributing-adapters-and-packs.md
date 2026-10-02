# Pack 与 Adapter 贡献和测试规范

> 状态：v1
> 适用范围：浏览器 Web 前后端技术栈
> 安全默认：Observe + fail-open；Global Pack 只能是 advisory

## 1. 目标

本规范用于让维护者或 AI Agent 在不了解内部历史的情况下，安全地新增语言、框架、架构、持久化、Transport、Build/Test Pack 或源码 Adapter。

贡献必须满足：

1. 不跨 Git repository 获取 Evidence；
2. 不把 Global Pack 变成项目硬规则；
3. 不注入完整 Profile；
4. 不记录源码、write/edit 文本、完整 prompt 或完整 Shell 命令；
5. Evidence 不足、解析失败或 Scope 不确定时 fail-open；
6. Guard 只阻断 Discovery 缺口，不阻断风格差异。

## 2. Pack 与 Adapter 的职责

### Pack

Pack 是声明式、可组合、带版本的 baseline knowledge：

- 检测技术栈；
- 提供角色分类参考；
- 提供 advisory conventions 与 knowledge；
- 不读取源码、不执行脚本、不直接选择候选；
- 只有被受信 Project Profile 显式启用后才生效。

### Adapter

Adapter 负责确定性源码分析：

- 判断目标是否支持或应排除；
- 解析 repository/module/workspace 边界；
- 生成 base role 与 confidence；
- 提取不含源码正文的结构 facts；
- 对同语言、同 role、同 repository 候选排序；
- 从重复事实生成 Local Evidence。

Project Profile 可以将 base role 细分为 effective role，但不得用脚本选择。

## 3. 目录与命名

建议贡献包含：

```text
src/profile/builtin-packs.ts       # 内置 Pack 注册（小规模阶段）
src/observe/<language>-analyzer.ts
src/observe/<language>-scope-detector.ts
src/observe/<language>-candidate-ranker.ts
test/fixtures/<stack>/
test/<adapter>.test.ts             # 或现有 observe/profile 测试
examples/config/<stack>-observe.json
docs/research/<stack>-coverage.md  # 有外部调研时
```

Pack ID 使用小写 kebab-case，如 `java-spring`、`typescript-vue`。版本使用 SemVer。effective role 使用稳定的 kebab-case 语义名称，不包含项目路径。

## 4. Pack 契约

每个 Pack 必须声明：

- `schemaVersion`
- 稳定 `id` 与 `version`
- `kind`
- `title`、`description`
- 支持的 `languages`
- 至少一个可解释 detection signal
- 零个或多个声明式 role/convention/knowledge

约束：

- Pack convention 的实际强度始终降级为 advisory；
- Selector 只能使用白名单字段；
- 禁止脚本、命令、动态 import 和任意表达式；
- 不得声明某个开源项目特有的组织事实为通用规则；
- breaking role/selector 变化升级 major；新增 advisory 规则升级 minor；文本修正升级 patch；
- Profile 中引用的 Pack id/version 必须参与 fingerprint。

## 5. Adapter 契约

### 5.1 支持与排除

Adapter 必须显式定义：

- 源文件扩展名；
- generated、test、vendor、build output 和 declaration 排除规则；
- existing 与 prospective target 行为；
- 无法解析时的 `scope-unknown` 或 `analysis-error` fail-open 路径。

Generated 判断至少覆盖路径和常见生成头。不能仅按类名猜测。

### 5.2 Scope

Scope 至少包括：

- language；
- repository root；
- module/workspace package；
- base role；
- confidence；
- 可选 effective role、architecture、profile tags 和 profile fingerprint。

候选必须先满足 repository、language 和 base role 边界；Profile 生效后还必须满足 effective role。workspace 项目默认不得跨 package 取 peer。

### 5.3 Facts 与 Evidence

Facts 必须是结构化摘要，不能保留源码正文。Observation 必须包含：

- category 与 pattern；
- support 与 samples；
- confidence；
- dominant/mixed 状态；
- 可选 counter-evidence 计数。

单样本或低置信结论不得提升为项目硬规则。共存的 additive 模式不得误报为互斥 mixed 模式。

### 5.4 排序

排序必须可解释并输出 breakdown。最低要求：

- same role；
- module/package proximity；
- 结构相似度；
- generated/test penalty；
- 稳定 tie-break。

不得使用文件名相似度作为唯一主要信号。

### 5.5 稳健性

Adapter 的分析在 Pi 事件循环上同步运行，必须满足：

- 对任意不超过 1 MiB 的输入线性或有界：不要写会对每个锚点都扫到文件末尾的无界正则（无界的 `[^x]*`、惰性 `[\s\S]*?`、`\w*关键字\w*` 之类），用有界重复 `{0,N}` 或手写线性扫描；超过 `MAX_ANALYZED_FILE_BYTES`（1 MiB）的文件不分析；
- 注释/字符串屏蔽按 UTF-16 下标写入（缓冲区用 `text.split("")`，不用 `[...text]`），保持行与偏移不变，并识别 LF、CR、CRLF；BOM 和 NUL 字节不得破坏分析；
- generated/test/role/workspace 判定只用仓库相对路径（`classificationPath`），路径比较用 `pathKey`/`samePath`；
- 可预期的分析失败返回 reason code（`scope-unknown`、`analysis-error`），不向 Pi 生命周期抛异常。

## 6. 必需测试矩阵

### A. Scope 单元测试

每个公开 role 至少包含：

- 2 个正例；
- 1 个相邻 role 反例；
- 1 个 generated/test 排除例；
- 1 个低置信或 unknown 例（若适用）。

### B. Candidate 契约测试

必须断言：

- 不跨 repository；
- 不跨 base/effective role；
- workspace package 默认隔离；
- generated/test/vendor 不进入 Top-K；
- tie-break 可重复；
- prospective target 不需要先创建文件。

### C. Evidence 测试

至少覆盖：

- 全部样本一致；
- dominant + counter-evidence；
- mixed；
- 单样本 weak；
- additive 模式；
- token budget 裁剪后语义仍完整。

### D. Profile/Pack 测试

必须断言：

- untrusted Profile 不加载；
- cross-root Profile 被拒绝；
- unknown/script selector 被拒绝；
- draft hard 降级；
- Global Pack hard 降级；
- enabled Pack id/version 改变 fingerprint；
- effective role 能隔离相邻 subtype；
- Knowledge Capsule 有界且 XML 转义。

### E. Extension 生命周期

至少覆盖：

1. read success 后才进入 ledger；
2. Snapshot 创建；
3. 下一 Context 注入 Snapshot/Capsule；
4. Profile 变化使旧 Snapshot stale；
5. branch rebuild；
6. weak/no-peer/error fail-open；
7. Guard 在 valid Evidence 缺少 read/context 时阻断；
8. bypass 单路径、单次消费；
9. shell 后置审计；
10. 日志隐私。

### F. 稳健性测试

- 把新增正则/扫描的最坏输入加进 `test/robustness.test.ts`（每个分析器 1 s 预算）；
- 新语言的 fixture 放进 `test/fixtures/` 后，`test/line-endings.test.ts` 会自动检查它在 LF/CRLF/CR 下的 facts 一致；
- 用一个真实仓库的全部文件对修改前后的 facts 做差分，确认只有预期的差异；
- 新增配置项要同步 `test/fuzz-state.test.ts` 的生成器与不变量。

### G. 真实仓库验证

每个新 stack 在宣称支持前至少验证一个固定 commit 的优质开源仓库：

- 只读扫描原仓库；
- 修改测试仅在 disposable worktree；
- 记录 commit、样本路径、预期 role、Top-K 和排除项；
- 至少运行一个独立 Pi 新进程；
- 验证 Observe 主流程；
- 验证一次 Guard 阻断且文件 hash 不变；
- 完成后强制清理 worktree并核对原仓库状态。

不得把当前长期运行 Pi 实例的历史 Snapshot 当作新版本结果。

## 7. 质量门槛

合并最低门槛：

| 项目 | 门槛 |
|---|---|
| TypeScript check | 0 error |
| 自动测试 | 100% pass |
| repository leakage | 0 |
| generated target leakage | 0 |
| role boundary fixture | 100% |
| Profile/Pack trust tests | 100% |
| 日志敏感正文 | 0 |
| Snapshot/Capsule | 不超过配置预算 |
| Guard deadlock | 0 永久阻塞路径 |
| `npm pack --dry-run` | 成功且包含所需资源 |
| 对抗输入 | 每个分析器在 1 MiB 级对抗输入上不超过 1 s |
| 覆盖率 | `npm run coverage` 通过（行 88% / 分支 78% / 函数 88%） |

真实仓库 Top-K 准确率与性能不设置脱离项目规模的伪统一数字。贡献者必须报告样本量、平均值、P95 和误差案例；维护者基于目标 stack 决定是否准入。

## 8. CI 与本地命令

最低验证命令：

```bash
npm run check
npm test
npm run verify
npm run coverage
npm pack --dry-run
```

若新增 Profile fixture：

```bash
node skills/project-profiler/scripts/profile-tools.mjs validate \
  test/fixtures/profiles/<project>/.convention-sense/profile.json .
```

真实仓库使用 `scripts/evaluate-profile-repository.mjs` 输出不含源码的结构化 artifact。

## 9. 贡献流程

1. 调研技术栈与真实仓库，不先写硬规则；
2. 添加最小 fixtures 与失败测试；
3. 实现 Scope 与排除；
4. 实现 facts、ranking 和 Evidence；
5. 添加 advisory Pack（若需要）；
6. 完成 Profile/Extension/Guard 契约测试；
7. 在 disposable worktree 运行真实仓库验证；
8. 记录误差、性能、隐私检查和未覆盖边界；
9. 更新 README、兼容矩阵与版本；
10. 通过 review 后合并。

## 10. Pull Request 清单

> 这是每个新增 Adapter/Pack PR 的空白模板，不是当前仓库的未完成验收门禁。SnailJob/SnailAI 本轮真实验收结果见 `docs/evaluations/`；Guard 生产准入的未完成项仍记录在 `requirements.md` 和 `stage-2-guard.md`。

- [ ] role 与边界有明确文档
- [ ] Pack 仅 advisory 且无脚本
- [ ] generated/test/vendor 排除已测试
- [ ] repository/workspace 隔离已测试
- [ ] prospective target 已测试
- [ ] Profile trust/fingerprint 已测试
- [ ] Knowledge Capsule 预算已测试
- [ ] Observe/Guard 生命周期已测试
- [ ] 日志不含敏感正文
- [ ] 真实仓库 commit 与结果已记录
- [ ] disposable worktree 已清理
- [ ] `npm run verify` 通过
- [ ] `npm pack --dry-run` 通过
