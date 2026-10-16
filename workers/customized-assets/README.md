# 定制类资产准备 Worker

本服务处理资产准备节点的 `ASSETS`（文字整理）和 `IMAGE`（图片生成）任务，消费已冻结的完整脚本及简报，整理产品、人物、场景、道具定义和图像制作要求，独立审校后保存待确认结果。文字整理与图片生成是独立任务，不能把文字资产整理当作图片渲染成功。

新任务采用结构化流程 v2：对象识别与原文定位 → 身份对齐 → 四类对象定义 → 图片需求 → 独立审校 → 指定字段修订与复核 → 保存草稿。分类最多两路并行，每批最多6个对象；成功批次保存检查点。空类别不调用模型，单项整理只处理目标对象；已有人工字段和图片受保护。复核未通过不会在恢复时重复付费修订。历史无版本标记的任务仍走原流程。

分类请求的输出 Schema 按本批准确身份、类别和数量收紧，避免模型将上下文目录当成全部待生成对象。候选结果在业务校验前保存；历史超范围候选只允许按准确且唯一的已知身份取出本批对象，不猜测或替换身份。结构或引用不合法时最多纠错一次，成功类别继续复用，失败纠错不会在恢复时无限付费重做。

场景、人物与普通道具可提供明确美术方案，资料已知事实与设计设定分开；配套对象不能反向确定未知产品结构或制式。首次审校应一次列全同一问题涉及的字段，复核读取首次全部结论（含优化建议），继续执行事实与一致性检查。

分类定义 Schema 由 `scripts/export_contracts.py` 导出到 `packages/contracts/schemas/customized-assets-*.schema.json`，测试校验快照一致性。新增元数据为可选字段，旧资产可继续读取；图片生成已接通，视频服务仍未接通。详见[重构计划](../../docs/workflows/customized/plans/2026-10-13-资产整理结构化与局部修订.md)。

| 配置                   | 值                                               |
| ---------------------- | ------------------------------------------------ |
| Python 入口            | `python -m customized_assets.main`               |
| Compose 服务 / profile | `customized-assets-worker` / `customized-assets` |
| 队列                   | `customized.assets.requested`                    |
| 内部 API               | `/internal/workers/customized-assets/tasks/:id`  |
| 独立凭据               | `CUSTOMIZED_ASSETS_WORKER_TOKEN`                 |

API 和 Worker 使用相同资产凭据；不复用视频制作凭据。模型使用任务冻结配置；`ARK_API_KEY`、`ARK_BASE_URL`、`RABBITMQ_URL` 和 `INTERNAL_API_BASE_URL` 由环境注入。`CUSTOMIZED_ASSETS_CONCURRENCY` 默认 2，`CUSTOMIZED_ASSETS_TIMEOUT_SECONDS` 默认 300，`CUSTOMIZED_ASSETS_MAX_ATTEMPTS` 默认 2。结构化请求、检查点和租约执行复用 [共享底座](../shared/customized-production-runtime/README.md)。不安装 Docling、Torch 或视频工具，不挂载解析模型卷。

```powershell
docker compose --profile customized-assets build customized-assets-worker
docker compose --profile customized-assets up -d --no-deps customized-assets-worker
docker compose --profile customized-assets ps customized-assets-worker
uv run --project workers/customized-assets --frozen pytest workers/customized-assets/tests
uv run --project workers/customized-assets --frozen mypy workers/customized-assets/src workers/shared/customized-production-runtime/src
```

运行前确认 API 已加载新增凭据，且待更新服务没有活动任务。启动会消费真实排队任务。旧视频队列中的排队资产消息经 API Outbox 转入新队列，不借用视频 Worker 执行。当前任务相同输入的检查点和有限自动重试保留；新任务不复用旧业务结果。跨节点、旧 attempt、取消或删除项目后的回调由服务端拒绝。

本次隔离验收见[记录](../../docs/workflows/customized/evidence/2026-10-13-资产Worker隔离验收.md)。

## 图片生成

IMAGE 任务使用手动选定的固定 Seedream 5.0 Pro / Flash。每项生成一张 PNG 多视角设定图，人物包含特写与正侧背面，产品与道具呈现同一设计的多个角度，场景呈现同一空间的不同方向；软件按界面/状态适配。清晰度为 1K / 1.5K / 2K，固定画幅按官方像素表确定，智能比例使用模型原生尺寸档位；最多20项、有界并发2，并受 Worker 总并发限制。图片超时独立配置 `CUSTOMIZED_ASSET_IMAGE_TIMEOUT_SECONDS=180`。品牌文字约束参与提示词。布局来源为 Contracts 的 `src/customized-asset-image-layout.json`；Worker 包内 `asset_image_layout.json` 为该文件副本，修改后同步复制，一致性测试拒绝漂移。

单项任务可携带编辑后的提示词及最多4张固定版本参考图（PNG/JPG/WebP、每张10 MB以内），包括用户选定的资料导入品牌图和新上传图片。Worker只经本任务受保护接口读取冻结版本，核验格式/大小后在内存中转为图像模型输入，不访问客户端URL，不把Base64写入检查点或日志；读取后再次检查任务租约。历史无自定义输入的任务继续使用原提示词编译。参考图不进入资产文字整理模型，也不用于推断产品事实。

同步 Ark 请求返回 b64_json 后立即经受保护 multipart 接口保存。成功图片逐张形成检查点与项目固定版本，并关联生产草稿；用户保存修改才提交资产目录。明确429有界退避；不确定超时与非法图片停止，避免立即重发已可能计费的请求。失败恢复跳过已保存对象，取消/旧租约不接受迟到回调。

模型、尺寸和对象范围的 JSON Schema 位于 `packages/contracts/schemas/customized-image-settings.schema.json`，由 Contracts 的 `CUSTOMIZED_IMAGE_SETTINGS_SCHEMA` 导出；两端有一致性测试。无付费协议与恢复验证为 `tests/test_image_generation.py`，数据库与文件验证为 API 的 `production.database.spec.ts`。真实 Logo 输入、生图和重新生成测试见[本轮联调记录](../../docs/workflows/customized/evidence/2026-10-16-充电器资产与Logo生图付费联调.md)，单一项目结果不代表所有品类的质量保证。
