# Web 前后端技术栈覆盖调研

> 目标：为 pi-convention-sense 的 Global Baseline Packs、Project Profile 与 Project Profiler Skill 确定首批覆盖范围。
> 范围：浏览器 Web 前端与服务端后端；暂不覆盖小程序、App、React Native、UniApp、桌面端、游戏及其他客户端。
> 首个验证项目：SnailJob 后端与 `snail-job-admin` 前端。
> 调研时间：2026-09-22。

## 1. 结论摘要

首批覆盖不应按“Java Spring Boot MVC MyBatis”这类完整组合逐个制作，而应采用可组合 Pack：

```text
Language Pack
+ Web Framework Pack
+ Architecture Pack
+ Persistence Pack
+ API/Transport Pack
+ Build/Test Pack
```

例如 SnailJob 后端可组合为：

```text
Java 21
+ Spring Boot 4 / Spring MVC
+ Maven multi-module
+ layered/modular architecture
+ MyBatis/MyBatis-Plus
+ REST + gRPC/Protobuf
```

前端可组合为：

```text
TypeScript
+ Vue 3
+ Vite 7
+ SPA/admin architecture
+ Pinia + Vue Router
+ Axios
+ Naive UI + UnoCSS
+ pnpm workspace
```

首批语言建议覆盖：

- 前端基础：JavaScript、TypeScript；
- 后端 P0：Java、TypeScript/JavaScript、Python、C#、Go、PHP；
- 后端 P1：Kotlin、Ruby；
- 前端 P0：Vue、React、Angular，以及 Vue/React 的主流 meta-framework；
- 前端 P1：Svelte/SvelteKit。

## 2. 数据来源与解释边界

### 2.1 国际来源

1. [Stack Overflow Developer Survey 2025 — Technology](https://survey.stackoverflow.co/2025/technology)
2. [Stack Overflow Developer Survey 2025 — Methodology](https://survey.stackoverflow.co/2025/methodology)
3. [GitHub Octoverse 2024](https://github.blog/news-insights/octoverse/octoverse-2024/)
4. [JetBrains Developer Ecosystem 2024](https://www.jetbrains.com/lp/devecosystem-2024/)
5. [State of JS 2024 — Front-end Frameworks](https://2024.stateofjs.com/en-US/libraries/front-end-frameworks/)
6. [State of JS 2024 — Meta-frameworks](https://2024.stateofjs.com/en-US/libraries/meta-frameworks/)
7. [Python Developers Survey 2024](https://lp.jetbrains.com/python-developers-survey-2024/)
8. [State of Spring Survey 2024](https://spring.io/blog/2024/06/03/state-of-spring-survey-2024-results/)
9. [Go Developer Survey 2024 H2](https://go.dev/blog/survey2024-h2-results)

### 2.2 国内来源

1. [2024 中国开源年度报告 — 数据篇](https://kaiyuanshe.github.io/2024-China-Open-Source-Report/data.html)
2. [2024 中国开发者调查报告公开摘要](https://www.thepaper.cn/newsDetail_forward_30035216)
3. [2024 中国开发者调查报告 Web 框架公开摘要](https://devpress.csdn.net/shanghai/669482667a28e124e67e7cc1.html)
4. [Gitee 2024 中国开源年度报告](https://talk.gitee.com/report/china-open-source-2024-annual-report.pdf)

### 2.3 数据限制

- GitHub 衡量平台活动；Stack Overflow、JetBrains 和国内报告衡量调查样本，不能直接横向比较。
- State of JS 面向 JavaScript 社区，React/Vue 等比例高于全体开发者调查是正常现象。
- 国内 Web 框架百分比来自公开摘要，未取得完整原始问卷数据，只作为方向性依据。
- “常用”不代表“最佳”，Global Pack 不应将流行度变成项目硬规则。
- 调研用于确定覆盖优先级，不用于决定具体项目必须采用什么技术。

## 3. 市场信号

### 3.1 语言

Stack Overflow 2025 的公开结果中：

- JavaScript：66.0%；
- Python：57.9%；
- TypeScript：43.6%；
- Java、C#、PHP、Go 处于约 29.4%～16.4% 区间。

GitHub Octoverse 2024 显示 Python、JavaScript、TypeScript、Java 和 Go 都处于主要或快速增长语言序列。JetBrains 2024 也显示 JavaScript、Python、TypeScript、Java、C# 和 Go 具有持续使用基础。

中国 2024 公开调查摘要给出的方向性结果为：

- JavaScript：34.6%；
- Python：30.9%；
- TypeScript：22.1%；
- Java：21.4%；
- Go：15.0%。

中国开源年度报告的仓库与开发者数据同样显示 JavaScript、Python、TypeScript、Java 和 Go 是需要优先覆盖的语言。

### 3.2 前端框架

Stack Overflow 2025：

- React：44.7%；
- Next.js：20.8%；
- Angular：18.2%；
- Vue.js：17.6%；
- Svelte：7.2%。

State of JS 2024 的社区样本中，React 使用面最广，Vue、Angular 紧随，Svelte 规模较小但满意度较高；Next.js 的使用规模高于 Nuxt，Nuxt 的留存反馈较好。

国内公开摘要显示 Vue.js 在中国 Web 框架中约为 30%，明显值得作为国内项目 P0；React 仍需作为全球和国内通用项目的 P0；Angular 在大型企业前端中仍有稳定使用基础。

### 3.3 后端框架

Stack Overflow 2025 的公开结果中：

- Express：19.9%；
- ASP.NET Core：19.7%；
- FastAPI：14.8%；
- Spring Boot：14.7%；
- Django：12.6%；
- Laravel：8.9%；
- NestJS：6.7%。

Python Developers Survey 2024 中，FastAPI、Django 和 Flask 都有显著使用；Web 开发人群中 Django 仍有较强基础。Go 社区中 Gin 是常见 Web 框架，但不同调查口径不宜和全体开发者百分比直接比较。

国内公开摘要显示 Spring Boot 约 20%、Node.js 约 18%、Django 约 12%、ASP.NET Core 约 11%。因此国内首批不能只覆盖 Java，也应纳入 Node.js、Python、.NET 和 Go。

### 3.4 数据库与基础数据组件

Stack Overflow 2025 的公开结果中：

- PostgreSQL：55.6%；
- MySQL：40.5%；
- SQLite：37.5%；
- Redis：28.0%；
- MongoDB：24.0%。

首批数据库知识不应包含 SQL 风格大全，而应关注会影响项目代码结构的部分：

- ORM/Mapper 模式；
- transaction boundary；
- repository/data-access role；
- migration 工具；
- pagination、locking、soft delete；
- cache-aside 与 key ownership；
- 多数据源和数据库方言边界。

企业项目还需保留 SQL Server、Oracle 以及国内数据库兼容层的识别能力，但它们不必各自复制一套业务编码规范。

## 4. 推荐的 Pack 分类模型

## 4.1 Language Pack

负责：

- 文件与模块识别；
- import/module 语义；
- 类型、异常、并发与测试基本结构；
- 语言级命名习惯；
- formatter/linter/build 工具探测。

首批：

| 优先级 | 语言 | 主要场景 |
| --- | --- | --- |
| P0 | JavaScript | Web 前端、Node.js 后端 |
| P0 | TypeScript | 现代前端、Node.js 后端 |
| P0 | Java | 国内外企业后端 |
| P0 | Python | API、数据与通用后端 |
| P0 | C# | ASP.NET Core 企业后端 |
| P0 | Go | 云原生、基础设施和高并发后端 |
| P0 | PHP | Laravel/Symfony Web 项目 |
| P1 | Kotlin | Spring/Ktor JVM 后端 |
| P1 | Ruby | Rails 项目 |

## 4.2 Web Framework Pack

### 后端 P0

| 语言 | 框架 | 首批重点角色 |
| --- | --- | --- |
| Java | Spring Boot / Spring MVC | controller、service、repository/mapper、DTO、config、event、client |
| TS/JS | Express | route、middleware、controller、service、repository、error handler |
| TS | NestJS | module、controller、provider/service、guard、pipe、DTO、entity |
| Python | FastAPI | router、dependency、schema、service、repository、exception handler |
| Python | Django / DRF | app、view/viewset、serializer、model、service、admin、migration |
| Python | Flask | blueprint、view、service、extension、schema |
| C# | ASP.NET Core | controller/minimal API、service、repository、DTO、middleware、options |
| Go | net/http + Gin | handler、middleware、service/usecase、repository、model/config |
| PHP | Laravel | controller、service/action、model、request、resource、middleware、job |

### 后端 P1

- Fastify；
- Symfony；
- Ruby on Rails；
- Ktor；
- Quarkus/Micronaut；
- Spring WebFlux；
- GraphQL server variants。

### 前端 P0

| 框架 | 重点角色 |
| --- | --- |
| Vue 3 | page/view、component、composable、store、service、router、layout、plugin |
| React | page/route、component、hook、store、query/service、provider、layout |
| Angular | component、service、module/standalone feature、guard、interceptor、store |
| Next.js | app/page、layout、server/client component、route handler、action、middleware |
| Nuxt | pages、layouts、components、composables、plugins、server routes、middleware |

### 前端 P1

- Svelte/SvelteKit；
- Remix；
- Astro（内容型 Web 项目）；
- legacy Vue 2 / React class component 兼容 Pack。

## 4.3 Architecture Pack

Architecture Pack 不绑定语言，应作为 overlay：

| 优先级 | 架构 | 关键知识 |
| --- | --- | --- |
| P0 | Layered MVC | controller/service/data 分层与依赖方向 |
| P0 | Modular Monolith | 模块所有权、公开接口、禁止跨模块内部引用 |
| P0 | Microservice | 服务边界、client、contract、event、配置和容错 |
| P0 | DDD | bounded context、aggregate、domain/application/infrastructure 分层 |
| P0 | Clean/Hexagonal | port/adapter、use case、领域与框架隔离 |
| P0 | SPA feature/page architecture | route/page、feature、shared component、state 和 API 边界 |
| P0 | SSR/SSG meta-framework | server/client boundary、data fetching、routing 和 cache |
| P1 | Event-driven/CQRS | command/query、event、handler、outbox 和一致性边界 |
| P1 | BFF | UI-specific contract、aggregation、auth/session boundary |

一个项目允许多个 Architecture Pack，并且必须支持 module/path override。

## 4.4 Persistence Pack

| 生态 | P0 |
| --- | --- |
| Java | MyBatis、MyBatis-Plus、JPA/Hibernate |
| Node/TS | Prisma、TypeORM、Drizzle、Sequelize |
| Python | SQLAlchemy、Django ORM |
| .NET | Entity Framework Core、Dapper |
| Go | database/sql、sqlx、GORM |
| PHP | Eloquent、Doctrine |

Persistence Pack 只表达结构和边界，不保存具体表字段命名大全。

## 4.5 API 与异步通信 Pack

P0：

- REST/JSON；
- OpenAPI；
- gRPC/Protobuf；
- WebSocket/SSE；
- Kafka；
- RabbitMQ；
- RocketMQ（国内项目优先级提高）；
- Redis cache/lock。

P1：

- GraphQL；
- Pulsar；
- NATS；
- event sourcing。

## 4.6 Build、质量和测试 Pack

这些主要用于检测项目能力与命令，不重复实现编译器/linter：

| 生态 | 构建/包管理 | 测试/质量 |
| --- | --- | --- |
| Java | Maven、Gradle | JUnit、Mockito、Spring Test、ArchUnit |
| JS/TS | npm、pnpm、Yarn、Vite、Webpack | Vitest/Jest、Testing Library、Playwright/Cypress、ESLint |
| Python | pip、Poetry、uv | pytest、mypy/pyright、Ruff |
| .NET | dotnet/NuGet | xUnit/NUnit、Roslyn analyzers |
| Go | Go modules | go test、golangci-lint |
| PHP | Composer | PHPUnit/Pest、PHPStan/Psalm |

## 5. 首批覆盖分级

## 5.1 P0-A：立即实现并用于 SnailJob

### 后端

- Java Language Pack；
- Spring Boot / Spring MVC Pack；
- Maven multi-module Pack；
- Layered MVC + Modular Monolith overlay；
- MyBatis/MyBatis-Plus Pack；
- REST Pack；
- gRPC/Protobuf generated-source Pack；
- MapStruct DTO mapping pattern；
- multi-datasource project knowledge。

### 前端

- TypeScript Language Pack；
- Vue 3 Pack；
- Vite Pack；
- pnpm workspace Pack；
- SPA/page-feature architecture；
- Pinia Pack；
- Vue Router Pack；
- Axios request/service Pack；
- Naive UI adapter metadata；
- UnoCSS utility-style metadata。

## 5.2 P0-B：首批通用 Web 覆盖

- React + Next.js；
- Angular；
- Node.js Express + NestJS；
- Python FastAPI + Django；
- ASP.NET Core；
- Go net/http + Gin；
- PHP Laravel；
- JPA/Hibernate；
- PostgreSQL/MySQL/Redis/MongoDB project metadata。

## 5.3 P1：第二轮扩展

- Nuxt；
- Svelte/SvelteKit；
- Flask；
- Fastify；
- Symfony；
- Ruby on Rails；
- Kotlin/Ktor；
- Quarkus/Micronaut；
- Clean/Hexagonal、CQRS/Event-driven 深度规则；
- GraphQL。

## 6. SnailJob 项目画像

## 6.1 后端

从根 `pom.xml` 和模块源码可确认：

- Java 21；
- Spring Boot 4.0.3；
- Maven multi-module；
- Spring MVC；
- MyBatis 4 / MyBatis-Plus 3.5；
- MapStruct；
- REST Controller 与 MVC View Controller 共存；
- gRPC/Protobuf，且生成 Java 文件提交在 `src/main/java`；
- MySQL、MariaDB、PostgreSQL、Oracle、SQL Server、达梦、人大金仓等多数据库适配；
- server、client、dispatcher、datasource、common 等多个模块族；
- 整体不是单一 MVC 标签，而是模块化后端 + 分层 Web + dispatcher/client 基础设施的混合架构。

建议 Profile 至少建立以下 override：

```text
server-ui/**
  role controller → mvc-view-controller

server-web/**
  role controller → rest-controller（个别 @Controller 作为反例/特例）

datasource-template/**
  role mapper → mybatis-mapper

common-core/**/grpc/auto/**
  generated protobuf → excluded

server-service/**
  application/domain service rules

dispatcher/**
  task handler/processor rules
```

这能直接解决本轮测试中 `server-ui/WebController` 被 REST Controller Evidence 污染的问题。

## 6.2 前端

从 `package.json`、workspace 和源码目录可确认：

- TypeScript 5.8；
- Vue 3.5；
- Vite 7；
- pnpm workspace；
- Vue Router 4；
- Pinia 3；
- Naive UI；
- UnoCSS + Sass；
- Axios workspace package；
- `<script setup lang="tsx">` 与普通 Vue SFC 混合；
- `src` 主应用与 `packages/*` 可复用库并存；
- API typing 使用全局 `Api.*` namespace；
- service API 函数使用 `fetch*` 命名和 typed request wrapper；
- page 通常组合 search、drawer、table hook 和 API service；
- store 使用 Pinia setup-store；
- hooks 使用 `use*` 命名并管理 Vue effect scope。

首批 TypeScript/Vue Scope 建议：

```text
ts:app:view-page
ts:app:view-module
ts:app:component-common
ts:app:component-business
ts:app:composable-hook
ts:app:api-service
ts:app:request-client
ts:app:pinia-store
ts:app:router
ts:app:layout
ts:app:plugin
ts:app:type-declaration
ts:workspace-package:component
ts:workspace-package:utility
ts:workspace-package:build-script
```

不能把所有 `.vue` 文件放在同一 Scope，也不能把主应用 `src` 与 `packages/*` peer 混用。

## 7. Project Profiler 首轮验收目标

对 SnailJob 执行 Profiler Skill 后，应生成可审核草案并满足：

1. 正确识别后端与前端是两个独立 Git repository；
2. 后端识别 Java/Spring Boot/Maven/MyBatis/gRPC/多数据库；
3. 前端识别 TypeScript/Vue/Vite/pnpm workspace/Pinia/Router/Axios；
4. 识别 `server-ui` 与 `server-web` Controller subtype 差异；
5. 排除 protobuf generated source；
6. 识别前端主应用和 workspace package 边界；
7. 为 view、component、hook、service、store、router 选择同类 peer；
8. 所有 Profile 结论带文件或配置 Evidence；
9. 未经用户确认的草案标为 `reviewed: false`；
10. 正常编码时只注入与当前目标有关的 Knowledge Capsule，不注入完整 Profile。

## 8. 不纳入当前范围

- 微信/支付宝等小程序；
- UniApp；
- React Native；
- Flutter；
- Android/iOS 原生；
- Electron/Tauri 桌面端；
- 游戏客户端；
- 嵌入式、数据科学 Notebook 与纯 CLI 项目的专用 Pack。

这些技术未来可以复用同一 Pack/Profile 架构，但不影响首批 Web 前后端交付。

## 9. 下一步建议

1. 定义 Pack 与 Project Profile schema；
2. 实现 Profile loader、fingerprint、module/path override 和来源优先级；
3. 编写 `project-profiler` Skill 的 init/adopt/refresh/diff 流程；
4. 先实现 SnailJob 所需 Java/Spring/MyBatis 与 TypeScript/Vue Packs；
5. 用 SnailJob 前后端分别运行 20～30 个 Scope 样本；
6. 再扩展 React/Next、Node/Nest、Python/FastAPI、.NET、Go、PHP；
7. Global Pack 永不直接覆盖已审核的 Project Profile 或本地 Evidence。
