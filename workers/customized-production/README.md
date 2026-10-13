# 定制类视频制作 Worker

本服务只处理视频制作节点的 `SHOTS`（分镜及对象绑定）和 `PROMPT`（逐镜提示词）任务，不执行资产准备的 `ASSETS` 任务。图片与视频渲染尚未接通。

| 配置                   | 值                                                       |
| ---------------------- | -------------------------------------------------------- |
| Python 入口            | `python -m customized_production.main`                   |
| Compose 服务 / profile | `customized-production-worker` / `customized-production` |
| 队列                   | `customized.production.requested`                        |
| 内部 API               | `/internal/workers/customized-production/tasks/:id`      |
| 独立凭据               | `CUSTOMIZED_PRODUCTION_WORKER_TOKEN`                     |

分镜消费已冻结脚本、简报和资产定义；单镜 Prompt 只接收本镜及已确认绑定的对象子集。生成、独立审校、定向修订和检查点语义沿用原实现。资产准备由 [独立资产 Worker](../customized-assets/README.md) 负责。

`CUSTOMIZED_PRODUCTION_CONCURRENCY` 默认 2，`CUSTOMIZED_PRODUCTION_TIMEOUT_SECONDS` 默认 300，`CUSTOMIZED_PRODUCTION_MAX_ATTEMPTS` 默认 2；模型配置冻结在任务中。Ark、RabbitMQ 和内部 API 配置由环境注入，不在日志输出正文或密钥。运行依赖 [共享底座](../shared/customized-production-runtime/README.md)，不安装文档解析或视频运行时。

```powershell
docker compose --profile customized-production build customized-production-worker
docker compose --profile customized-production up -d --no-deps customized-production-worker
docker compose --profile customized-production ps customized-production-worker
uv run --project workers/customized-production --frozen pytest workers/customized-production/tests
uv run --project workers/customized-production --frozen mypy workers/customized-production/src workers/shared/customized-production-runtime/src
```

API 必须已加载相同凭据；在无活动任务时更新服务。旧 `customized_storyboard.production_main` 仅保留兼容入口，并限制为视频制作角色，不再处理资产任务。旧队列资产消息只转交 API Outbox，不在本服务调用模型。重复终态消息只确认领取状态，不重新生成。

本次隔离验收见[记录](../../docs/workflows/customized/evidence/2026-10-13-资产Worker隔离验收.md)。
