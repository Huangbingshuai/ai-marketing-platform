# 定制类资产准备 Worker

本服务只处理资产准备节点的 `ASSETS` 任务，消费已冻结的完整脚本及简报，整理产品、人物、场景、道具定义和图像制作要求，独立审校后保存待确认结果。资产图片生成尚未接通，不把文字资产整理当作图片渲染成功。

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
