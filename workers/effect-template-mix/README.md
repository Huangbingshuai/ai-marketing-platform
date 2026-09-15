# 效果类模板混剪 Worker

本 Worker 负责模板混剪节点的异步智能填充，不负责最终视频编码。输入是 API 固定的同项目、同效果类 Run 模板快照、已确认 Prompt 和可用视频素材；RabbitMQ 消息只传 Run 标识。Worker 经受保护接口领取租约并保持心跳。

```text
原始 Prompt 与六槽位 → AI 归槽评分 → 唯一素材匹配
→ 视频抽帧 → AI 选择截取起点 → API 保存时间轴草稿
```

分类只向模型提供六槽位语义和原始 Prompt，不使用上游推荐用途。每条成片的六个素材必须互不相同；模板时长权威，模型只选择合法的源视频截取起点。已完成分片写入同 Run 检查点，重领后只补缺失项。智能填充结果只有用户在页面“完成校验”后才变成模板和时间轴工作副本。算法批量组合复用有效的归槽与截取结果，不再次为每条组合支付 AI 截取费用。

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
