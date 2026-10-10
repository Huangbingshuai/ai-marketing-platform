# 定制类信息提炼 Worker

独立 Python 3.12 消费者，队列为 `customized.extraction.requested`。固定内部执行图：

`LOAD_AND_SNAPSHOT → DOCUMENT_PARSE → DOCUMENT_EXTRACT → FUSION → SEMANTIC_REFINEMENT → NORMALIZATION`

这六个阶段属于信息提炼内部执行，不改变定制类六个业务节点。输入为已确认资料包的固定版本，输出为两组 12 字段、字段 / 卖点来源及待确认差异。品牌图片仅保留引用，不下载、不进入模型。标准 Word / Excel 表格只读取“填写内容”，备注和示例不作为事实；自由文档分片提取，按文档融合并核对语义。未知事实留空或保留待确认含义，不生成分镜或虚构认证、功效和产品外观。

Docling、文本分片、结构化请求、有限重试、安全错误及内部 HTTP 协议使用 `../shared/extraction-runtime`，效果类引用同一实现；各自字段规则和执行图独立。

模板识别同时核对填写行：存在已填写的旧版或自定义字段时，先排除示例列，再由 AI 映射信息卡，避免只读到同名字段而丢失其余资料。当前 Word 表格中明确的换行、段落由定制适配层按原始 OOXML 与 Docling 单元格文本唯一匹配恢复，保持逐条卖点；不按标点或关键词猜测拆分，也不修改效果类解析结果。

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

长文分片与独立融合对共用一个模型并发上限（默认 2），按输入顺序收集结果；多文档采用平衡融合，仍为 N−1 次融合。纯空模板不请求模型，混入有效文档的空模板不增加融合调用。内部 API 的网络错误、429、5xx 最多请求 4 次，间隔 1 / 2 / 4 秒；404 / 409 立即停止，避免短暂服务重启导致重复模型处理。持续断连仍依赖持久化检查点和租约恢复，不承诺故障期间固定耗时。

模板清洗按每张表识别，普通参数表保留全部列；存在额外正文时走语义提取。融合只对原文完全相同的卖点从已校验输入恢复来源索引，不对改写内容猜测匹配。语义核对读取文档提取依据，并可修订同 ID 的冲突候选，避免整字段替换时漏掉不冲突的共同信息。

同一产品有品牌及型号依据的全名、简称由 AI 核对，不按措辞不同自动判冲突。语义核对可通过内部 `dismissedIssueIds` 明确撤销误报；代码仅校验 ID 来自现有差异、没有重复且不与修订列表冲突，模型省略某条差异仍保留它。包装版式等待设计范围归入外观，软件外观按界面处理，不补造实体包装。

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

## 真实付费验收

用户明确授权后，仓库根目录可设置 `CUSTOMIZED_EXTRACTION_PAID_TEST=1`，运行 `node apps/api/scripts/verify-customized-extraction-paid.mjs`。脚本创建隔离项目并触发真实任务，将标识存到系统临时目录的固定 manifest；再次执行仅查询已有任务，`--reextract` 才在尚未确认的当前 Run 创建新任务。不要删除 manifest 后反复运行，以免创建重复付费任务。可用 `CUSTOMIZED_PAID_MANIFEST` 指定独立测试记录，`CUSTOMIZED_PAID_DOCUMENT` 指定本地 Word 样本。

`verify-customized-extraction-lifecycle-paid.mjs` 使用同一 manifest 验证编辑和版本流程，部分 action 会创建真实任务。已执行范围、修复、版本行为及构建限制见 [2026-10-10 验收记录](../../docs/workflows/customized/evidence/browser/2026-10-10-paid-extraction.md)。该记录不是后续代码的永久通过证明。

深度验收可先运行 `tests/prepare_paid_fixtures.py` 生成 9 组无敏感信息的本地测试资料（不调用 API），再在根目录运行 `node apps/api/scripts/verify-customized-extraction-deep-paid.mjs`（需要上述付费开关）。台账位于系统临时目录 `customized-deep-paid-20261010/ledger.json`，普通重跑仅查询；`--assert` 检查终态、事实及冲突阻断。`CUSTOMIZED_DEEP_CASE` 指定单个用例；`--retry` 恢复原失败任务，`--reextract` 创建新任务，均须谨慎使用。`--cancel-running` 仅用于该台账的长文用例，会确认原结果、创建隔离编辑任务并在实际运行时取消。不要删除台账后重复执行。深度验收的具体样本、耗时与限制见 [深度验收记录](../../docs/workflows/customized/evidence/browser/2026-10-10-paid-extraction-deep.md)。

多产品资料位于 `素材/定制类项目素材/多产品提炼验收/`，包含八份 Word 简报和四份补充说明，均为虚构样本，一项目一产品。`CUSTOMIZED_PAID_CASE_DIRECTORY` 可指定独立 cases.json / ledger.json 目录，`CUSTOMIZED_PAID_PROJECT_PREFIX` 可指定测试项目名前缀；默认仍使用原深度验收账本。具体过程见[多产品验收](../../docs/workflows/customized/evidence/browser/2026-10-10-paid-extraction-products.md)。
