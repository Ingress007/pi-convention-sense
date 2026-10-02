# Project Intelligence：Global Pack、Project Profile 与 Local Evidence

> 状态：Stage 3 Profile Runtime、Profiler Skill、TypeScript/Vue Adapter、最小内置 Pack catalog 与 SnailJob/SnailAI 真实主流程验证已完成
> 主技术设计：[design.md](./design.md)
> 首个垂直验证项目：SnailJob 后端与 `snail-job-admin` 前端
> 数据模型：`src/profile/types.ts`

## 1. 目标

在现有局部代码 Evidence 引擎上增加两层信息源：

1. 可组合的 Global Baseline Pack；
2. 可持久化、可审核的 Project Profile 与项目知识；
3. 保留当前按 Scope 动态生成的 Local Evidence。

本阶段不追求一次覆盖所有技术栈，而是先以 SnailJob 跑通“探测、生成草案、审核、加载、解析、注入、验证”主流程，再把流程固化为开源适配规范。

### 1.1 当前实现状态

Profile Runtime 已完成：

- 受信任项目的 `.convention-sense/profile.json` 加载、schema 校验、repository-root 隔离和内容 fingerprint；
- module、selector、scope override、draft/reviewed 强度门控和 effective role 解析；
- Analyzer `multi-lexical-v6-semantic-peers` 按 base/effective role、Java declaration kind 和 TypeScript/Vue 文件语义后缀筛选与排序候选；
- Profile fingerprint 与 Pack id/version 引用进入 Snapshot freshness；
- 当前目标的 Knowledge Capsule 与 Local Snapshot 在统一 token 预算内注入；
- Profile 缺失、未信任、无效或跨仓库时 fail-open 到既有 Local Evidence；
- Guard 仍只约束 Discovery，不因 Profile/Pack 风格差异阻断；
- SnailJob draft fixture：`test/fixtures/profiles/snail-job/.convention-sense/profile.json`。

自动测试覆盖 Profile 正反例、MVC/REST effective role 隔离、Capsule 预算、TypeScript/Vue role 与 workspace 隔离、Extension/Guard/reset 生命周期、Practice one-shot 与 `scope-unknown` fallback、外部 Profile trust 隔离和安全日志。最新完整验证为 `npm run verify`，306/306 通过。

当前边界：已提供 `java-spring@1.0.0` 与 `typescript-vue@1.0.0` 两个最小内置 advisory Pack，并完成 SnailJob 全栈、SnailAI 主流程真实生命周期验证、24 个任务的 Guard 生产准入、Pack/Adapter 贡献规范和兼容矩阵。SnailJob 还完成了 Job Tag Management CRUD v2 真实业务开发验收；该业务 diff 未提交，供人工审查。SnailAI Admin 原生检查因缺少 `node_modules` 暂列环境阻塞，不扩展为已验证兼容性。下一阶段扩展更多真实仓库、Pi 版本与技术栈矩阵；当前不宣称覆盖其他客户端或未验证技术栈。

## 2. 三层架构

```text
Global Baseline Packs
        ↓
Reviewed Project Profile / Knowledge
        ↓
Scoped Local Evidence
        ↓
Context Resolver + Token Budget
        ↓
Pi Agent
```

### 2.1 Global Pack

Global Pack 描述语言、框架、架构、持久化、通信、构建和测试生态中的通用基线。

约束：

- 默认永远是 advisory；
- 只用于新项目初始化、Profile 生成参考和 Evidence 缺失时 fallback；
- 不得直接覆盖 reviewed Project Profile；
- 不得因为 Pack 不匹配而阻断现有项目修改；
- 使用可组合 Pack，禁止为每种技术组合复制完整规则集。

### 2.2 Project Profile

Project Profile 是当前仓库经 Evidence 支持、并可由用户审核的项目画像。

内容包括：

- 技术栈与版本；
- 模块和路径边界；
- 架构标签；
- base role 到 effective role 的 Scope override；
- 少量项目级知识；
- 项目级 advisory convention；
- 启用或禁用的 Pack；
- 每项结论的 Evidence 引用。

Profile 默认路径：

```text
.convention-sense/profile.json
```

项目自定义 Pack 可放置于：

```text
.convention-sense/packs/*.json
```

运行日志继续放在 `.pi/convention-sense/`，不得与可版本控制的项目定义混放。

### 2.3 Local Evidence

现有 Observe Analyzer 继续从当前 Scope 的 2～4 个 peer 构建动态 Snapshot。

Local Evidence：

- 是当前代码事实，不是永久规则；
- 优先于 Global Pack；
- 与 reviewed hard project knowledge 冲突时必须明确显示冲突；
- 不自动回写 Profile；
- 不因单个 Snapshot 自动升级为长期规范。

## 3. 仓库隔离

一个 Project Profile 只属于一个 Git repository。

逻辑上相关但位于不同 Git repository 的项目，例如：

- `snail-job` 后端；
- `snail-job-admin` 前端；

应分别生成 Profile。Profile 可以通过 `relatedProjects` 记录关联关系，但：

- Candidate Finder 不得跨 related project 选择 peer；
- Snapshot Cache 不得跨 repository 复用；
- Knowledge Retriever 只有在任务明确涉及跨项目 contract 时才能读取关联摘要；
- 跨项目引用不能降低现有 repository isolation。

### 3.1 从当前会话读取外部仓库

当 Pi 从仓库 A 启动，却读取仓库 B 的绝对路径时：

1. B 的目标和候选仍按 B 的 Git repository root 隔离；
2. A 的 Profile 不得应用到 B；
3. 即使 B 存在 Profile，也因为项目信任不能从 A 隐式扩展到 B，其状态必须为 `ignored`；
4. B 只使用 base role 与 Local Evidence，不生成 Profile effective role 或 Knowledge Capsule；
5. 日志记录 `profileStatus=ignored` 和诊断原因；
6. 用户必须从 B 的 repository root 显式批准并启动新的 Pi，才能加载 B 的 Profile。

该策略有 Extension 集成测试覆盖，防止后续实现把“候选 repository 隔离”和“Profile trust 隔离”混为一谈。

## 4. 数据模型

模型定义于 `src/profile/types.ts`。

### 4.1 Convention Pack

```typescript
interface ConventionPack {
  schemaVersion: 1;
  id: string;
  version: string;
  kind: "language" | "framework" | "architecture" | "persistence" | "transport" | "build" | "testing" | "library";
  languages: string[];
  detection: PackDetectionSignal[];
  roles?: PackRoleDefinition[];
  knowledge?: PackKnowledgeItem[];
  conventions?: PackConventionItem[];
}
```

### 4.2 Project Profile

```typescript
interface ProjectProfile {
  schemaVersion: 1;
  profileVersion: string;
  project: {
    name: string;
    repositoryRoot: string;
    relatedProjects?: RelatedProject[];
  };
  generatedAt: string;
  generatedBy: "agent" | "human" | "imported";
  review: {
    status: "draft" | "reviewed";
    reviewedAt?: string;
    reviewedBy?: string;
  };
  technologies: ProjectTechnologyRef[];
  packs: ProjectPackRef[];
  modules: ProjectModuleProfile[];
  scopeOverrides: ProjectScopeOverride[];
  knowledge: ProjectKnowledgeItem[];
  conventions: ProjectConventionItem[];
}
```

### 4.3 Selector

Selector 只使用安全、可解释的数据字段：

- paths / excludePaths；
- language；
- module；
- base role；
- file name；
- annotation；
- manifest dependency。

V1 Profile 不允许嵌入任意脚本或可执行表达式。

### 4.4 Evidence 引用

Profile 只保存：

- 文件路径；
- 可选行号；
- Evidence 类型；
- 简短说明。

默认不保存源码片段、完整 prompt 或命令内容。

## 5. base role 与 effective role

为兼容现有 Snapshot 和 Guard，保留当前 base role，例如 `controller`。Profile Resolver 可增加 effective role：

```text
controller → mvc-view-controller
controller → rest-controller
vue-file   → view-page
vue-file   → reusable-component
```

候选选择与最终 Scope Key 优先使用 effective role；无法解析时回退 base role。

SnailJob 首轮预期：

```text
server-ui/** + @Controller
  controller → mvc-view-controller

server-web/** + @RestController
  controller → rest-controller

grpc/auto/** + generated header
  target/candidate → excluded
```

## 6. 来源与冲突优先级

按以下顺序处理冲突：

1. 用户当前明确需求；
2. 安全、编译器、类型系统、lint 和测试；
3. reviewed Project Profile 中的 hard knowledge；
4. 当前 Scope 的多文件 Local Evidence；
5. reviewed Project Profile 中的 advisory knowledge/convention；
6. draft Project Profile；
7. Global Baseline Pack；
8. 通用最佳实践。

额外规则：

- draft Profile 中的 `hard` 必须降级为 advisory；
- Global Pack 中的 `hard` 必须降级为 advisory 并输出诊断；
- Local Evidence 与 reviewed hard rule 冲突时，保留双方来源并提示，不静默覆盖；
- 当前 Guard 仍只阻断 Discovery 缺口，不因 Pack/Profile 风格差异阻断；
- 未来若支持 hard architecture guard，必须独立显式启用。

### 6.1 与 Engineering Practice 的关系

Local Evidence 描述当前代码事实，不代表优秀工程实践。已实现的 Practice Advisory 与 opt-in `auto-once` 复用 Knowledge Capsule 提供的 reviewed/draft Profile `knowledge` 和 `conventions`，并基于目标结构与当前任务 mutation relevance 选择审查问题，但：

- Practice Signal 只选择 review question，不进入知识权威性排序；`scope-unknown` fallback 也不创建 Scope、Snapshot 或 peer evidence；
- draft Profile 和 Global Pack 中的工程原则继续 advisory；
- 注释、拆分或设计模式建议不得进入 Convention Guard；
- P1/P2 继续复用现有 schema；P3 未发现需要项目专属声明式 trigger 的证据，因此不新增 `practices`；
- Profile 更新仍必须经过 candidate、validate、semantic diff、显式批准和 adopt。

详细设计和实施顺序见 [Engineering Practice](engineering-practice.md)。

## 7. Knowledge Capsule

完整 Profile 不得每轮注入。Resolver 只生成当前任务相关的 Capsule。

默认预算建议：

- Project Knowledge Capsule：200～400 tokens；
- Local Convention Snapshot：沿用最多 1200 tokens；
- 详细知识通过路径引用按需读取；
- 同一 Scope 只注入一个最新 Capsule 和 Snapshot。

Capsule 选择依据：

1. 当前待修改目标；
2. matched module；
3. effective role；
4. architecture/framework tags；
5. hard knowledge 优先；
6. 最近任务和 Token 预算。

## 8. Project Profiler 生命周期

Profiler Skill 位于 `skills/project-profiler/`，可通过 `/skill:project-profiler <mode>` 显式调用，也可由 Pi 根据描述按需加载。支持 `init`、`adopt`、`refresh` 和 `diff`。

安全约束：

- 使用当前 Agent 探测，不调用第二个 LLM；
- 只写 `.convention-sense/profile.candidate.json`，展示 diff 并获得显式批准后才替换 active Profile；
- 默认生成 draft，未经用户审核不得标记 reviewed；
- 不修改源码、`AGENTS.md`、构建、lint 或 test 配置；
- 一个仓库一个 Profile，关联仓库只记录元数据；
- helper 提供无依赖的 `validate`、`fingerprint` 和 semantic `diff`；
- Selector 拒绝脚本和未知字段。

Pi `DefaultResourceLoader` 已验证可发现该 Skill，且无诊断。

### 8.1 Adopt

```text
扫描 manifest/build/config
→ 识别语言和技术栈
→ 识别模块边界
→ 抽样读取角色文件
→ 生成带 Evidence 的 draft Profile
→ 用户审核
→ 标记 reviewed
```

### 8.2 Init

新项目根据用户选择的 Pack 生成最小 Profile 草案。Global Pack 是起点，不是永久不可覆盖的标准。

### 8.3 Refresh

```text
读取现有 Profile
→ 重新探测
→ 生成 diff
→ 用户确认
→ 更新 profileVersion/fingerprint
```

### 8.4 运行时

Extension 不调用额外模型：

```text
加载 reviewed/draft Profile
→ 校验 schema 和 repository root
→ 解析 target selector
→ 计算 effective role/module/tags
→ 约束 Candidate Ranker
→ 合并 Pack/Profile/Local Evidence
→ 生成 Knowledge Capsule
```

## 9. Freshness 与 fingerprint

Profile fingerprint 至少包含：

- Profile JSON 内容；
- schemaVersion；
- profileVersion；
- 启用 Pack 的 id/version；
- Analyzer/Resolver 版本。

变化后：

- Profile 文件变更在下一次 Context freshness 检查时使相关 Snapshot stale；
- Extension 实现代码变更需要重启 Pi；
- 重新解析 Scope 和候选；
- 不跨 Branch 或 repository 复用旧 Resolution；
- schema 无效时输出诊断并 fail-open 到现有 Local Evidence；
- Profile 加载按 `mtime` + `size` 缓存（与 Snapshot freshness 同一条 racy-clean 规则：文件在缓存时足够旧才信任元数据，否则重读内容），信任判断先于缓存，所以修改 Profile 仍立即生效；
- 被标记为 stale 的 Snapshot 在目标被重新分析之前不会再被当作新鲜证据（即使 fingerprint 又变回去）。

## 10. SnailJob 垂直主流程

### 10.1 后端 Profile

识别：

- Java 21；
- Spring Boot 4 / Spring MVC；
- Maven multi-module；
- MyBatis/MyBatis-Plus；
- MapStruct；
- REST + MVC View + gRPC；
- 多数据库；
- server/client/dispatcher/datasource/common 模块族。

关键验收：

- `server-ui/WebController` 不再使用 REST Controller 作为主要 Evidence；
- `server-web` 的 `@RestController` 使用同 subtype peer；
- protobuf generated source 被排除；
- 现有 ServiceImpl/Mapper Evidence 不退化。

### 10.2 前端 Profile

TypeScript/Vue Adapter 已实现于：

- `src/observe/typescript-analyzer.ts`；
- `src/observe/typescript-scope-detector.ts`；
- `src/observe/typescript-candidate-ranker.ts`；
- fixture：`test/fixtures/typescript-vue/`；
- 示例配置：`examples/config/typescript-vue-observe.json`。

识别：

- TypeScript + Vue 3 + Vite；
- pnpm workspace；
- Pinia、Vue Router、Axios；
- Naive UI、UnoCSS；
- SFC 与 TSX；
- 主应用与 `packages/*` 边界。

关键验收：

- page 不与基础 component 混为同 Scope；
- composable、API service、request client、store、router 分开；
- 主应用文件不默认使用 workspace build script 作为 peer；
- Profile 和 Local Evidence 都遵守 Token 预算。

自动 fixture 与 Extension 测试已关闭上述分类、workspace、generated、prospective 与 Guard 生命周期风险；真实 `snail-job-admin` 样本评估留在全栈验证任务中；SnailJob/SnailAI 的永久结果见 [双项目发布就绪评估](evaluations/release-readiness-results.md)。

## 11. 开源贡献边界

一个新增技术栈适配至少应提交：

1. Pack manifest；
2. detection signal；
3. role taxonomy；
4. selector/override 示例；
5. 最小 fixture；
6. 正反例测试；
7. 真实开源项目样本；
8. 候选认可率、Observation 准确率和误拦截率；
9. generated/test/vendor 排除规则；
10. 隐私与日志检查。

适配不能只提交自然语言规则列表。

## 12. 非目标

本阶段仍不做：

- 自动修改 `AGENTS.md`；
- 未审核草案自动升级为 hard rule；
- Global Pack 直接阻断现有项目；
- 跨仓库候选复用；
- 每轮调用第二个 LLM；
- 自动重构历史代码；
- 全量 Profile 每轮注入。
