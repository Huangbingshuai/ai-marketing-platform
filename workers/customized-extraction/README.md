# 定制类信息提炼 Worker

独立 Python 3.12 消费者，队列为 `customized.extraction.requested`。固定内部执行图：

`LOAD_AND_SNAPSHOT → DOCUMENT_PARSE → DOCUMENT_EXTRACT → FUSION → SEMANTIC_REFINEMENT → NORMALIZATION`

这六个阶段属于信息提炼内部执行，不改变定制类六个业务节点。输入为已确认资料包的固定版本，输出为两组 12 字段、字段 / 卖点来源及待确认差异。品牌图片仅保留引用，不下载、不进入模型。标准 Word / Excel 表格只读取“填写内容”，备注和示例不作为事实；自由文档分片提取，按文档融合并核对语义。未知事实留空或保留待确认含义，不生成分镜或虚构认证、功效和产品外观。

Docling、文本分片、结构化请求、有限重试、安全错误及内部 HTTP 协议使用 `../shared/extraction-runtime`，效果类引用同一实现；各自字段规则和执行图独立。

## 配置与运行

必需：`INTERNAL_API_BASE_URL`（包含 `/api`）、`CUSTOMIZED_EXTRACTION_WORKER_TOKEN`、`RABBITMQ_URL`、`ARK_API_KEY`。API 与 Worker 的独立 Token 必须一致。

模型使用 `ARK_DOCUMENT_MODEL`，默认 `doubao-seed-2-1-pro-260628`；其他配置为 `ARK_BASE_URL`、`ARK_DOCUMENT_TIMEOUT_SECONDS=180`、`ARK_DOCUMENT_MAX_ATTEMPTS=2`、`ARK_DOCUMENT_MAX_OUTPUT_TOKENS=8192`、`DOCUMENT_MAX_CONCURRENCY=2`（1–4）、`DOCUMENT_CHUNK_TEXT_CHARS=12000`、`DOCLING_MAX_PAGES=200`。缺配置明确失败，不回退 Mock。仅测试注入受控 Provider。

仓库根目录：

```powershell
docker compose --profile customized-extraction build customized-extraction-worker
# 确认模型初始化完成、Token 一致，且允许消费队列后启动
docker compose --profile customized-extraction up -d customized-extraction-worker
```

复用 `docling-models:/models:ro`，CPU PyTorch；不启动视觉分析服务。Compose 构建上下文为 `workers/`，包含共享包。构建不更新已有运行容器；更新时先确认无活动任务，不中断其他 Worker。

内部接口 `internal/workers/customized-extraction/tasks/:taskId`：claim、progress、steps、sources、artifacts、parsed、complete、fail。共享 Token 全程携带，claim 后携带 attempt token。文件仅通过 API 获取；Worker 不持有数据库或对象存储凭据。消息只包含 schemaVersion / projectId / runId（提炼任务 ID）/ requestId。

每 20 秒续租；任务租约 90 秒。每阶段和每文档检查点持久化，文档并发有界。任一文档失败整体未完成，不能确认；恢复同任务复用成功文件与阶段，主动重提创建新任务。取消、来源变化或租约失效立即拒绝写回，成功结果仍需用户保存版本。

## 无付费验证

在本目录：

```powershell
uv sync --frozen
uv run --frozen pytest
uv run --frozen mypy src tests
```

仓库根目录使用本地 Docling（首次 PDF 解析需要已准备好的模型文件）：

```powershell
uv run --frozen --project workers/customized-extraction python workers/customized-extraction/tests/verify_local_docling.py
```

pytest 使用受控 Provider / HTTP transport，不接触真实模型供应商。`verify_local_docling.py` 验证真实解析器，不调用生成模型；付费端到端与输出语义质量需另行验收。
