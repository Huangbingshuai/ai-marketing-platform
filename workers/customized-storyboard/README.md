# 定制类分镜创作 Worker

独立 Python 消费者，消费 API 冻结的已确认信息卡。通过受保护内部 API 保存检查点、逐份发布脚本，永不直连数据库。一次批次包含 1–5 份脚本，一份成功即可使用；失败恢复不覆盖已发布结果。

## 运行

仓库根目录设置 API / Worker 相同的 `CUSTOMIZED_STORYBOARD_WORKER_TOKEN` 和真实 `ARK_API_KEY`，数据库应用 `20261012090000_customized_storyboard` 与 `20261012140000_storyboard_automatic_recovery` 迁移。然后：

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

八阶段为快照、构思、故事、资产目录、镜头、审校、修订、保存。新任务的连续故事段落合并为不超过 60 秒的请求（故事原段落仍不超过 30 秒），完整保留段落内容，传递完整故事、对象目录及相邻镜头，减少重复请求。分片计划在调用前固定，每个成功分片立即持久化；历史已有固定计划或无固定计划的分片均沿用原边界，避免部署后重做已付费内容。每份脚本总时长与目标允许最多 1 秒偏差。品牌图片仅存在输入版本引用，不发送给模型。

90 秒租约，每 20 秒心跳；API 每 30 秒检查过期任务，自动恢复最多 3 次领取，之后保留结果并显示失败。取消 / 来源变化 / 项目删除 / 旧 attempt 回调不能发布结果。用户恢复同任务复用成功阶段；再次创作建立新批次。

模型请求按配置有限重试；持续超时、限流及暂时服务故障由任务再退避 15 / 30 秒，仅恢复发生暂时错误的方案，任务总计最多领取 3 次。已发布脚本和成功阶段不重做，永久错误、非法业务结果及审校未通过不无限重试。受保护 API 的网络 / 429 / 5xx 最多重试 6 次且总预算 40 秒；401 / 404 / 409 立即停止，重发保持相同 attempt 和正文。

模型已返回但分片时长、镜头标识或资产引用不合法时，先保存未采用结果，再携带具体结构问题纠正一次。纠正次数随检查点持久化，进程重启不能重置预算。此纠正只验证结构，不以代码猜测语义。

完整故事阶段同样保存未通过的原稿及具体结构问题；总时长、段落上限或 ID 不合法时，模型只修正段落列表一次，完整故事正文保持原样。暂时故障后继续纠正已有稿件，不重新创作故事；纠正后仍不合法则保留失败结果，恢复不能重置预算。已返回的有效修正也先保存再标记阶段成功，防止中间断连重复付费。

审校为独立请求；存在问题最多一次修订和一次独立复核。复核仍有 ERROR 时保留完整检查点，不发布。恢复不会反复付费修订该结果，应调整本次设置重新创作。日志仅记录阶段、模型、token 用量、耗时及错误类型，不输出 Prompt、正文和密钥。

审校及复核的结构化输出 Schema 将可引用镜头 ID 收紧为当前完整脚本的准确枚举。请求层验证并按原有有限预算重试无效响应，避免把“镜头一”等临时名称当作稳定引用；不以代码猜测问题对应镜头，不改变问题严重程度，也不删除问题来凑成成功。

审校、修订和复核同时接收代码计算的完整镜头累计时间轴，辅助核对概述、结构与实际镜头的先后关系。时间计算不改变镜头或业务 revision，事件含义与修改仍由模型判断。长脚本速度及两产品真实付费记录见[性能验收](../../docs/workflows/customized/evidence/2026-10-12-分镜性能优化付费验收.md)。

修订模型仍阅读完整脚本、简报和审校问题，只返回有类型的变更字段及必要的增删镜头，不重复输出正常内容。Worker 校验身份、重复修改、对象引用及总时长，在原稿副本上应用，生成真实前后对照，再将完整修订稿送独立复核。补丁先保存，合成稿再保存；复核临时失败后恢复不重新购买修订，非法补丁也不会因重启无限付费重做。旧的完整修订检查点继续可恢复，API 和前端的完整稿与修订展示契约不变。

## 验证

在本目录运行：

```powershell
uv sync --frozen
uv run pytest
uv run mypy src
```

测试适配器仅在测试中注入，不存在缺配置后转为 Mock 的生产分支。覆盖食品、护肤品、电子、家居及软件输入，1 / 3 / 5 份与 15 / 30 / 180 秒；这些证明结构、隔离和恢复，不证明真实创意质量或供应商模型可用性。

根目录设置 `CUSTOMIZED_STORYBOARD_DATABASE_TEST=1` 后运行 `pnpm --filter @ai-marketing/api exec vitest run src/workflows/customized/storyboard` 可验证真实 PostgreSQL 分支事务。再设置 `CUSTOMIZED_STORYBOARD_HTTP_TEST=1` 可执行真实 API 与 Python 跨层验证：需先启动 API、配置同一独立 Token，并安装本目录 Python 环境；模型适配器仅在测试进程注入，测试禁止投递 Outbox，结束清理随机项目。

跨层验收见[记录](../../docs/workflows/customized/evidence/2026-10-12-分镜生成验收.md)，真实模型验收见[付费记录](../../docs/workflows/customized/evidence/2026-10-12-分镜真实付费验收.md)，脚本 JSON Schema 见 [Contracts](../../packages/contracts/schemas/customized-storyboard-script.schema.json)。

真实模型验收脚本为 `apps/api/scripts/verify-customized-storyboard-paid.mjs`。从根目录显式设置 `CUSTOMIZED_STORYBOARD_PAID_TEST=1`，提供已确认资料所在的 `--project` / `--run` 及独立 `--manifest`，再设置 `--seconds`、`--count`、`--mode`。再次使用同一 manifest 仅恢复观察；附加 `--retry` 才恢复终态未完成任务。日志统计 token 与耗时，实际费用以供应商账单为准。

同输入修订性能重放入口为 `scripts/verify_paid_repair.py <本地输入JSON> <本地结果JSON>`，同样要求付费开关及真实 Ark 环境变量。输入包含冻结的 `input`、原始 `script` 与 `review`，只在本地保存补丁、完整修订稿和复核，不修改历史 API 任务。结果文件可恢复，不能把已保存修订的恢复耗时当作首次修订耗时。文档及结果正文不要加入运行日志。

## 脚本 / 资产 / 视频制作拆分（2026-10-12）

新建脚本任务使用 STORY_ONLY：完整故事成功后发布，不在脚本任务中拆资产和镜头。已有不带 outputMode 的任务继续按历史步骤恢复。

新增独立 `customized-production-worker`，代码共用本目录轻量 Python 包，入口为 `python -m customized_storyboard.production_main`，队列为 `customized.production.requested`，使用独立 `CUSTOMIZED_PRODUCTION_WORKER_TOKEN`，无 Docling/Torch/视频运行时和解析模型卷。

```powershell
docker compose --profile customized-production --profile customized-storyboard build customized-production-worker customized-storyboard-worker
docker compose --profile customized-production --profile customized-storyboard up -d --no-deps customized-production-worker customized-storyboard-worker
docker compose --profile customized-production ps customized-production-worker
```

启动前核对 API 已加载同一 Token，以及无等待/活动任务；启动消费者会消费已有消息。API 使用 `pnpm dev:api`，构建不等于运行进程已更新。首次部署先执行对应数据库 migration。

制作操作为 ASSETS / SHOTS / PROMPT。六个持久化步骤为 SNAPSHOT、PLAN、GENERATE、REVIEW、REPAIR、SAVE；无审校问题时 REPAIR 记录无需修订。长分镜按最多60秒的段落、有界并发2生成，每个成功片段单独保存；恢复复用同任务检查点。每镜 Prompt 仅接收绑定子集。图片字段只保存引用，不送视觉模型。本次不生成图片或视频。

资产结果包含图像制作要求（imageRequirements），这只是后续图片的视角/状态/细节需求。产品、人物、场景、道具分别维护公共定义；Prompt 的引用集合必须等于本镜已确认绑定。AI结果经独立审校；仍有未解决问题不提交。

受控验证：

```powershell
uv run --project workers/customized-storyboard pytest workers/customized-storyboard/tests
uv run --project workers/customized-storyboard mypy workers/customized-storyboard/src/customized_storyboard
$env:CUSTOMIZED_PRODUCTION_DATABASE_TEST='1'
pnpm --filter @ai-marketing/api exec vitest run src/workflows/customized/production/production.database.spec.ts --maxWorkers=1
```

数据库测试创建随机隔离项目并清理，仅使用受控输出，不发送模型任务。Schema 文件位于 packages/contracts/schemas/customized-production-*.schema.json，通过 Python 一致性测试核对。实际模型质量和耗时需单独付费测试，不将受控结果当成真实生成。
