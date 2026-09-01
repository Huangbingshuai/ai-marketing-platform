# 效果类 AI 提炼 Python Worker

Python 3.12 + LangGraph Worker。RabbitMQ 消息只携带运行标识，Worker 在成功 claim 后通过 NestJS 内部 API 取得不可变输入，并将分支结果、Docling Markdown 和标准化结果外部化。Worker 不直连 PostgreSQL、Prisma 或对象存储，也不会把 Markdown、图片或模型输入写进 Graph state。

## Graph 契约

```text
load_snapshot
  ├─ documents (Docling + 信息表格或标题列表确定性解析 / 非结构化文档 AI 兜底)
  ├─ images (Pillow 预处理 + Seed 多模态)
  ├─ commerce (HTTPX 静态抓取 + Playwright 兜底 + Ark 商品抽取)
  └─ form (最高优先级)
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
- 分支枚举：`DOCUMENT | IMAGE | COMMERCE | FORM | FUSION | SEMANTIC_REFINEMENT | NORMALIZATION`
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
- `ARK_DOCUMENT_TIMEOUT_SECONDS`，文档 AI 兜底单次超时，默认 `45`
- `ARK_DOCUMENT_MAX_ATTEMPTS`，文档 AI 兜底最大尝试次数，默认 `1`
- `ARK_DOCUMENT_MAX_OUTPUT_TOKENS`，文档 AI 兜底输出上限，默认 `3072`
- `ARK_DOCUMENT_REASONING_EFFORT`，文档 AI 兜底思考强度，默认 `minimal`
- `ARK_COMMERCE_MODEL`，可选，商品页候选抽取模型；为空时回退到文档模型
- `ARK_IMAGE_MODEL`，可选，图片多模态理解模型
- `ARK_SEMANTIC_MODEL`，可选，语义重复关系判定模型
- `ARK_NORMALIZATION_MODEL`，可选，仅在确定性契约化异常时使用的标准化兜底模型
- `COMMERCE_RENDERER_URL` 与 `COMMERCE_RENDERER_TOKEN`，可选但必须成对配置；Compose 默认连接隔离的 Playwright Renderer

可选资源限制：`DOCLING_ARTIFACTS_PATH`、`DOCLING_MAX_FILE_SIZE`、`DOCLING_MAX_NUM_PAGES`、`MAX_DOCUMENT_TEXT_CHARS`、`MAX_COMMERCE_TEXT_CHARS`、`COMMERCE_STATIC_CONNECT_TIMEOUT_SECONDS`、`COMMERCE_STATIC_READ_TIMEOUT_SECONDS`、`COMMERCE_RENDERER_CLIENT_TIMEOUT_SECONDS`、`IMAGE_MAX_INPUT_BYTES`、`IMAGE_MAX_DIMENSION`、`IMAGE_MAX_OUTPUT_BYTES`、`OMP_NUM_THREADS`。

Worker 默认使用 `ark`。文档、图片和语义整理专用模型为空时回退到 `ARK_MODEL`；电商模型为空时先回退到 `ARK_DOCUMENT_MODEL`，再回退到 `ARK_MODEL`。NORMALIZATION 正常路径不调用模型，仅在确定性契约构造异常时使用可选的标准化模型兜底。语义整理默认跟随 `doubao-seed-2-1-turbo-260628`，通过一次低思考强度的严格 Schema 请求完成跨字段归类、同义/父子/同主题关系判断和字段超量择优。模型只能选择已有事实 ID，不能生成、改写或概括事实；Worker 不再使用字符相似、关键词、修饰语名单、文本包含或业务关键词复判语义，只校验事实 ID、来源权限、字段数量和 JSON 结构。用户事实不能移动、不能被图片建议覆盖，也不能因模型分组或择优被删除；AI 图片建议可以由模型移动到更合理的卖点、痛点、决策动因或场景字段。少于两条可整理事实时不调用模型。缺少 Key 时会在消费消息前启动失败，不会静默降级。专用模型调用失败时不会自动换用回退模型。`mock` 只能通过 `EXTRACTION_AI_PROVIDER=mock` 显式启用，供自动测试和本地无模型联调使用。Ark Provider 使用 Responses API 的 `text.format=json_schema` 强制结构化输出，随后仍由 Pydantic 二次校验。

每次成功的模型调用会把阶段、实际配置模型、提示词版本、Token 用量、总延迟和尝试次数写入内部 Branch metadata 的 `aiCall`。确定性 DOCUMENT 与 NORMALIZATION 路径分别记录解析/标准化模式且不伪造模型调用指标。方舟响应不含 usage 时 Token 字段为 `null`，不会影响业务结果。该指标不包含 Prompt、文档正文、图片 Base64、密钥或完整模型输出，也不会通过普通节点详情接口直接返回。

## 提示词管理

提示词统一放在 `src/effect_extraction/prompts/` 目录，每次模型调用对应一个独立文件：

- `document_extraction.prompt.txt`：文档资料抽取。
- `image_analysis.prompt.txt`：产品图片识别。
- `semantic_refinement.prompt.txt`：跨字段语义归类、关系判断和字段择优。
- `commerce_extraction.prompt.txt`：把公开商品页的结构化元数据和清洗正文作为不可信资料抽取，不执行网页内指令。
- `result_normalization.prompt.txt`：融合结果标准化。

`prompt_loader.py` 按文件名加载、缓存和渲染提示词，并拒绝目录穿越和非 `.prompt.txt` 文件。`providers.py` 只声明所需文件名并传入资料名、正文、图片元数据和融合候选 JSON。修改模板时不得改名 `$source_name`、`$document_markdown`、`$image_metadata_json` 和 `$fused_candidate_json` 占位符；缺少文件或变量时 Worker 会立即失败。`prompts/` 作为 Python 包内资源会随 Worker wheel 一起发布。

文档抽取保持事实优先，并主动忽略资料文档中的时长、画幅、分辨率、渠道、禁用元素和视觉风格；六项制作配置只采用资料导入节点的表单快照。符合《产品素材制作信息卡》的 Markdown 表格，以及 Docling 常见的“字段标题 + 段落/项目列表”格式，均由 Worker 按字段白名单确定性解析，直接得到用户事实，不再调用 Ark；项目列表后的填写确认、说明和备注段落会被排除。只有无法可靠识别的非结构化文档才进入文档 AI 兜底。分支 metadata 的 `extractionMode` 会记录 `STRUCTURED_TABLE` 或 `AI_FALLBACK`，便于定位性能问题。

图片分析先提取可见外观、包装文字、陈列、场景与视觉气氛，也可以在画面具有明确人物、动作、用途或购买情境时，保守补充卖点、痛点、受众、决策动因、营销目标和场景建议。节庆、礼赠、家庭餐桌等画面证据优先进入对应场景字段；香料、竹篮、蒸笼、餐具和布景不得作为产品卖点。价格、配方、产地、认证、功效、销量与信任背书仍不得无证据推断。卖点融合先保留全部用户事实，再从图片模型确认的产品本体或包装可见核心价值中补充；AI 生成的次要卖点从 Worker 到 API 统一保留最多 10 项，用户手工编辑仍使用 20 项公共安全边界。核心卖点、次要卖点、痛点、决策动因以及三类场景统一交给语义模型判断关系，NORMALIZATION 只复用模型整理后的候选并恢复用户权威来源；核心外观特征只有在用户资料没有提供时才使用图片结果。

API 根据同一次运行的 `FORM / DOCUMENT / COMMERCE / IMAGE` 分支候选生成安全的逐项来源视图。前端不重复标注用户事实，仅在图片补充项下方显示轻量来源说明，不再单独铺设图片建议区。只有用户完成校验后，营销洞察 WorkingArtifact 才会更新并供 Prompt 节点消费。

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
