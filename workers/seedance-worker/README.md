# Seedance 视频片段渲染 Worker

消费 `effect.segment-render.requested` 队列。Worker 只从受保护的内部 API claim 完整请求快照，通过 Seedance 适配器创建并轮询任务，下载临时视频后回传 API 持久化。

默认使用真实 `ark` Provider，缺少 `SEEDANCE_API_KEY` 时启动失败。Mock 只能显式设置 `SEGMENT_RENDER_PROVIDER=mock`，并且队列必须是隔离测试队列。

关键环境变量：

- `INTERNAL_API_BASE_URL`
- `EFFECT_SEGMENT_RENDER_WORKER_TOKEN`
- `RABBITMQ_URL`
- `EFFECT_SEGMENT_RENDER_QUEUE`
- `SEGMENT_RENDER_PROVIDER=ark|mock`
- `SEEDANCE_BASE_URL`
- `SEEDANCE_API_KEY`
- `SEEDANCE_TIMEOUT_SECONDS`
- `SEEDANCE_POLL_INTERVAL_SECONDS`
