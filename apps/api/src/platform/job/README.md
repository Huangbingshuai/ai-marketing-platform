# apps/api/src/platform/job

异步任务 Outbox 投递、RabbitMQ 发布与任务进度存储。Redis 进度存储复用 `../cache` 的有界共享连接；读取或写入失败时由任务服务保留既有 PostgreSQL 回退路径。Redis 中的进度不是业务权威状态，队列消息与持久化任务继续沿用现有契约。
