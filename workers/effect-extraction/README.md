# 效果类 AI 提炼 Python Worker

Python 3.12 + LangGraph Worker。RabbitMQ 消息只携带运行标识，Worker 在成功 claim 后通过 NestJS 内部 API 取得不可变输入，并将分支结果、Docling Markdown 和标准化结果外部化。Worker 不直连 PostgreSQL、Prisma 或对象存储，也不会把 Markdown、图片或模型输入写进 Graph state。

## Graph 契约

```text
load_snapshot
  ├─ documents (Docling + 文档候选抽取)
  ├─ images (Pillow 预处理 + Seed 多模态)
  ├─ commerce (v1 显式 SKIPPED)
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

| Method | 相对路径                                                                     | 用途                                                                                  |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| POST   | `internal/workers/effect-extraction/runs/:runId/claim`                       | body `{ projectId }`；返回 `terminal/runId/sourceFingerprint/attemptToken/input`      |
| PUT    | `internal/workers/effect-extraction/runs/:runId/progress`                    | 更新 `progress/currentNode`，同时续租                                                 |
| PUT    | `internal/workers/effect-extraction/runs/:runId/branches`                    | 保存分支状态、结构化输出、警告与错误                                                  |
| GET    | `internal/workers/effect-extraction/runs/:runId/branches`                    | 融合与标准化前读取外部化分支结果                                                      |
| GET    | `internal/workers/effect-extraction/runs/:runId/sources/:materialId/content` | 读取被运行快照持有的源文件                                                            |
| POST   | `internal/workers/effect-extraction/runs/:runId/artifacts`                   | multipart 上传 Markdown；字段为 `projectId/artifactKind/sourceId/idempotencyKey/file` |
| POST   | `internal/workers/effect-extraction/runs/:runId/complete`                    | 事务性写入标准化结果并返回 `extractResultId`                                          |
| POST   | `internal/workers/effect-extraction/runs/:runId/fail`                        | 写入终态失败及可重试语义                                                              |

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
- `EXTRACTION_AI_PROVIDER=mock|ark`
- `ARK_BASE_URL`、`ARK_API_KEY`、`ARK_MODEL`（仅 `ark` 必需）

可选资源限制：`DOCLING_ARTIFACTS_PATH`、`DOCLING_MAX_FILE_SIZE`、`DOCLING_MAX_NUM_PAGES`、`MAX_DOCUMENT_TEXT_CHARS`、`IMAGE_MAX_INPUT_BYTES`、`IMAGE_MAX_DIMENSION`、`IMAGE_MAX_OUTPUT_BYTES`、`OMP_NUM_THREADS`。

`mock` 必须显式配置；生产部署应配置 `ark`。Ark Provider 使用 Responses API 的 `text.format=json_schema` 强制结构化输出，随后仍由 Pydantic 二次校验。

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
