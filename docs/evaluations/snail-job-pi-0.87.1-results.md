# SnailJob Pi 0.87.1 验收结果

> 运行编号：`20260923T082341Z-snailjob`  
> Extension 基线：`0.4.0-alpha.1`，Pi `0.87.1`  
> 结果：**通过**

## 覆盖范围与结果

| 检查项 | 后端 | Admin |
| --- | --- | --- |
| 仓库静态分析 | 26 个目标：24 个有效、2 个弱证据、0 个失败 | 21 个目标：19 个有效、2 个弱证据、0 个失败 |
| Candidate 隔离 | 跨仓库 0；同角色 100%；同模块 96.2% | 跨仓库、角色、workspace、排除项违规均为 0 |
| 真实 Observe 生命周期 | 通过 | 通过 |
| Profile 校验与指纹 | 通过，`9175fce444366fb2` | 通过，`4e365a00b244b274` |
| Guard 未读目标 | `TARGET_NOT_READ`，文件哈希不变 | `TARGET_NOT_READ`，文件哈希不变 |
| 读取并获得有效 Snapshot | `SNAPSHOT_VALID`，允许修改 | `SNAPSHOT_VALID`，允许修改 |
| 单次 bypass | 首次修改获准，第二次被阻断 | 仅对指定声明文件精确放行 |
| Session、Branch、reset 与 Shell 审计 | 通过 | 通过 |
| 隐私扫描 | 源码、完整 prompt、完整命令正文泄漏均为 0 | 源码、完整 prompt、完整命令正文泄漏均为 0 |

弱证据结果均正确执行 fail-open，其原因是缺少足够的同类实现，而非生命周期错误。

## 真实开发验收

在真实 `master` 分支上完成并审查了一套未提交的 Job Tag Management CRUD。通过验收的 v2 包含：

- Controller → Service → Mapper/PO 后端分层；
- ADMIN 权限保护，以及由服务端推导的 namespace 隔离；
- 按记录 ID 与当前 namespace 同时限定更新和删除；
- 分页、关键词搜索和启用/禁用状态筛选；
- 长度与范围校验，以及可选字符串归一化；
- MySQL、PostgreSQL、Kingbase、Oracle、DM8 和 SQL Server 六种方言的数据库定义；
- Admin typed API 和全局 `Api.*` 类型；
- `useTable`、`useTableOperate`、路由局部 search/drawer 和中英文 i18n；
- `tagStatus`/`tag_status` 状态字段，以及复用 Admin 公共状态控件。

使用 JDK `21.0.8`、Maven `3.9.11` 和 pnpm `10.18.3` 完成验证：

- 后端 web 模块及其依赖的 reactor compile：**构建成功**；
- Admin typecheck：**通过**；
- Admin 生产构建：**通过**；
- 两个仓库的 `git diff --check`：**通过**；
- Elegant Router 生成文件及 package/workspace 产物：已恢复，未保留变化。

详细本地证据位于 `.tmp/pi-convention-sense/acceptance/snail-job-crud/`。

## 结论

未发现 P0 产品缺陷，SnailAI 准入门禁通过。验收通过的 Job Tag 业务修改保持未提交状态；两个 SnailJob 仓库中的测试专用 Profile、`.pi`、生成文件和运行日志均已清理。
