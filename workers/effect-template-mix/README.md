# 效果类模板混剪 Worker

新包装协议在同一次任务内恢复缺失步骤，`TEMPLATE_MIX_PACKAGING_STEP_RETRY_ATTEMPTS=2` 控制每环节额外尝试次数，`TEMPLATE_MIX_PACKAGING_ITEM_TIMEOUT_SECONDS=2400` 包含所有重试等待。检查点持久化预算，Worker 重启不重置。明确未连接的配音使用独立8次/600秒预算；响应不明不重复计费。逐条 READY 经 API 原子提交后即可预览，最终失败或取消保留包装前全部轨道，用户界面不再提供包装恢复入口。再次整批包装为新子 Run，单条及 APPEND 包装原位执行，历史任务不因升级自动重试。

包装口播以整条成片为创作单位，按真实播放顺序统一主线、说话视角及信息递进，再输出每槽独立的完整口播，不逐镜重新介绍商品。缺失文案恢复、结构修正、真实配音超时缩句/重策划同样接收只读整片画面与既有邻句；只能改本次目标槽位，不补回用户删除的口播、不调整空槽或未修改轨道。商品声明只来自确认事实，衔接不能虚构连续动作或因果；不引入产品关键词特例、固定名称次数或额外语义审核请求。配音、字幕仍以素材边界和真实时间戳独立保存。历史成功结果不自动重生成。调研、实施与验证边界见[整片口播连贯性修复](../../docs/workflows/effect/plans/2026-10-11-智能包装整片口播连贯性修复.md)。

新生成的包装口播默认独立音量为 `2.0`（200%，约 +6 dB），通过原音频字段同时用于预览和导出，不改写 PCM、字幕时间或配乐音量，不随口播自动压低其他轨道。已保存、人工调整或恢复复用的音量保持原值；升级不批量改动历史工程。

本 Worker 负责模板混剪节点的异步智能填充，不负责最终视频编码。输入是 API 固定的同项目、同效果类 Run 模板快照、已确认 Prompt 和可用视频素材；RabbitMQ 消息只传 Run 标识。Worker 经受保护接口领取租约并保持心跳。

```text
原始 Prompt 与六槽位 → AI 归槽评分 → 唯一素材匹配
→ 视频抽帧 → AI 选择截取起点 → API 保存时间轴草稿
```

分类只向模型提供六槽位语义和原始 Prompt，不使用上游推荐用途。首次与重新智能填充必须完整覆盖六槽位，单条成片的非空素材互不相同；模板时长权威，模型只选择合法的源视频截取起点。完整成功并通过 API 校验后自动提交模板和时间轴工作副本，不另需人工“完成校验”。已完成分片写入同 Run 检查点，重领后只补缺失项。算法批量组合复用有效的归槽与截取结果，不再次为每条组合支付 AI 截取费用。

同一次冻结任务中，重复选用的素材只下载、抽帧并记录采样一次；APPEND 每条成片的独立截取和检查点仍分别处理，不合并不同槽位或已完成的不同起点。复用不跨任务、来源版本或 attempt；下载/抽帧和选区沿现有并发上限执行，失败时等待子协程退出再清理临时文件。下载断连使用有界连接恢复，不启动新任务或重做已完成选区；持续连接故障与素材内容不合法分别提示。

内部 API 连接恢复默认最多 20 次、单请求总窗口 600 秒，退避最长 30 秒；分别由 `TEMPLATE_MIX_API_RECOVERY_MAX_ATTEMPTS`、`TEMPLATE_MIX_API_RECOVERY_TIMEOUT_SECONDS`、`TEMPLATE_MIX_API_RECOVERY_MAX_DELAY_SECONDS` 配置。下载及幂等 GET/PUT 可恢复，POST 仅在明确尚未建立连接时重试；响应丢失的付费操作不盲目重放。权限、租约、来源冲突、文件不存在及超大文件不重试，取消可立即中断等待。超出窗口仍按原任务失败/租约恢复规则处理，不承诺永久断网成功。

包装配音连接恢复按单个请求独立计数：`TEMPLATE_MIX_PACKAGING_TTS_CONNECTION_MAX_ATTEMPTS=8`、`TEMPLATE_MIX_PACKAGING_TTS_CONNECTION_TIMEOUT_SECONDS=600`、`TEMPLATE_MIX_PACKAGING_TTS_CONNECTION_MAX_DELAY_SECONDS=30`。仅连接未建立的错误自动重发，5秒起指数退避；等待不占配音并发，每次尝试检查租约及取消。预算耗尽显示明确的配音连接原因，不叠加成片级重试；读写或响应中断无法确认是否计费时停止自动重发。已保存口播和音乐保留。视觉结构错误按组缩小，单槽格式纠正最多一次，验证成功的分组即时保存检查点。

用户明确要求恢复失败的新冻结协议 APPEND 时，可调用现有任务路径下的 `POST ai-fill-runs/:runId/retry`。API 锁定原任务及节点，确认工程/人工归槽未变、冻结文件有效且无其他填充或包装任务，重新投递同一 Outbox；保留冻结输入、尝试历史及全部成功检查点。取消、历史协议或冲突任务不能用此入口覆盖现有工程。

只有服务端新协议局部 APPEND 快照的 `emptySlotPolicy=ALLOW_EMPTY_POOLS` 允许没有合法候选的槽位明确留空；每条追加成片仍须采用至少一条新增素材，不得全空或主动空置有候选的槽位。Worker 只对真实选中素材抽帧、选区与回写，不为 `intentionallyEmptySlotIds` 伪造素材或截取结果。包装按画面实际时间及 `slotId` 处理非空槽，跳过空槽且保留原总时长；旧快照缺少策略字段时继续严格完整校验。

本地配置见根目录 `.env.example`。真实模式必须设置 `ARK_API_KEY`、模型和独立 `EFFECT_TEMPLATE_MIX_WORKER_TOKEN`，缺少凭据会明确失败，不会静默 Mock。Docker 启动：

```powershell
docker compose --profile effect-template-mix up -d --build effect-template-mix-worker
docker compose logs --tail 100 effect-template-mix-worker
```

源码验证（Python 3.12 与 uv）：

```powershell
Set-Location workers/effect-template-mix
uv sync --dev
uv run pytest
uv run mypy src
```

详细业务与草稿/工作副本边界见 [效果类指南](../../docs/workflows/effect/agent-guide.md) 和 [正式前端实施方案](../../docs/workflows/effect/plans/效果类模板混剪-正式前端实施方案.md)。
