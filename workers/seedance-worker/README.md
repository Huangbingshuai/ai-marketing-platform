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
- `SEEDANCE_API_KEY`（未单独配置时可复用已有 `ARK_API_KEY`）
- `SEEDANCE_TIMEOUT_SECONDS`
- `SEEDANCE_POLL_INTERVAL_SECONDS`
- `SEGMENT_RENDER_MAX_INFLIGHT`：单个 Worker 允许同时处于创建、生成、轮询或结果传输阶段的供应商任务数，默认 20。旧的 `SEGMENT_RENDER_MAX_CONCURRENCY` 仅作为兼容回退。
- `SEGMENT_RENDER_CREATE_QPS`：创建 Seedance 任务的平滑提交速率，默认每秒 3 条。
- `SEGMENT_RENDER_DOWNLOAD_CONCURRENCY`：同时下载 Seedance 视频结果以及向内部 API 回写成品的数量，默认各 3。
- `SEGMENT_RENDER_REFERENCE_CACHE_BYTES`：商品参考图 Base64 的进程内 LRU 缓存上限，默认 128 MiB。

视频返修由 API 生成短时签名的公网参考视频地址。启用返修前，需要在 API 进程配置：

- `SEEDANCE_REFERENCE_PUBLIC_BASE_URL`：供应商能够访问的 API 公网前缀，包含全局 `/api`，例如 `https://api.example.com/api`
- `SEEDANCE_REFERENCE_SIGNING_SECRET`：至少 32 个字符的独立 HMAC 密钥

参考视频不会进入 RabbitMQ，也不会转成 Base64；Worker 只在首次创建供应商任务时获取签名 URL。供应商任务 ID 已写回后，Worker 重试只恢复轮询，避免重复创建和重复计费。

每条 Prompt 创建一个独立视频任务，供应商请求只包含 Prompt 正文、批次共用禁用约束和当前产品资料包的全部商品参考图。RabbitMQ 的 `prefetch` 与 `SEGMENT_RENDER_MAX_INFLIGHT` 保持一致，使等待 Seedance 的任务可以异步并行；创建请求、轮询和视频下载分别限速。参考图并发加载按内容哈希合并，避免多个任务同时重复读取和编码同一文件。任务恢复时如果 API 已保存 `providerTaskId`，Worker 只继续轮询原任务，不重复创建供应商任务。

这些并发参数当前按 Worker 进程生效。Compose 第一版只运行一个实例；横向扩容前必须增加账号级分布式限流，否则多个副本会叠加供应商在途数和创建 QPS。
