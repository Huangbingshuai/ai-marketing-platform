# apps/api/src/workflows/customized

`source-import` 已接入资料包文件上传；`information-extraction` 已接通独立 API / Worker、编辑与版本确认。分镜及后续生成仍未接通。

- `POST /projects/:projectId/workflows/customized/source-import/runs/:runId/materials`：单文件 multipart，字段 `file` 与 `section`（`BRIEF` / `VISUAL_REFERENCE`）。前端逐文件调用，支持多份文档和可选品牌素材图片。保留区域标识与 schemaVersion 3；图片用途新增 LOGO / WORDMARK / BRAND_GRAPHIC / BRAND_IP / PACKAGING，旧用途保持可读取、保存和历史回溯，不自动迁移或增加 revision。
- 上传复用 `FileModule`、`StoragePort`、`AssetService` 和效果类共用文件验证，检查实际大小、扩展名、MIME、文件头及当前 Run 编辑权限。按原文件名与 SHA-256 幂等，同内容重试不增加版本，同名不同内容保存独立资产。
- 草稿、进入/取消编辑、保存版本和分支切换继续走共享 `WorkflowWorking` 接口。上传期间切换或取消编辑，迟到请求不能写入新 Run。移除引用或取消编辑不删除已上传的项目资产。
- 资料包固定引用 `assetId + assetVersion`。共享 `GET /projects/:projectId/assets/:assetId/versions/:version` 返回该版本预览/下载 URL，对应 `/content` 读取原文件，历史资料包不自动跟随新资产版本。
- 显式保存版本前检查草稿 revision、固定文件版本的归属与可读取性，再在既有事务中确认 `customized-source-package`。无变化不增加业务 revision、不发布空分支。

业务边界见[定制类指南](../../../../../docs/workflows/customized/agent-guide.md)。隔离真实接口验证：在仓库根目录运行 `node apps/api/scripts/verify-customized-source-import.mjs`；默认 API 地址 `http://localhost:3100/api`，可用 `CUSTOMIZED_VERIFY_API_URL` 覆盖。脚本只创建、上传和清理随机测试项目，不调用生成任务。

信息提炼接口前缀为 `projects/:projectId/workflows/customized/information-extraction`：GET 工作区（`workflowRunId`）、POST `tasks`、GET `tasks/:taskId` / `tasks/:taskId/nodes/:nodeId`、POST `tasks/:taskId/retry`、POST `edit` / `cancel-edit`、PUT `results/:resultId`、POST `results/:resultId/confirm`。草稿与确认携带 `expectedRevision`，创建携带幂等键及明确的来源 artifactId / revision。Worker 内部接口位于 `internal/workers/customized-extraction/tasks/:taskId`，使用独立共享 Token 和 attempt token，快照文件仅经受保护接口读取。

任务、步骤、结果、解析产物和文件持有记录存储在独立定制提炼表。来源冻结已确认资料包；品牌图片只保留引用。AI 完成保存待确认结果，只有保存版本才提交 `customized-brief`。已确认内容编辑使用隐藏 Run，同内容不增长业务 revision、不发布分支；取消清理隐藏执行，拒绝旧回调。任一文档失败禁止确认，重试保留同任务成功检查点。同来源保留人工覆盖，资料版本变化清除旧覆盖。已完成工作区通过现有 Redis 投影缓存读取，运行任务绕过缓存；正文和签名 URL 不缓存。

无付费验证位于本目录 `information-extraction/*.spec.ts`。数据库用例启用 `CUSTOMIZED_EXTRACTION_DATABASE_TEST=1`；真实 HTTP / Redis / 本地文件协议用例启用 `CUSTOMIZED_EXTRACTION_HTTP_TEST=1`，禁用后台分发，仅操作随机隔离项目。

验证脚本依赖项目异步删除 API 清理测试文件，执行前会检查该能力；未启用时直接退出，不创建测试数据。资料上传与版本管理本身不依赖项目删除功能。
