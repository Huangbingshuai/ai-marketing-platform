# apps/api/src/workflows/customized

`source-import` 已接入资料包文件上传；标准化提炼及后续节点尚未接入专用 API/Worker。

- `POST /projects/:projectId/workflows/customized/source-import/runs/:runId/materials`：单文件 multipart，字段 `file` 与 `section`（`BRIEF` / `VISUAL_REFERENCE`）。前端逐文件调用，支持多份文档和可选参考图片。
- 上传复用 `FileModule`、`StoragePort`、`AssetService` 和效果类共用文件验证，检查实际大小、扩展名、MIME、文件头及当前 Run 编辑权限。按原文件名与 SHA-256 幂等，同内容重试不增加版本，同名不同内容保存独立资产。
- 草稿、进入/取消编辑、保存版本和分支切换继续走共享 `WorkflowWorking` 接口。上传期间切换或取消编辑，迟到请求不能写入新 Run。移除引用或取消编辑不删除已上传的项目资产。
- 资料包固定引用 `assetId + assetVersion`。共享 `GET /projects/:projectId/assets/:assetId/versions/:version` 返回该版本预览/下载 URL，对应 `/content` 读取原文件，历史资料包不自动跟随新资产版本。
- 显式保存版本前检查草稿 revision、固定文件版本的归属与可读取性，再在既有事务中确认 `customized-source-package`。无变化不增加业务 revision、不发布空分支。

业务边界见[定制类指南](../../../../../docs/workflows/customized/agent-guide.md)。隔离真实接口验证：在仓库根目录运行 `node apps/api/scripts/verify-customized-source-import.mjs`；默认 API 地址 `http://localhost:3100/api`，可用 `CUSTOMIZED_VERIFY_API_URL` 覆盖。脚本只创建、上传和清理随机测试项目，不调用生成任务。

验证脚本依赖项目异步删除 API 清理测试文件，执行前会检查该能力；未启用时直接退出，不创建测试数据。资料上传与版本管理本身不依赖项目删除功能。
