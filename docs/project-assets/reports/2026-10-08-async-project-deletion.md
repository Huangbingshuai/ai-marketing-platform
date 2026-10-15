# 项目异步删除 · 2026-10-08

项目资产库的删除操作已改为后台执行。确认后请求只冻结项目并持久化排队，返回 `202`；数据库关联数据、文件和项目缓存随后清理。耗时取决于数据与文件数量、存储响应及重试，尚未对大型真实项目做耗时基准。

当前项目的删除按钮禁用，提示先退出；统一项目页在确认前后再次核对，API 对请求携带的同一 `currentProjectId` 返回 `409 PROJECT_CURRENT_DELETE_FORBIDDEN`，不创建删除任务。浏览器当前绑定没有单独的服务端会话记录，该字段用于交互上下文校验，不作为权限模型。

列表显示“删除中”“清理文件”或“删除失败”。数据库项目行删除后，以队列里的最小列表快照继续显示文件清理状态；全部完成才移除，任务记录和快照一起删除。刷新能恢复后台状态，删除中不能进入或修改项目；数据库阶段失败三次后可人工重试。文件与缓存失败自动保留并重试。每批最多 40 个文件、最多 4 个并发，成功批次继续排队，失败延迟重试；服务启动及每 5 秒检查持久化队列。前端每 2.5 秒更新开放的项目列表，关闭、搜索、进入项目或卸载时停止旧轮询。

仍在执行的生成、返修或上传任务会阻止删除；后台数据库事务再次检查并锁定相关记录。不同项目的删除事务串行计算文件归属，避免同时删除两个引用同一文件的项目时漏清理。共享文件、音色样本和其他项目仍引用的文件保留。租约及 token 防止旧执行覆盖重试任务。

## 已执行验证

- `pnpm --filter @ai-marketing/api test src/platform/project`：59 项通过，涵盖活动任务、当前上下文、异步边界、失败/重启恢复、租约、文件批次、列表筛选和项目缓存隔离。
- `pnpm --filter @ai-marketing/web test src/platform/project src/platform/asset/asset-v4.spec.ts`：39 项通过。
- `pnpm --filter @ai-marketing/contracts test`：98 项通过；`pnpm build:packages` 成功。
- `pnpm --filter @ai-marketing/api typecheck`、API 和 Web 生产构建通过，Web 构建包含 Vue 类型检查。修改文件 ESLint、Prettier 及 `git diff --check` 通过。
- `node --env-file=.env apps/api/scripts/verify-project-deletion.mjs`：真实 PostgreSQL 事务填充全部 43 张项目作用域表，涵盖三类工作流、历史分支、Restrict 文件关系和资产版本；验证排队时数据保留、数据库失败/人工重试、失效租约恢复、完整关联数据清理、文件失败恢复、列表快照、其他项目及共享文件保留、完成后任务和快照移除。全部数据库夹具回滚；文件使用临时目录中的真实 `LocalStorageAdapter`，Redis 使用隔离随机项目键，未删除真实 TOS 对象。
- 正在运行的 API 实际 HTTP 验收：隔离空项目的当前上下文删除返回 409，项目仍可读取；正式提交返回 202/QUEUED/`deleted:false`，三次并发重复请求幂等，轮询最终完成，详情 404，非法 UUID 返回 400，所有原有项目保持。未调用模型，未创建存储文件。
- 浏览器隔离接口回归：32 项通过。1920、1440、390 宽度无横向溢出；覆盖当前项目保护、确认/取消、提交失败、后台状态、刷新、轮询失败、关闭停止轮询、文件阶段、完成自动移除、后台失败重试及当前项目绑定保留，无页面错误。截图为隔离测试数据：[桌面](../evidence/browser/2026-10-08-async-project-delete-1440.png)、[文件清理](../evidence/browser/2026-10-08-async-project-delete-files-1440.png)、[窄屏](../evidence/browser/2026-10-08-async-project-delete-390.png)。

增量迁移 `20261008080000_async_project_deletion` 已应用到本地数据库。应用前检查确认它是唯一待应用迁移；兼容上一版独立文件清理记录。

## 验证边界

未执行真实 TOS 故障集成、付费任务强制取消或大型项目性能基准。相关测试及构建通过不代表全仓库门禁通过：此前扩大检查存在 Contracts `effect-segment-render.spec.ts:71` 的 `import.meta` 类型配置错误，以及 `action-confirmation-integration.spec.ts` 两项旧结构断言失败，详见[前一轮记录](2026-10-08-project-deletion.md#扩大检查的已有阻塞)。本轮没有修改这些无关断言，也没有把历史结果当成本次全量检查。

本次行为替代前一版“删除当前项目后退出”与请求内数据库删除；实现范围见[异步删除计划](../plans/2026-10-08-项目异步删除.md)。
