# 定制类资产与视频制作共用执行底座

共用代码不等于共用消费者。`customized-assets` 与 `customized-production` 分别拥有入口、锁文件、镜像、队列和凭据；角色在入口固定，不通过环境变量开放任意 operation。

- `pipeline.py`：视频制作与历史资产任务的审校、修订和分片检查点；按输入版本分发新资产任务。
- `asset_pipeline.py` / `asset_models.py`：资产 v2 对象识别、四类定义、精确来源、独立审校与字段补丁；保留人工内容和任务内检查点。
- `provider.py`：结构化模型请求、有限重试、超时和有界并发；不依赖脚本 Worker 内部模块。
- `consumer.py`：角色限制、领取、心跳、取消、失败回调与旧队列资产消息转交。
- `ai_runtime.internal_api`：共用受保护 HTTP 请求，携带 attempt token，保留原有有限请求重试。

资产角色仅允许 `ASSETS`；视频角色仅允许 `SHOTS` / `PROMPT`。API 根据内部路由验证对应凭据，并在领取和每次回调再次核对任务 operation。队列只传项目和任务标识，不传正文。权限、来源 revision、租约、幂等、Outbox 和正式提交仍属于 API。

原 `customized_storyboard.production` 保留公开类型及函数重导出，使既有受控验证和历史工具继续使用同一实现；不得恢复跨 Worker 内部模块依赖。图片及视频供应商尚未接通。
