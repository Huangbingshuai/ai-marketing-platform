# Effect Prompt Generation Worker

效果类第 3 节点“Prompt 生成”的独立 Python 3.12 Worker。Worker 从 RabbitMQ 只接收运行标识，通过 NestJS 内部 API 领取不可变输入快照，持久化分片和安全进度，并返回带版本的批次结果。它不直连数据库，也不在日志中记录 Prompt、提炼正文或模型原始输出。

## 当前 V11 视觉策略流程

新任务使用 `V11_VISUAL_USAGE_STRATEGY`。Worker 先把已提交营销洞察中的可用事实交给一次独立 AI 调用，编译为“产品身份锚点、可直接呈现、可通过动作呈现、仅作商业背景、仅适合文字表达、禁止视觉证明”六种角色；Worker 再校验事实引用、完整覆盖和禁止推导，并按营销洞察 `contentHash + 策略模板版本` 复用成功检查点。策略不会写入公开 Prompt 结果，也不会按候选数量重复调用。

随后每条创意只接收一个可见 `visualTask`、最多两个 `businessContext`、产品锚点和与本条相关的禁止推导。模型仍在一次创意调用中同时生成：

```text
完整创意主线 + 六维信息 + 最终干净正文
```

六维为叙事、场景、人物、产品关联点、镜头和情绪。六项必须属于同一个创意，正文必须真实体现它们。生成模型不做钩子、痛点、产品展示等用途分组；独立评估模型在正文完成后负责质量评分、事实证据核验以及多用途分类。

当前视觉策略模板为 `effect-prompt-v11-fact-visual-strategy-v1`，连贯创意模板为 `effect-prompt-v11-coherent-creative-v4`。生成角色保持厂商无关，一次调用直接产出可供后续渲染的完整素材 Prompt；镜头、光线和情绪必须服务本条产品动作，不得给不同候选机械套用统一的“电影级、商业广告、高级质感、暖色调、浅景深、缓慢推进”等正向前缀。已有语义和视觉签名只是软避重参考，不能迫使模型使用与产品无关的场景。抽象配方、成分、工艺、认证和背书只能作为商业背景，不能被写成肉眼已经证明的纹理、光泽、纯度或功效。

独立评估模板为 `effect-prompt-v11-creative-evaluation-v3`，评估模型会接收候选实际引用事实对应的同一份视觉策略，检查抽象事实是否被错误包装成视觉证明。商品无关、事实捏造和不可执行画面仍是硬问题；通用质感词堆叠、目的句代替可见动作和普通相似只使用稳定问题码记录软提醒。Worker 会确定性补充这些软提醒，但不会因此淘汰候选；回退新颖度计算覆盖叙事、场景、人物、产品关联点、镜头和情绪全部六维。

为降低单次创意调用的判断负担，Worker 会在分片前把原“主要事实”拆成两个角色：`visualTask` 必须成为本条可见画面，`businessContext` 只影响叙事和商业方向、不得承担视觉证明。生成模型不接收整张提炼信息表或整张策略表；返回结果必须使用本条可见任务和至少一个产品锚点，且不能跨任务引用其他事实。上游事实原文不会被改写，AI 只决定事实怎样安全进入画面。

批量生成采用以下规则：

- 首轮候选数为用户目标数量的 `120%`（向上取整）。
- 每个创意分片最多 4 条，每个分类分片最多 3 条；分片阶段分别为 `CREATIVE` 和 `CLASSIFICATION`。真实付费回归确认 5 条详细评估仍可能返回提前结束的严格 JSON，因此在不改变评估口径的前提下缩小到 3 条。分类动态输出预算按每条 720 Token 计算、最低 1536 Token，并受 4096 的默认总上限约束。
- 创意与分类调用共用 `PROMPT_MAX_CONCURRENCY` 滑动并发门限；一个分片完成后立即补入下一个，但分类节点仍等待本轮全部创意分片完成后再启动。
- 评估事实优先给出正文中的逐字证据。评估模型返回的未知事实或非逐字证据会被丢弃并记录告警，不再连带淘汰仍具有其他有效产品证据的 Prompt；完全缺少有效产品关联仍是硬问题。
- 完全相同的正文，或完全相同的创意主线与六维组合，才算硬重复。
- 新 Run 使用 `MMR_CONTENT_V2`：只为 Prompt 正文生成向量，按 `70%` 独立质量分和 `30%` 相对已选集合的新颖度逐条选择；六维只用于覆盖统计和同分决胜。
- 全量生成将人工保留项作为固定相似度参照；单条重新生成将目标条目之外的当前批次 Prompt 作为固定参照。参照项不参与淘汰和数量统计。
- 一般相似只影响排序，不会机械删除候选。选满目标数量后，如果相似度不低于 `0.82` 的高风险分组冗余超过 `max(2, ceil(目标数×10%))`，才额外生成一次最多目标数 `20%` 的多样性候选；即使软目标仍未满足，也保存准确数量并记录告警。
- 首轮不足时按实时缺口最多执行三轮定向补充，并在达到用户数量后立即停止；三轮后仍不足才保存为待检查结果，不能伪装成合格批次。
- `ITEM_EVALUATE` 只重新评估用户修改后的原正文，不生成替代正文；API 在完成时把这一条按稳定 ID 合并回原批次。

共用提示词继续作为批次级权威数据：创意生成时作为约束上下文传给模型但不自动写入每条正文；后续 Seedance 请求编译时再由第 4 节点追加。时长、画幅和分辨率仍是结构化渲染参数，不依赖正文表达。

V8～V10 的关系规划、六类分支、坐标池、蓝图和旧门禁代码只用于读取或恢复冻结的历史 Run；原 `V11_COHERENT_CREATIVE_GENERATION` 也继续按原拓扑读取。所有新建 Run 使用 `V11_VISUAL_USAGE_STRATEGY`，不得把历史 Run 原地伪造升级。

## Provider 与运行隔离

生产默认 Provider 是 Ark；缺少 `ARK_API_KEY` 时启动失败，不会静默降级 Mock。Mock 只允许使用以 `.test` 结尾或 `test.` 开头的 RabbitMQ 队列，防止测试 Worker 消费生产任务。完成回写包含 `executionMode=ARK|MOCK`，API 可拒绝非测试运行的 Mock 结果。

Ark Responses API 在解析 JSON 前检查 `status` 与 `incomplete_details`。输出长度截断会立即返回 `AI_OUTPUT_TRUNCATED`；未完成响应不会被当作合法 JSON。Provider 单次只尝试一次，网络、超时、限流和 5xx 的业务重试统一由 API 任务层负责。

队列信封兼容 Prompt V5/V6，新任务使用 V6。Ark 偶尔会把被截断的 JSON 标成 `completed`；V11 对这种已完成但格式异常的响应仅在当前创意或评估分片内补试一次。补试仍失败时会取消同批尚未完成的调用，再交给任务层处理，避免旧 attempt 继续产生费用或回写。

向量服务使用独立 Provider 和 HTTP 客户端，不复用生成模型。`trigram` 保持字符基线；`shadow` 计算正文向量 MMR 但仍保存字符基线结果；`vector` 才由正文向量 MMR 接管。火山向量模型或 Endpoint 必须显式配置，不能回退到 `ARK_MODEL`。当前账号使用 `doubao-embedding-vision-251215`，通过官方 `/embeddings/multimodal` 端点发送纯文本。该端点每次最多接收一个 `text`，Worker 会自动把每批限制为单条并使用独立并发门限；不会误发到文本 `/embeddings` 端点。`shadow` 下向量故障会在阶段详情留下告警并继续旧算法，`vector` 下则重试或失败，禁止静默降级。

向量正文会去除共用提示词、时长、画幅和固定合规尾段，并把批内共同产品名与品类规范成占位符。编译版本为 `effect-prompt-embedding-text-v2`；原始向量只保存在当前 Run 内存中，补充轮次只向量化新增正文，Worker 恢复时重新计算，不写数据库或日志。

向量进入选择前会转换为 NumPy `float32` 矩阵、按行归一化，并用一次矩阵点积得到全部候选与固定参照的余弦相似度。MMR 选择期间只增量维护每个候选的最大风险，不再重复遍历高维向量。`shadow` 阶段记录字符基线与正文 MMR 的近重复数、平均质量、六维覆盖、选集重合率、矩阵耗时和条件补充判断，这些指标只用于决定是否切换 `vector`，不会改变影子模式的权威结果。

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
- `ARK_PROMPT_CANDIDATE_MODEL`：当前连贯创意生成模型；未配置时回退到 `ARK_PROMPT_MODEL`，再回退到 `ARK_MODEL`
- `ARK_PROMPT_EVALUATION_MODEL`：当前独立质量评估与用途分类模型；未配置时跟随候选模型
- `ARK_PROMPT_CANDIDATE_MAX_OUTPUT_TOKENS`，默认 `4096`
- `ARK_PROMPT_EVALUATION_MAX_OUTPUT_TOKENS`，默认 `4096`
- `ARK_PROMPT_CANDIDATE_TIMEOUT_SECONDS`，默认 `120`
- `ARK_PROMPT_EVALUATION_TIMEOUT_SECONDS`，默认 `120`
- `ARK_PROMPT_PROVIDER_MAX_ATTEMPTS`，默认 `1`
- `PROMPT_SIMILARITY_MODE`：`trigram|shadow|vector`；部署默认 `vector`，仅历史兼容或故障诊断时显式切回 `trigram/shadow`
- `ARK_PROMPT_EMBEDDING_MODEL`：火山向量 Model ID 或 Endpoint ID；当前使用 `doubao-embedding-vision-251215`；`shadow/vector` 且使用 Ark 时必填
- `ARK_PROMPT_EMBEDDING_API_MODE`：`multimodal|text`，默认 `multimodal`；251215 必须使用 `multimodal`
- `ARK_PROMPT_EMBEDDING_TIMEOUT_SECONDS`，默认 `30`
- `ARK_PROMPT_EMBEDDING_MAX_ATTEMPTS`，默认 `3`
- `PROMPT_EMBEDDING_BATCH_SIZE`，默认 `64`，最大 `256`；多模态端点会按官方上限自动收窄为 `1`
- `PROMPT_EMBEDDING_MAX_CONCURRENCY`，默认 `8`，使用独立并发门限
- `PROMPT_MAX_CONCURRENCY`，默认 `6`，范围 `1..8`
- `PROMPT_SHARD_SIZE`，默认 `8`；当前创意分片会再限制为最多 4 条
- `PROMPT_MAX_AI_CALLS_PER_RUN`，默认 `256`，仅作为异常循环保险丝
- `INTERNAL_API_TIMEOUT_SECONDS`、`ARK_TIMEOUT_SECONDS`、`LOG_LEVEL`

旧策略、关系、坐标和蓝图配置不参与新建 Run；带显式历史图版本的冻结任务仍按原配置和原拓扑恢复，不能套用当前视觉策略图。

## 本地验证

```powershell
uv run --frozen pytest -q
uv run --frozen mypy src
uv run --frozen ruff check src tests
```

真实火山向量验收使用 `ark_integration` 标记，必须显式配置 API Key、模型与 API 模式：

```powershell
uv run --frozen pytest -q -m ark_integration tests/test_embedding_benchmark.py -s
```

自动基准包含食品、日用品和设备三类共 180 组语义对照，并比较并发 `2` 与 `8` 的耗时。当前 `doubao-embedding-vision-251215` 多模态端点每次最多接收一个文本，因此完整准确率基准约产生 169 次请求；新策略的生产初轮 60 个无参照候选需要 60 次请求，相比历史双向量策略减少 50%。若改用支持批量文本的 Endpoint，Provider 会按配置自动批处理。
