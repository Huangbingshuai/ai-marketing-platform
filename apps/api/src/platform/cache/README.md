# 工作流只读投影缓存

PostgreSQL 是权威来源。`EffectCacheRevisionService` 在同一个 SQL 快照中解析 Effect Run 和依赖表版本；`EffectReadCacheService` 复用现有 Redis 连接缓存 JSON 只读投影。六节点的业务提交、revision、任务进度和 HTTP 契约不由缓存管理。

定制类资料导入复用以上服务，覆盖 `customized-overview`、`customized-import-draft` 和 `customized-tree`。作用域必须显式指定 `CUSTOMIZED`，数据库同时核对 `CUSTOMIZED_PROJECT`；键的工作流段区分效果类和定制类。同项目的效果类变化不会使定制类投影换键。定制类 Run 的导航和更新时间包含在版本中，活动概览不能复用忽略导航时间的效果类业务策略。

`customized-cache-policy.ts` 只允许无历史文字的 schemaVersion 3 文件引用草稿和仅包含该草稿的活动概览入缓存；历史文字、其他节点和未知字段保持原响应但不写 Redis。版本树由明确字段构造，不含草稿或工作副本正文。固定资产版本元数据、文档和图片内容仍经原接口读取，保存版本时仍验证真实文件。

## 新鲜度

- 每次命中仍校验项目存在性和数据库版本；命中、共享等待、加载完成及发布后均复核版本。检测到变化丢弃旧结果，最多重新尝试两次，持续变化时执行新的数据库读取。
- 缓存键包含项目、工作流、Run、资源、业务参数哈希及版本。参数哈希包含缓存协议版本 `3`，允许新旧进程在部署期间使用不同键；不需要清空共享 Redis。
- 活动任务、未知作用域或无法验证的版本直接走业务读取。读取之后发生的新提交仍需下一次读取/现有轮询发现；这不是推送机制，也不保证绝对零延迟。
- 原始文档、二进制内容、签名 URL 不缓存。条目有大小限制、协议版本和校验和；失败回源。

## 并发与故障

- **穿透**：项目检查不跳过；有效作用域的空投影可缓存。仅 `prompt-result` 明确的 `ASSET_NOT_FOUND` 使用 4–5 秒负缓存，仍逐次校验版本，结果创建后立即使用新键。权限、项目不存在、未知 Run、数据库错误不负缓存。
- **击穿**：相同版本同进程合并加载，Redis 不可用时仍生效。跨进程回填使用 30 秒租约和随机 token；Lua 检查锁归属后原子发布。锁被替换的旧请求不能写入或删除新锁。等待其他进程最多 3 次、每次 25ms，之后受本进程限制直接回源，避免故障锁阻塞恢复。
- **雪崩**：正常 TTL ±10% 抖动，单进程最多 128 个不同键的在途回填；超限返回 503，不建立无限队列。连接失败按代次熔断 4–6 秒，避免多实例同步重连；旧连接超时不能在恢复后重放命令或关闭新连接。
- 上限只保护此投影的重型回填；权限/版本检查和活动任务读取仍访问数据库，多实例总并发仍需结合部署容量管理。不以旧数据回退换取可用性。

## 验证

`effect-read-cache.service.spec.ts`、`effect-cache-revision.service.spec.ts`、`redis-connection.service.spec.ts` 覆盖并发、新鲜度、TTL 与错误回退。设置 `EFFECT_CACHE_DATABASE_TEST=1` 后，`effect-cache.database.spec.ts` 和 `effect-cache.http.spec.ts` 使用独立随机项目、测试命名空间和真实 PostgreSQL/Redis；不停止共享 Redis、不运行 Worker。

`diagnostics()` 保留最多 500 条无正文性能样本。`scripts/verify-effect-read-cache.mjs` 对比真实 HTTP 返回与 Redis 内容哈希、版本和 TTL；`scripts/measure-effect-read-cache.mjs` 测量只读请求。运行方式见脚本头注释。

定制类真实 HTTP 验证设置 `CUSTOMIZED_CACHE_DATABASE_TEST=1` 后运行 `customized-cache.http.spec.ts`。使用随机项目、独立 Redis 命名空间和临时本地存储，禁用后台调度；覆盖两轮保存、无变化保存、隔离编辑/取消/发布、切换/恢复、迟到读、历史正文不入缓存、测试命名空间清理和 Redis 故障回源。
