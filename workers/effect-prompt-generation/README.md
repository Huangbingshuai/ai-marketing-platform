# Effect Prompt Generation Worker

效果类第 3 节点“Prompt 生成”的独立 Python 3.12 Worker。Worker 从 RabbitMQ 只接收运行标识，通过 NestJS 内部 API 领取不可变输入快照，持久化分片和安全进度，并返回带版本的批次结果。它不直连数据库，也不在日志中记录 Prompt、提炼正文或模型原始输出。

## 当前 V11 流程

V11 不再先按六类片段规划关系、坐标和蓝图。每次创意调用同时生成：

```text
完整创意主线 + 六维信息 + 最终干净正文
```

六维为叙事、场景、人物、产品关联点、镜头和情绪。六项必须属于同一个创意，正文必须真实体现它们。生成模型不做钩子、痛点、产品展示等用途分组；独立评估模型在正文完成后负责质量评分、事实证据核验以及多用途分类。

批量生成采用以下规则：

- 首轮候选数为用户目标数量的 `120%`（向上取整）。
- 每个创意分片最多 4 条，每个分类分片最多 10 条；分片阶段分别为 `CREATIVE` 和 `CLASSIFICATION`。创意分片按默认输出上限控制规模，避免再次出现长 JSON 截断。
- 评估事实必须给出正文中的逐字证据；未知事实、正文不存在的证据和缺失产品关联会成为硬问题。
- 完全相同的正文，或完全相同的创意主线与六维组合，才算硬重复。
- 选择分数由 `80%` 独立质量分和 `20%` 批次新颖度组成；相似但不完全相同的候选不会被机械删除。
- 首轮不足时只允许一次定向补充；最终批次必须精确等于用户设置数量，否则保存为待检查结果，不能伪装成合格批次。
- `ITEM_EVALUATE` 只重新评估用户修改后的原正文，不生成替代正文；API 在完成时把这一条按稳定 ID 合并回原批次。

共用提示词继续作为批次级权威数据：创意生成时作为约束上下文传给模型但不自动写入每条正文；后续 Seedance 请求编译时再由第 4 节点追加。时长、画幅和分辨率仍是结构化渲染参数，不依赖正文表达。

V8～V10 的关系规划、六类分支、坐标池、蓝图和旧门禁代码只用于读取或恢复冻结的历史 Run。所有新建 Run 使用 `V11_COHERENT_CREATIVE_GENERATION`，不得回退到旧路径降低质量。

## Provider 与运行隔离

生产默认 Provider 是 Ark；缺少 `ARK_API_KEY` 时启动失败，不会静默降级 Mock。Mock 只允许使用以 `.test` 结尾或 `test.` 开头的 RabbitMQ 队列，防止测试 Worker 消费生产任务。完成回写包含 `executionMode=ARK|MOCK`，API 可拒绝非测试运行的 Mock 结果。

Ark Responses API 在解析 JSON 前检查 `status` 与 `incomplete_details`。输出长度截断会立即返回 `AI_OUTPUT_TRUNCATED`；未完成响应不会被当作合法 JSON。Provider 单次只尝试一次，网络、超时、限流和 5xx 的业务重试统一由 API 任务层负责。

## 环境变量

必填：

- `INTERNAL_API_BASE_URL`
- `EFFECT_PROMPT_WORKER_TOKEN`
- `RABBITMQ_URL`
- `ARK_API_KEY`（`PROMPT_AI_PROVIDER=ark` 时）

常用可选项：

- `EFFECT_PROMPT_QUEUE`，默认 `effect.prompt-generation.requested`
- `PROMPT_AI_PROVIDER`，默认 `ark`
- `ARK_BASE_URL`、`ARK_MODEL`
- `ARK_PROMPT_CANDIDATE_MODEL`：V11 连贯创意生成模型；未配置时回退到 `ARK_PROMPT_MODEL`，再回退到 `ARK_MODEL`
- `ARK_PROMPT_EVALUATION_MODEL`：V11 独立质量评估与用途分类模型；未配置时跟随候选模型
- `ARK_PROMPT_CANDIDATE_MAX_OUTPUT_TOKENS`，默认 `4096`
- `ARK_PROMPT_EVALUATION_MAX_OUTPUT_TOKENS`，默认 `3072`
- `ARK_PROMPT_CANDIDATE_TIMEOUT_SECONDS`，默认 `120`
- `ARK_PROMPT_EVALUATION_TIMEOUT_SECONDS`，默认 `120`
- `ARK_PROMPT_PROVIDER_MAX_ATTEMPTS`，默认 `1`
- `PROMPT_MAX_CONCURRENCY`，默认 `6`，范围 `1..8`
- `PROMPT_SHARD_SIZE`，默认 `8`；V11 创意分片会再限制为最多 4 条
- `PROMPT_MAX_AI_CALLS_PER_RUN`，默认 `256`，仅作为异常循环保险丝
- `INTERNAL_API_TIMEOUT_SECONDS`、`ARK_TIMEOUT_SECONDS`、`LOG_LEVEL`

旧 V8～V10 的策略、关系、坐标和蓝图环境变量仍保留兼容，但不参与新 V11 Run。

## 本地验证

```powershell
uv run --frozen pytest -q
uv run --frozen mypy src
uv run --frozen ruff check src tests
```
