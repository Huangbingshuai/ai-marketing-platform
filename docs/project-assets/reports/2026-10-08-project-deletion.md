# 永久删除项目 · 2026-10-08

> 以下是前一轮实施记录。当前版本已改为后台异步删除，并禁止删除当前项目；最新行为与验收见[项目异步删除](2026-10-08-async-project-deletion.md)。

项目资产库的项目列表右侧提供红色「删除」按钮。点击后复用全局危险操作确认弹窗，显示项目名称及不可恢复范围；确认才请求 `DELETE /api/projects/:projectId`。取消、ESC、焦点恢复、重复点击禁用、删除失败保留当前项目、删除当前项目后退出及刷新恢复均已验证。

删除覆盖整个项目的所有工作流和历史分支，包括草稿、工作副本、修订快照、文件引用、资产及历史版本、上传/生成/交付任务、Outbox 和项目缓存。数据库事务先锁定项目及活动任务记录，检查生成、上传、返修任务，再解除 Restrict 关系并删除项目。仍在排队或执行的任务返回 `409 PROJECT_BUSY`，任务结束后可以重试。

同一事务将项目持有的存储键写入独立 `project_deletion_cleanups` 表。事务提交后清除文件、读取缓存及任务进度缓存；失败或较大清单通过持久化队列继续清理。前端明确区分完成与后台清理。共享音色、共享存储前缀以及其他项目仍引用的文件保留。重复删除幂等；清理完成后队列记录也删除。

新增迁移 `20261008060000_project_deletion_cleanup` 已应用到本地数据库，当时唯一待应用迁移就是该表。正在运行的 API 已通过真实 HTTP 验证新路由；测试只创建并删除隔离空项目，未删除既有项目，未产生模型费用或创建对象存储文件。

## 已执行验证

- API 项目测试：`pnpm --filter @ai-marketing/api test src/platform/project`，28 项通过，包括各类活动任务拒绝、幂等、清理失败恢复、较大文件批次、缓存隔离和 schema 存储键覆盖检查。
- Web 相关测试：`pnpm --filter @ai-marketing/web test src/platform/project src/platform/asset/asset-v4.spec.ts`，38 项通过。
- Contracts 测试：`pnpm --filter @ai-marketing/contracts test`，98 项通过；`pnpm build:packages` 成功。
- Web 和 API 类型检查及生产构建通过。
- 修改文件 ESLint 与 `git diff --check` 通过。
- 真实 PostgreSQL 事务夹具：`node --env-file=.env apps/api/scripts/verify-project-deletion.mjs`（仓库根目录，在 API 构建后执行）。填充全部 43 张带项目作用域的业务表，建立效果/定制/裂变 Run、历史子分支、Manifest 来源 Restrict、工作副本引用和资产版本。确认全部删除，跨项目文件引用保留，返修活动拒绝，局部文件失败可恢复，重复清理租约互斥、旧 token 不能删除新清理记录、重复删除成功。所有夹具事务回滚，用户项目保留。
- 文件验收使用独立临时目录的真实 `LocalStorageAdapter`；Redis 使用随机测试项目前缀，确认删除目标项目缓存而保留其他项目缓存。未执行真实 TOS 文件删除。
- 浏览器隔离接口回归 25 项通过；1920、1440、390 宽度均无横向溢出，删除入口可见。截图为隔离测试数据：[桌面](../evidence/browser/2026-10-08-project-delete-1440.png)、[窄屏](../evidence/browser/2026-10-08-project-delete-390.png)。

## 扩大检查的已有阻塞

- `pnpm typecheck` 在 Contracts 的 `effect-segment-render.spec.ts:71` 失败：该测试使用 `import.meta.url`，其类型检查模块配置不允许 `import.meta`。生产契约构建及 98 项测试通过。
- `src/shared/action-confirmation-integration.spec.ts` 两项旧结构断言失败：仍要求已拆分的 AssetDrawer 内直接调用确认弹窗，且依赖已不存在的 Prompt 单项重生弹窗函数。项目删除由统一项目页处理确认，资产操作由 `ProjectAssetBrowser` 处理；本次没有修改效果类 Prompt 功能或这些旧断言。

这些检查失败不能记为全量通过。验证范围也不包括有进行中付费任务的强制取消或真实对象存储故障集成；当前实现会拒绝删除活动任务项目，并保留文件清理重试记录。
