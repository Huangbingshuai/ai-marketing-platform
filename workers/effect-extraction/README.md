# 效果类 AI 提炼 Python Worker

Python 3.12 + LangGraph Worker。RabbitMQ 消息只携带运行标识，Worker 在成功 claim 后通过 NestJS 内部 API 取得不可变输入，并将分支结果、Docling Markdown 和标准化结果外部化。Worker 不直连 PostgreSQL、Prisma 或对象存储，也不会把 Markdown、图片或模型输入写进 Graph state。

## Graph 契约

```text
load_snapshot
  ├─ documents (Docling + 文档候选抽取)
  ├─ images (Pillow 预处理 + Seed 多模态)
  ├─ commerce (HTTPX 静态抓取 + Playwright 兜底 + Ark 商品抽取)
  └─ form (最高优先级)
          ↓ waiting edge: ALL
      fuse_sources
          ↓
      normalize_and_store
```

- 输入 state：`{ project_id }`
- 输出 state：`{ extract_result_id }`
- runtime context：`run_id`、`project_id`、`draft_id`、`product_id`、`request_id`、`attempt_token`、`source_fingerprint`
- Rabbit 消息：`{ schemaVersion: 1, projectId, runId, requestId }`
- `source_fingerprint` 直接采用 claim 响应的 `sourceFingerprint`，Worker 不自行计算。
- 分支枚举：`DOCUMENT | IMAGE | COMMERCE | FORM | FUSION | NORMALIZATION`
- 分支状态：`PENDING | RUNNING | SUCCEEDED | PARTIAL | SKIPPED | FAILED`
- 文档和图片按源文件记录结果；存在成功项和失败项时为 `PARTIAL`。表单是必需分支。

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
- `ARK_DOCUMENT_MODEL`，可选，文档长文本候选抽取模型
- `ARK_COMMERCE_MODEL`，可选，商品页候选抽取模型；为空时回退到文档模型
- `ARK_IMAGE_MODEL`，可选，图片多模态理解模型
- `ARK_SEMANTIC_MODEL`，可选，语义重复关系判定模型
- `ARK_NORMALIZATION_MODEL`，可选，融合结果结构化标准化模型
- `COMMERCE_RENDERER_URL` 与 `COMMERCE_RENDERER_TOKEN`，可选但必须成对配置；Compose 默认连接隔离的 Playwright Renderer

可选资源限制：`DOCLING_ARTIFACTS_PATH`、`DOCLING_MAX_FILE_SIZE`、`DOCLING_MAX_NUM_PAGES`、`MAX_DOCUMENT_TEXT_CHARS`、`MAX_COMMERCE_TEXT_CHARS`、`COMMERCE_STATIC_CONNECT_TIMEOUT_SECONDS`、`COMMERCE_STATIC_READ_TIMEOUT_SECONDS`、`COMMERCE_RENDERER_CLIENT_TIMEOUT_SECONDS`、`IMAGE_MAX_INPUT_BYTES`、`IMAGE_MAX_DIMENSION`、`IMAGE_MAX_OUTPUT_BYTES`、`OMP_NUM_THREADS`。

Worker 默认使用 `ark`。文档、图片、语义整理和标准化专用模型为空时回退到 `ARK_MODEL`；电商模型为空时先回退到 `ARK_DOCUMENT_MODEL`，再回退到 `ARK_MODEL`，因此正常环境仍只需提供 `ARK_API_KEY`。语义整理默认使用 `doubao-seed-2-0-mini-260428`，通过一次最小思考的严格 Schema 请求判断小规模事实关系；模型只能选择已有事实 ID，不能生成新事实，`SAME_FAMILY` 只分组、不删除原始表达。没有可比较的同字段信息时不调用模型。缺少 Key 时会在消费消息前启动失败，不会静默降级。专用模型调用失败时不会自动换用回退模型。`mock` 只能通过 `EXTRACTION_AI_PROVIDER=mock` 显式启用，供自动测试和本地无模型联调使用。Ark Provider 使用 Responses API 的 `text.format=json_schema` 强制结构化输出，随后仍由 Pydantic 二次校验。

每次成功调用会把阶段、实际配置模型、提示词版本、Token 用量、总延迟和尝试次数写入内部 Branch metadata 的 `aiCall`。方舟响应不含 usage 时 Token 字段为 `null`，不会影响业务结果。该指标不包含 Prompt、文档正文、图片 Base64、密钥或完整模型输出，也不会通过普通节点详情接口直接返回。

## 提示词管理

提示词统一放在 `src/effect_extraction/prompts/` 目录，每次模型调用对应一个独立文件：

- `document_extraction.prompt.txt`：文档资料抽取。
- `image_analysis.prompt.txt`：产品图片识别。
- `semantic_refinement.prompt.txt`：同字段语义重复归并。
- `commerce_extraction.prompt.txt`：把公开商品页的结构化元数据和清洗正文作为不可信资料抽取，不执行网页内指令。
- `result_normalization.prompt.txt`：融合结果标准化。

`prompt_loader.py` 按文件名加载、缓存和渲染提示词，并拒绝目录穿越和非 `.prompt.txt` 文件。`providers.py` 只声明所需文件名并传入资料名、正文、图片元数据和融合候选 JSON。修改模板时不得改名 `$source_name`、`$document_markdown`、`$image_metadata_json` 和 `$fused_candidate_json` 占位符；缺少文件或变量时 Worker 会立即失败。`prompts/` 作为 Python 包内资源会随 Worker wheel 一起发布。

文档抽取保持事实优先；图片分析与结果标准化允许对价格带、目标人群、营销目标、创意卖点、使用场景、渠道、品牌调性和合规风险进行有边界的营销补全。产品名、规格、配方、产地、认证、功效和销量等硬事实不得臆造。推断价格必须使用带“建议、需确认”的区间，不能伪装成用户提供的精确售价。

## 本地开发与验证

```bash
uv sync --dev
uv run pytest
uv run mypy src
uv run effect-extraction-worker
```

Docling 模型初始化：

```bash
uv run effect-extraction-download-models
```

容器部署时将 named volume 挂载到 `/root/.cache/docling/models`，先以同一镜像运行 `effect-extraction-download-models`，成功后再启动 Worker。真实 Docling 集成测试需设置 `RUN_DOCLING_INTEGRATION=1`。

## 真实 Ark 冒烟测试

真实冒烟测试默认跳过，只有显式设置开关才会调用方舟并产生模型费用。测试依次验证文档候选抽取、`input_image` 图片理解和最终严格 Schema 标准化；测试和 Provider 都不会记录请求正文、图片 Base64 或密钥。

```bash
export RUN_ARK_INTEGRATION=1
export ARK_API_KEY='<仅保存在本机环境>'
uv run pytest tests/test_ark_integration.py
```

PowerShell 使用 `$env:RUN_ARK_INTEGRATION='1'` 等同名环境变量。默认模型无需额外配置；如需独立验收，可设置三个专用变量为已授权的 Model ID 或 Endpoint ID，未设置的阶段仍回退到 `ARK_MODEL`。不要把密钥写入 README、测试文件或 Git 跟踪的配置。
