# 效果类工作流-AI 视频片段批量渲染节点后端最小闭环实施方案

- 当前状态：第一版并发调度已完成，待真实 Seedance 凭据联调
- 创建时间：2026-09-03

## 目标与范围

本次实现效果类工作流第 04 步“AI 视频片段批量渲染”的后端最小闭环：读取第 03 步已确认的 Prompt 批次工作副本，为每条可渲染 Prompt 建立一个独立异步任务，经 Seedance 适配器创建并轮询视频任务，将成品文件写入项目对象存储，最后由用户显式校验并提交渲染素材片段集合工作副本。

本次覆盖：

- `packages/contracts`：页面、API 与 Worker 共用的渲染批次、任务、状态和内部回写契约。
- `apps/api`：项目隔离、上游快照校验、幂等创建、Outbox、任务租约、进度与失败回写、文件持久化、素材池校验提交。
- `apps/api/prisma`：渲染批次与逐 Prompt 任务持久化模型及迁移。
- `workers/seedance-worker`：RabbitMQ 消费、API claim/heartbeat/complete/fail、Seedance 供应商适配和显式测试 Mock。
- 本地开发配置：队列、Worker Token、Seedance 模型与 Compose profile。

## 非目标

- 不修改已冻结的渲染节点页面视觉与交互，不在本次把前端 Mock Service 切换到真实 API。
- 不实现外部视频导入、删除、取消、批量导出、正式资产归档和模板混剪。
- 不实现多个视频供应商的成本/质量路由；首版只保留供应商适配器边界。
- 不把一条 Prompt 拆成多镜头，也不在本节点合成完整成片。
- 不把创意主线或六维信息拼接进供应商提示词，也不根据六维生成图片引用计划。
- 不为主图、细节图、场景图做人为分配；第一版把当前产品资料包内全部受支持商品图片作为等价参考图交给每一条 Prompt。

## 节点边界与工作副本

1. 直接业务上游是 `PROMPT_GENERATION` 节点已确认且 `CURRENT + AVAILABLE` 的 `prompt-batch:{productId}` 工作副本；参考图同时读取 `SOURCE_IMPORT` 当前 `source-package:{productId}` 的全部 `PRODUCT_IMAGE` 文件。
2. 创建批次时冻结 Prompt 上游 `artifactId + revision + contentHash`，并为每条 Prompt 冻结 `promptId + promptContentHash + render request + 全部参考图文件 ID/哈希`。参考图快照进入每条任务，但图片二进制和 Base64 不落业务表。
3. 页面筛选、选择和弹窗不是后端工作副本内容；任务进度、重试次数、错误和输出文件是服务端权威运行状态。
4. 一条 Prompt 固定对应一个 `EffectSegmentRenderTask` 和一个当前素材版本；人工重生成增加素材版本，不改变 Prompt 稳定 ID。
5. 用户点击“完成校验”后提交：
   - 每个完成任务一个 `render-clip:{taskId}` 文件工作副本；
   - 每个产品一个 `render-batch:{productId}` 结构化工作副本，关联当前全部完成文件。
6. 两类工作副本都记录所消费 Prompt 批次的精确 `artifactId + revision + contentHash`。内容指纹未变化时不增加工作副本 revision。
7. 渲染素材工作副本确认变化后，只由既有 WorkingArtifact 依赖机制把已经存在且消费旧 revision 的模板混剪结果标记为 `STALE`。

## API 与异步状态

- 用户 API：读取产品渲染工作区、启动整批、读取单批次、单条/批量重生成、完成校验。
- 启动整批必须携带稳定幂等键和预期 Prompt 工作副本 revision；同键同请求重放返回原批次，同键异请求冲突。
- 同一 `projectId + workflowRunId + productId` 同时只允许一个活动渲染批次，由数据库部分唯一索引保证。
- RabbitMQ 消息只包含 `schemaVersion + projectId + runId(taskId) + requestId`，完整 Prompt 与请求快照由 Worker claim 后读取。
- 一次批次可创建 1～100 个逐 Prompt 任务。单实例 Worker 以 `prefetch = SEGMENT_RENDER_MAX_INFLIGHT` 限制供应商在途任务，默认允许 20 条同时处于创建、生成或结果传输阶段；创建 Seedance 任务另以 `SEGMENT_RENDER_CREATE_QPS` 平滑限速，默认每秒 3 条；视频结果下载另以 `SEGMENT_RENDER_DOWNLOAD_CONCURRENCY` 限制，默认 3 条。不得再用一个并发 3 的槽位覆盖任务完整生命周期。
- 任务状态覆盖 `QUEUED / RUNNING / COMPLETED / FAILED`；对外把重新排队且有重试次数的任务展示为 `AUTO_RETRY`。
- Worker 使用 attempt token 与 90 秒租约；旧 attempt、过期租约和旧素材版本不得覆盖新结果。
- claim 必须返回已保存的 `providerTaskId`；租约恢复或可重试故障后，有供应商任务 ID 的任务只能恢复轮询和下载，不能再次创建 Seedance 任务。创建请求结果未知时不自动重发，避免重复计费。
- 可重试错误最多自动重试两次；达到上限后保留安全错误码与中文错误摘要，批次允许部分失败。
- 缺失真实 Seedance 配置时默认失败；Mock 只能在隔离测试队列上显式启用。

## 文件与安全

- Worker 从供应商临时地址下载视频后，通过受保护的内部 multipart 回写接口上传，不把供应商临时 URL 保存到业务表或日志。
- Worker 只在持有有效 attempt token 时通过内部文件接口读取冻结的参考图，并按火山方舟 `image_url + reference_image` 结构转换为 Base64 data URI；参考图内容不进入 RabbitMQ、数据库 JSON 或日志。Worker 使用按内容哈希的有界缓存，避免同一批 50～100 条任务重复读取和编码相同商品图片。
- API 计算上传文件 SHA-256，通过现有 `StoragePort` 写入项目存储并登记 `FileObject`；页面只通过现有项目级文件内容接口访问视频。
- Worker Token、API Key、供应商响应原文、完整 Prompt 和签名 URL不得进入日志或 RabbitMQ。

## 验收标准

- 契约测试覆盖状态、任务/批次形态和 Seedance 快照字段。
- API 测试覆盖项目隔离、上游未确认/过期、幂等重放与冲突、活动批次唯一性、一 Prompt 一任务、租约、自动重试、旧版本回写、部分失败和无变化提交。
- Worker 测试覆盖队列消息校验、claim、供应商成功/失败/超时、进度回写、文件上传、显式 Mock 限制和安全错误摘要。
- 新增测试必须覆盖：供应商文本只含 Prompt 正文和一份共用禁用约束；创意主线与六维不进入请求；每条任务包含同一份全部商品图快照；Worker 为每张图生成 `reference_image`；恢复已有供应商任务时不重复 POST；50 条任务仍受本地并发上限约束。
- 运行 Prisma 校验/生成、Contracts 与 API 类型检查、定向测试、Worker `pytest`/`mypy`、相关构建和 `git diff --check`。

## 实施结果（2026-09-03）

- 已增加渲染批次、逐 Prompt 渲染任务、操作幂等回执模型及数据库迁移。
- 已增加项目级用户 API、受 Worker Token 保护的内部 API、Outbox 投递、90 秒任务租约、过期恢复、自动重试和版本化重生成。
- 已复用 Prompt 节点的批次解析与 Seedance 请求编译器；共用提示词只在冻结请求中追加一次，未复制回 Prompt 正文。
- 已增加 Seedance Worker 的真实 Ark 适配器、隔离测试 Mock、临时视频下载与内部 multipart 回写；供应商临时地址和完整响应不落库、不进队列。
- 已通过 Contracts 全量测试（23 项）、API 全量测试（263 项）、渲染 Worker 测试（6 项）、Worker mypy、全工作区类型检查、API 构建、Prisma validate/generate、Compose 配置检查、Worker 镜像构建、定向 ESLint 和 `git diff --check`。
- 未执行真实计费视频生成：当前工作区未提供可用于测试的 `SEEDANCE_API_KEY` 和 `SEEDANCE_MODEL`。部署迁移并配置真实凭据后，需要用一条已确认 Prompt 做一次端到端联调。

## 第一版真实生成调整（2026-09-07）

- 供应商提示词改为“Prompt 正文 + 一份批次共用禁用约束”，明确移除创意主线与六维拼接。
- 每条 Prompt 对应一个任务和一个视频；产品资料包内全部受支持商品图片进入每个任务的冻结参考图快照，不做主图、细节图、场景图选择计划。
- 图片按 Worker 当前有效租约从 API 读取并转换为火山方舟支持的 Base64 `image_url`，避免依赖外网可访问的对象存储 URL。
- 批量吞吐拆分为供应商在途上限、创建 QPS 和下载并发三个独立边界；默认单实例允许 20 条在途、每秒创建 3 条、同时下载 3 条。轮询使用约 8 秒间隔和按供应商任务 ID 计算的稳定抖动，避免集中请求。
- 自动重试优先复用已落库的 Seedance 任务 ID；创建结果未知不自动重发，优先避免重复生成与重复计费。
- 图片数量按模型能力校验：Seedance 2.5 最多 30 张，其他当前 Seedance 2.0 配置最多 9 张；单图严格小于 30 MiB，Base64 请求体估算超过 64 MiB 时整批拒绝，不静默丢弃图片。
- 已通过 Contracts 全量测试（24 项）、API 全量测试（272 项）、渲染 Worker 测试（13 项）、Worker mypy、全工作区类型检查、API 定向 ESLint、Compose 配置校验、Seedance Worker 镜像构建和 `git diff --check`。
- 未执行真实计费视频生成；需要配置真实 `SEEDANCE_API_KEY` 和 `SEEDANCE_MODEL` 后，先以一条 Prompt 完成端到端联调，再逐步放大并发。
- 第一版 Compose 只运行一个 Seedance Worker；如果未来横向扩容多个副本，上述上限会按副本叠加，届时必须增加 Redis 账号级分布式配额，不能直接复制 Worker。
