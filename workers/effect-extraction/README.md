# 效果类 AI 提炼 Python Worker

Python 3.12 + LangGraph Worker。RabbitMQ 消息只携带运行标识，Worker 在成功 claim 后通过 NestJS 内部 API 取得不可变输入，并将分支结果、Docling Markdown 和标准化结果外部化。Worker 不直连 PostgreSQL、Prisma 或对象存储，也不会把 Markdown、图片或模型输入写进 Graph state。

## Graph 契约

```text
load_snapshot
  ├─ documents (Docling + 信息表格或标题列表确定性解析 / 非结构化文档 AI 兜底)
  ├─ images (Pillow 预处理 + Seed 多模态)
  └─ commerce (HTTPX 静态抓取 + Playwright 兜底 + Ark 商品抽取)
          ↓ waiting edge: ALL
      fuse_sources
          ↓
      refine_semantics
          ↓
      normalize_and_store
```

- 输入 state：`{ project_id }`
- 输出 state：`{ extract_result_id }`
- runtime context：`run_id`、`project_id`、`draft_id`、`product_id`、`request_id`、`attempt_token`、`source_fingerprint`
- Rabbit 消息：`{ schemaVersion: 1, projectId, runId, requestId }`
- `source_fingerprint` 直接采用 claim 响应的 `sourceFingerprint`，Worker 不自行计算。
- 分支枚举：`DOCUMENT | IMAGE | COMMERCE | FUSION | SEMANTIC_REFINEMENT | NORMALIZATION`
- 分支状态：`PENDING | RUNNING | SUCCEEDED | PARTIAL | SKIPPED | FAILED`
- 文档和图片按源文件记录结果；存在成功项和失败项时为 `PARTIAL`。文档、图片或电商资料至少需要一个分支产出可用事实。

## NestJS 内部 API

`INTERNAL_API_BASE_URL` 应包含全局 `/api` 前缀，例如 `http://host.docker.internal:3000/api`。下表路径均相对于该 Base URL，因此代码不会再追加一层 `/api`。

所有请求携带 `x-worker-token: $EFFECT_EXTRACTION_WORKER_TOKEN`。claim 成功后，后续请求还携带 `x-attempt-token`，并在 body 或 query 中传递 `projectId`。响应支持项目统一的 `{ success, data, message? }` envelope。

| Method | 相对路径                                                                     | 用途                                                                                                   |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| POST   | `internal/workers/effect-extraction/runs/:runId/claim`                       | body `{ projectId }`；返回 `terminal/runId/sourceFingerprint/attemptToken/input`                       |
| PUT    | `internal/workers/effect-extraction/runs/:runId/progress`                    | 更新 `progress/currentNode`，同时续租                                                                  |
| PUT    | `internal/workers/effect-extraction/runs/:runId/branches`                    | 保存分支状态、结构化输出、警告与错误                                                                   |
| GET    | `internal/workers/effect-extraction/runs/:runId/branches`                    | 融合与标准化前读取外部化分支结果                                                                       |
| GET    | `internal/workers/effect-extraction/runs/:runId/sources/:materialId/content` | 读取被运行快照持有的源文件                                                                             |
| POST   | `internal/workers/effect-extraction/runs/:runId/artifacts`                   | multipart 上传 Docling/电商清洗 Markdown；字段为 `projectId/artifactKind/sourceId/idempotencyKey/file` |
| POST   | `internal/workers/effect-extraction/runs/:runId/complete`                    | 事务性写入标准化结果并返回 `extractResultId`                                                           |
| POST   | `internal/workers/effect-extraction/runs/:runId/fail`                        | 写入终态失败及可重试语义                                                                               |

claim 的 `input` 结构为：

```text
schemaVersion, projectId, draftId, mode, sourceRevision,
product { id, name, category, sku, commerceUrl, effectiveConfig },
materials[]
```

## 环境变量

必需：

- `INTERNAL_API_BASE_URL`
- `EFFECT_EXTRACTION_WORKER_TOKEN`
- `RABBITMQ_URL`
- `EFFECT_EXTRACTION_QUEUE`，默认 `effect.extraction.requested`
- `EXTRACTION_AI_PROVIDER=ark|mock`，默认 `ark`
- `ARK_BASE_URL`，默认 `https://ark.cn-beijing.volces.com/api/v3`
- `ARK_API_KEY`（`ark` 必需）
- `ARK_MODEL`，默认 `doubao-seed-2-1-turbo-260628`，作为所有模型调用的兼容回退
- `ARK_DOCUMENT_MODEL`，可选，普通产品文档候选抽取模型；为空时默认 `doubao-seed-2-1-pro-260628`
- `ARK_DOCUMENT_TIMEOUT_SECONDS`，文档 AI 单片超时，默认 `180`
- `ARK_DOCUMENT_MAX_ATTEMPTS`，文档 AI 兜底最大尝试次数，默认 `1`
- `ARK_DOCUMENT_MAX_OUTPUT_TOKENS`，文档 AI 单片输出上限，默认 `8192`；该上限同时覆盖回答与思考消耗
- `ARK_DOCUMENT_REASONING_EFFORT`，文档 AI 思考强度，默认 `minimal`；事实抽取优先减少无关推理消耗
- `DOCUMENT_CHUNK_TEXT_CHARS`，普通文档每个语义分片的最大字符数，默认 `12000`
- `DOCUMENT_MAX_CONCURRENCY`，同一份普通文档的最大 AI 分片并发，默认 `2`
- `ARK_COMMERCE_MODEL`，可选，商品页候选抽取模型；为空时回退到文档模型
- `ARK_IMAGE_MODEL`，可选，图片多模态理解模型
- `ARK_SEMANTIC_MODEL`，用户事实提示与图片建议整理模型，默认 `doubao-seed-2-1-pro-260628`
- `ARK_SEMANTIC_TIMEOUT_SECONDS`，语义整理单次硬超时，默认 `30`
- `ARK_SEMANTIC_MAX_ATTEMPTS`，语义整理最大尝试次数，固定为 `1`
- `ARK_SEMANTIC_MAX_OUTPUT_TOKENS`，语义整理输出上限，默认 `3072`
- `ARK_SEMANTIC_REASONING_EFFORT`，AI 图片建议审查思考强度，默认 `minimal`
- `ARK_SEMANTIC_USER_REVIEW_REASONING_EFFORT`，用户事实逐对审查思考强度，默认 `minimal`；每个字段由两次聚焦审查与一次全局复核按多数结论输出
- `ARK_NORMALIZATION_MODEL`，可选，仅在确定性契约化异常时使用的标准化兜底模型
- `COMMERCE_RENDERER_MAX_CONCURRENCY`，进程内 Playwright 最大并发页面数，默认 `2`
- `COMMERCE_RENDERER_TIMEOUT_SECONDS`，包含并发等待的单页总超时，默认 `25`
- `COMMERCE_RENDERER_MAX_DOM_BYTES`，渲染后 UTF-8 DOM 上限，默认 `2097152`
- `COMMERCE_RENDERER_SETTLE_MILLISECONDS`，DOMContentLoaded 后等待动态内容的时间，默认 `750`

可选资源限制：`DOCLING_ARTIFACTS_PATH`、`DOCLING_MAX_FILE_SIZE`、`DOCLING_MAX_NUM_PAGES`、`MAX_DOCUMENT_TEXT_CHARS`、`DOCUMENT_CHUNK_TEXT_CHARS`、`DOCUMENT_MAX_CONCURRENCY`、`MAX_COMMERCE_TEXT_CHARS`、`COMMERCE_STATIC_CONNECT_TIMEOUT_SECONDS`、`COMMERCE_STATIC_READ_TIMEOUT_SECONDS`、`IMAGE_MAX_INPUT_BYTES`、`IMAGE_MAX_DIMENSION`、`IMAGE_MAX_OUTPUT_BYTES`、`OMP_NUM_THREADS`。

Playwright Chromium 已并入本 Worker 镜像并在进程启动时初始化，不再运行独立 HTTP 渲染服务。静态商品页内容不足时，COMMERCE 分支直接调用进程内浏览器；每次页面使用无 Cookie Context，禁止下载、Service Worker、WebSocket、图片、视频和字体请求，并对主页面、最终跳转和子请求重复执行公网 URL 校验。

Worker 默认使用 `ark`。普通产品文档默认由 Seed 2.1 Pro 抽取，`ARK_DOCUMENT_MODEL` 可显式覆盖；图片模型为空时回退到 `ARK_MODEL`，语义整理独立使用 Pro 模型。电商模型为空时，只有显式配置了 `ARK_DOCUMENT_MODEL` 才沿用该模型，否则仍回退到 `ARK_MODEL`。NORMALIZATION 正常路径不调用模型，仅在确定性契约构造异常时使用可选的标准化模型兜底。当前语义整理只有统一 `sellingPoints` 一个业务列表：用户资料中的卖点保持原顺序和原表达，图片建议与全部权威卖点、产品基础参照和同批图片建议比较，只保留有直接可见依据且没有重复的内容。模型传输结果按单项转换为严格决定，单条枚举或结构异常只安全排除该条，不丢弃同批其他合法决定。每条图片决定必须声明直接外观、可读文字、明确动作或明确场景；推断性的配方、工艺、产地、品质、体验、功效和消费者评价不得保留。Worker 只校验稳定 ID、来源权限、决定枚举、数量和 JSON 结构。任一路整体失败时用户事实正常保存，未经整理的图片建议不进入信息卡。缺少 Key 时会在消费消息前启动失败，不会静默降级。`mock` 只能通过 `EXTRACTION_AI_PROVIDER=mock` 显式启用，供自动测试和本地无模型联调使用。Ark Provider 使用 Responses API 的 `text.format=json_schema` 强制结构化输出，随后仍由 Pydantic 二次校验。

每次成功的模型调用会把阶段、实际配置模型、提示词版本、Token 用量、总延迟和尝试次数写入内部 Branch metadata 的 `aiCall`。确定性 DOCUMENT 与 NORMALIZATION 路径分别记录解析/标准化模式且不伪造模型调用指标。方舟响应不含 usage 时 Token 字段为 `null`，不会影响业务结果。该指标不包含 Prompt、文档正文、图片 Base64、密钥或完整模型输出，也不会通过普通节点详情接口直接返回。

## 提示词管理

提示词统一放在 `src/effect_extraction/prompts/` 目录，每次模型调用对应一个独立文件：

- `document_extraction.prompt.txt`：文档资料抽取。
- `image_analysis.prompt.txt`：产品图片识别。
- `semantic_refinement.prompt.txt`：整理统一卖点列表，保留权威事实并复核图片建议。
- `semantic_image_suggestion_review.prompt.txt`：审查 AI 图片建议的事实重复和可见证据；40 条建议不构成图片事实的保留上限。
- `commerce_extraction.prompt.txt`：把公开商品页的结构化元数据和清洗正文作为不可信资料抽取，不执行网页内指令。
- `result_normalization.prompt.txt`：融合结果标准化。

`prompt_loader.py` 按文件名加载、缓存和渲染提示词，并拒绝目录穿越和非 `.prompt.txt` 文件。`providers.py` 只声明所需文件名并传入资料名、正文、图片元数据和融合候选 JSON。修改模板时不得改名 `$source_name`、`$document_markdown`、`$image_metadata_json` 和 `$fused_candidate_json` 占位符；缺少文件或变量时 Worker 会立即失败。`prompts/` 作为 Python 包内资源会随 Worker wheel 一起发布。

文档抽取保持事实优先，并主动忽略资料文档中的营销目标、时长、画幅、分辨率、渠道、禁用元素和视觉风格。符合当前信息卡或历史信息卡格式的 Markdown 表格，以及 Docling 常见的“字段标题 + 段落/项目列表”格式，均由 Worker 按字段白名单确定性解析：产品基础字段保留原位置，历史核心/次要卖点、背书、受众、痛点、决策动因和场景直接折叠进统一卖点。无法可靠识别的普通产品介绍、评测文章、说明书和品牌 Brief 会按标题与段落切分，由文档专用模型并发抽取后按原文顺序合并；不要求用户预先整理成信息表。模型会忽略导航、广告、榜单、品牌推荐、动态优惠及没有具体商品证据的功效推导。分支 metadata 的 `extractionMode` 会记录 `STRUCTURED_TABLE`、`AI_FALLBACK` 或 `AI_DOCUMENT_CHUNKS`，并记录分片总数、成功数和失败数。

图片分析只提取可见外观、包装文字、陈列、明确动作和明确使用场景。每个中心可见属性只贡献一条卖点；香料、竹篮、蒸笼、餐具和普通布景本身不得被写成产品卖点。模型不得把可见现象扩展为不可观察的配方、工艺、产地、品质、体验、功效、真实性或消费者评价。统一卖点通常建议控制在 40 项以内，但这是质量建议而非数据上限；普通产品文档优先去重和排除低价值内容，结构化标准资料中超过 40 项的独立有效事实完整保留，用户也可继续添加。图片建议经过语义审查后同样按有效性保留，不因用户事实已达到 40 项而丢弃。NORMALIZATION 复用语义整理后的候选并恢复用户权威来源；核心外观特征只有在用户资料没有提供时才使用图片结果。没有任何可信卖点时任务明确失败，不生成“待补充”占位卖点。

API 根据同一次运行的 `DOCUMENT / COMMERCE / IMAGE` 分支候选生成安全的逐项来源视图。前端不重复标注用户事实，仅在图片补充项下方显示轻量来源说明，不再单独铺设图片建议区。只有用户完成校验后，营销洞察 WorkingArtifact 才会更新并供 Prompt 节点消费。

## 本地开发与验证

2026-09-10 当前回归基线：91 项单元测试通过，5 项需要显式 Ark/Docling 环境的集成测试跳过；mypy 和本任务相关前后端 ESLint 检查通过。当前结果只包含产品基础与统一卖点，没有可信卖点时任务失败，不生成占位事实。

```bash
uv sync --dev
uv run pytest
uv run mypy src
uv run playwright install chromium
uv run effect-extraction-worker
```

Docling 模型初始化：

```bash
uv run effect-extraction-download-models
```

容器部署时将 named volume 挂载到 `/models`，先以同一镜像和 root 身份运行一次 `effect-extraction-download-models`，成功后再由非 root Worker 只读使用。真实 Docling 集成测试需设置 `RUN_DOCLING_INTEGRATION=1`。

## 真实 Ark 冒烟测试

真实冒烟测试默认跳过，只有显式设置开关才会调用方舟并产生模型费用。测试依次验证文档候选抽取、`input_image` 图片理解和最终严格 Schema 标准化；测试和 Provider 都不会记录请求正文、图片 Base64 或密钥。

```bash
export RUN_ARK_INTEGRATION=1
export ARK_API_KEY='<仅保存在本机环境>'
uv run pytest tests/test_ark_integration.py
```

PowerShell 使用 `$env:RUN_ARK_INTEGRATION='1'` 等同名环境变量。默认模型无需额外配置；如需独立验收，可设置三个专用变量为已授权的 Model ID 或 Endpoint ID，未设置的阶段仍回退到 `ARK_MODEL`。不要把密钥写入 README、测试文件或 Git 跟踪的配置。
