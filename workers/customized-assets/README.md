# 定制类资产准备 Worker

本服务只处理资产准备节点的 `ASSETS` 任务，消费已冻结的完整脚本及简报，整理产品、人物、场景、道具定义和图像制作要求，独立审校后保存待确认结果。资产图片生成尚未接通，不把文字资产整理当作图片渲染成功。

新任务采用结构化流程 v2：对象识别与原文定位 → 身份对齐 → 四类对象定义 → 图片需求 → 独立审校 → 指定字段修订与复核 → 保存草稿。分类最多两路并行，每批最多6个对象；成功批次保存检查点。空类别不调用模型，单项整理只处理目标对象；已有人工字段和图片受保护。复核未通过不会在恢复时重复付费修订。历史无版本标记的任务仍走原流程。

分类请求的输出 Schema 按本批准确身份、类别和数量收紧，避免模型将上下文目录当成全部待生成对象。候选结果在业务校验前保存；历史超范围候选只允许按准确且唯一的已知身份取出本批对象，不猜测或替换身份。结构或引用不合法时最多纠错一次，成功类别继续复用，失败纠错不会在恢复时无限付费重做。

场景、人物与普通道具可提供明确美术方案，资料已知事实与设计设定分开；配套对象不能反向确定未知产品结构或制式。首次审校应一次列全同一问题涉及的字段，复核读取首次全部结论（含优化建议），继续执行事实与一致性检查。

分类定义 Schema 由 `scripts/export_contracts.py` 导出到 `packages/contracts/schemas/customized-assets-*.schema.json`，测试校验快照一致性。新增元数据为可选字段，旧资产可继续读取；图片与视频服务未接通。详见[重构计划](../../docs/workflows/customized/plans/2026-10-13-资产整理结构化与局部修订.md)。

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
