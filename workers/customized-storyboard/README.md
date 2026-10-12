# 定制类分镜创作 Worker

独立 Python 消费者，消费 API 冻结的已确认信息卡。通过受保护内部 API 保存检查点、逐份发布脚本，永不直连数据库。一次批次包含 1–5 份脚本，一份成功即可使用；失败恢复不覆盖已发布结果。

## 运行

仓库根目录设置 API / Worker 相同的 `CUSTOMIZED_STORYBOARD_WORKER_TOKEN` 和真实 `ARK_API_KEY`，数据库应用 `20261012090000_customized_storyboard` 迁移。然后：

```powershell
docker compose --profile customized-storyboard build customized-storyboard-worker
docker compose --profile customized-storyboard up -d customized-storyboard-worker
docker compose logs --tail 30 customized-storyboard-worker
```

启动消费者可能执行队列中的真实付费任务；不要用生产队列做免费模拟验收。更新容器前核实没有活动任务。镜像只安装 aio-pika、httpx、Pydantic 和共享请求包，不安装 Torch、Docling、浏览器或视频工具。

API 冻结模型名称：创意 / 故事 / 审校默认 `doubao-seed-2-1-pro-260915`，资产定义 / 镜头细化默认 `doubao-seed-2-1-turbo-260628`。事实或故事修订用 Pro，纯结构修订用 Turbo。部署配置为 `CUSTOMIZED_STORYBOARD_CREATIVE_MODEL` / `CUSTOMIZED_STORYBOARD_DETAIL_MODEL`，不修改效果类配置，不静默降级。

| Worker 配置                             | 默认值                            |
| --------------------------------------- | --------------------------------- |
| `INTERNAL_API_BASE_URL`                 | Compose 中跟随 `API_PORT`         |
| `RABBITMQ_URL`                          | Compose 中复用 RabbitMQ           |
| `CUSTOMIZED_STORYBOARD_QUEUE`           | `customized.storyboard.requested` |
| `CUSTOMIZED_STORYBOARD_CONCURRENCY`     | 2，覆盖所有阶段；单实例限制 1–4   |
| `CUSTOMIZED_STORYBOARD_TIMEOUT_SECONDS` | 300                               |
| `CUSTOMIZED_STORYBOARD_MAX_ATTEMPTS`    | 2，范围 1–3                       |

## 执行与恢复

八阶段为快照、构思、故事、资产目录、镜头、审校、修订、保存。故事按不超过 30 秒的段落拆镜，传递完整故事和对象目录，并持久化每个成功分片。每份脚本总时长与目标允许最多 1 秒偏差。品牌图片仅存在输入版本引用，不发送给模型。

90 秒租约，每 20 秒心跳；API 每 30 秒检查过期任务，自动恢复最多 3 次领取，之后保留结果并显示失败。取消 / 来源变化 / 项目删除 / 旧 attempt 回调不能发布结果。用户恢复同任务复用成功阶段；再次创作建立新批次。

审校为独立请求；存在问题最多一次修订和一次独立复核。复核仍有 ERROR 时保留完整检查点，不发布。恢复不会反复付费修订该结果，应调整本次设置重新创作。日志仅记录阶段、模型、token 用量、耗时及错误类型，不输出 Prompt、正文和密钥。

## 验证

在本目录运行：

```powershell
uv sync --frozen
uv run pytest
uv run mypy src
```

测试适配器仅在测试中注入，不存在缺配置后转为 Mock 的生产分支。覆盖食品、护肤品、电子、家居及软件输入，1 / 3 / 5 份与 15 / 30 / 180 秒；这些证明结构、隔离和恢复，不证明真实创意质量或供应商模型可用性。

根目录设置 `CUSTOMIZED_STORYBOARD_DATABASE_TEST=1` 后运行 `pnpm --filter @ai-marketing/api exec vitest run src/workflows/customized/storyboard` 可验证真实 PostgreSQL 分支事务。再设置 `CUSTOMIZED_STORYBOARD_HTTP_TEST=1` 可执行真实 API 与 Python 跨层验证：需先启动 API、配置同一独立 Token，并安装本目录 Python 环境；模型适配器仅在测试进程注入，测试禁止投递 Outbox，结束清理随机项目。

跨层验收见[记录](../../docs/workflows/customized/evidence/2026-10-12-分镜生成验收.md)，脚本 JSON Schema 见 [Contracts](../../packages/contracts/schemas/customized-storyboard-script.schema.json)。
