# 效果类工作流 Step 02「AI 信息提炼」实施方案

## 1. 目标与边界

本任务只实现效果类工作流第 02 步“AI 信息提炼”。前端保留产品下拉框，顶部按钮只处理当前选中的产品，不提供批量提炼。

已确认的工程决策：

- 数据源与结果库沿用 PostgreSQL + Prisma，不新增 MySQL。
- Python 使用 LangGraph 和本地 Docling，但不直接连接数据库或对象存储。
- NestJS 负责项目隔离、不可变输入快照、任务状态和结果持久化；Python 通过受保护的内部 Worker API 协作。
- 电商链接抓取本期不实现；有链接时生成来源告警并继续。
- seed-2.1-turbo 通过可配置 Ark Provider 接入；开发与自动测试显式使用同契约 Mock Provider，生产禁止静默 Mock。
- 提炼结果是工作流草稿，不自动进入正式项目资产库。
- Prompt、渲染、混剪、导出和后续工作流不在本任务范围。

## 2. 原型基准与已确认偏离

- 冻结原型：`references/prototypes/effect/effect-workflow.html`
- 参考区域：第 02 步“AI 信息提炼”、产品素材制作信息卡、结果表单、状态提示和底部节点导航。
- 保留蓝白视觉、卡片层级、字段密度、圆角、按钮层级及响应式布局。
- 已确认偏离：批量模式也只允许下拉框当前产品单次提炼，删除“全部提炼”入口。
- 为正式异步数据增加紧凑的队列/进度和来源告警反馈，不重构页面信息架构。

## 3. 标准结果契约

标准 JSON 必须完整映射当前页面：

```ts
type EffectExtractionResult = {
  productCategory: string;
  productName: string;
  coreSpecification: string;
  priceRange: string;
  visualFeatures: string;
  targetAudience: string;
  marketingGoal: string;
  coreSellingPoints: string[];
  usageScenarios: string;
  deliveryChannels: string;
  brandTone: string;
  disabledElements: string[];
};
```

共享 TypeScript 契约位于 `packages/contracts/src/effect-extraction.ts`，严格输出 Schema 位于 `packages/contracts/schemas/effect-extraction-result.schema.json`。

## 4. 数据、任务与隔离

持久化模型包含：

- `EffectExtractionRun`：输入快照、来源指纹、任务状态、租约、进度、告警和错误。
- `EffectExtractionBranchOutput`：文档、图片、电商跳过、表单、融合和标准化分支结果。
- `EffectExtractionResult`：模型生成值、人工编辑草稿、来源/冲突报告和修订号。
- `JobOutbox`：与 Run 同事务创建，可靠投递 RabbitMQ。
- `EffectExtractionFileHold`：任务运行期间保护输入文件，终态释放。

所有业务记录和查询必须携带 `projectId`。同一产品同时只允许一个 QUEUED/RUNNING 任务。服务端依据 draft revision、产品字段、有效配置和 READY 材料元数据计算 SHA-256 来源指纹，客户端不得提交或覆盖指纹。

## 5. API

公开基础路径：`/projects/:projectId/workflows/effect/information-extraction`

- `GET ?draftId=...`：返回各产品状态、进度、结果、告警和 STALE 映射。
- `POST /products/:productId/runs`：以 `draftId`、`expectedRevision`、`idempotencyKey` 创建当前产品任务。
- `GET /runs/:runId`：返回任务权威状态，Redis 不可用时回退 PostgreSQL。
- `PUT /results/:resultId`：以 `expectedRevision` 保存完整结果，修订冲突返回 409。

内部 Worker API 使用 `x-worker-token`，提供 claim、heartbeat/progress、输入快照、素材流、分支 upsert、complete 和 fail。RabbitMQ 消息只包含 schemaVersion、projectId、runId 和 requestId，不包含正文、图片或密钥。

## 6. LangGraph 与融合

```text
snapshot
  ├─ documents
  ├─ images
  ├─ commerce-skipped
  └─ form
       ↓ waiting edge
    fusion
       ↓
    normalization
```

- Graph 输入 state 仅 `project_id`，输出 state 仅 `extract_result_id`。
- run/draft/product/sourceFingerprint 放入不可变 RuntimeContext，不进入 state。
- 四分支结果通过内部 API 外部化，使用多起点 waiting edge 等待全部完成。
- 文档 Markdown 存对象存储，分支表只保存 storage key、字段候选和告警。
- 图片分支提取宽高、格式、文件大小，并调用多模态模型提取商品语义。
- 电商分支固定 SKIPPED；表单分支读取产品名称、品类及有效视频配置。
- 字段优先级为：人工表单 > 文档 > 电商 > 图片；数组归一化稳定去重，同级冲突保留备选和告警。
- 最终标准化使用严格 JSON Schema + Pydantic；人工字段在模型输出后再次覆盖。

## 7. Docling 与模型部署

`workers/effect-extraction` 使用 Python 3.12。Docling 嵌入 Worker 容器，默认 CPU 模式；Compose 提供一次性模型初始化服务，将模型下载到持久 volume，Worker 通过 `DOCLING_ARTIFACTS_PATH` 离线复用。

Ark Provider 使用 `ARK_BASE_URL`、`ARK_API_KEY`、`ARK_MODEL`，模型 ID/Endpoint ID不得硬编码。429、5xx 和超时执行有限指数退避；结构校验失败只允许一次修复请求。日志禁止输出密钥、base64、Markdown正文和完整模型输入。

## 8. 实施与多代理边界

- 主代理：本文档、共享契约、高冲突配置、依赖锁、Compose、storage hold 接入、集成和验收。
- 后端代理：Prisma migration、新增 Job/Extraction 模块和后端测试。
- Python代理：`workers/effect-extraction` 内的 Graph、Docling、Provider、Consumer 和测试。
- 前端代理：`apps/web/src/workflows/effect/information-extraction` 内的真实 API、轮询、状态和测试。

代理不得提交 Git，不得回退他人修改。共享接口先冻结，三个实现结束后由主代理串行集成。

## 9. 测试与验收记录

实施前基线：TypeScript 类型检查通过；contracts、API、Web 共 155 项测试通过；前后端构建通过。

2026-08-21 完成后的实际结果：

- `pnpm typecheck`：通过，contracts、UI、API、Web 均无类型错误。
- `pnpm build`：通过，NestJS 与 Vue/Vite 生产构建成功。
- `pnpm lint`：通过。
- Prisma schema 校验通过；9 条 migration 已在独立临时 PostgreSQL 数据库部署成功，临时库随后清理。
- 本节点定向测试：contracts 8/8、API Extraction/Job 24/24、Web 77/77，全部通过。
- Python：`uv run --frozen pytest` 为 8 passed、2 skipped；`uv run --frozen mypy src` 检查 13 个源文件，无错误。两个默认跳过项是需要显式启用的真实 Docling 集成用例。
- 使用 `RUN_DOCLING_INTEGRATION=1` 单独执行真实 Docling：最小 DOCX 与文本 PDF 2/2 通过，耗时 206.64 秒；仅有第三方依赖弃用提示和 Windows HuggingFace symlink 提示。
- `docker compose --profile effect-extraction config --quiet` 通过。Worker 使用官方 uv Python 3.12 镜像并锁定版本；实际镜像构建先遇到 Docker Hub 镜像代理 402 配额，切换官方 GHCR 后又遇到匿名 token 请求 EOF，因此未获得本机 Docker build 成功证据。这是镜像仓库网络前置条件，不是 Dockerfile/Compose 语法失败。
- 中间集成点曾完成全量 189 项 TypeScript 测试。最终复跑时，工作区中并行变化的 `platform/asset`、`platform/project` 出现 8 项既有测试桩失败（Mock 未提供 `$transaction`/`recreateCurrent`，以及新增 `scope` 后断言未同步）；本任务不修改或回退这些他人代码。其余 96 项 API 测试通过，本节点定向 24 项继续全绿。
- 全库 Prettier 最终仅被三个已有脏文件阻塞：`asset.repository.ts`、`asset.service.ts`、`project.service.ts`；本任务文件的 scoped Prettier 通过。`git diff --check` 无空白错误，仅报告 Windows 行尾转换提示。

本地端到端使用独立 PostgreSQL、RabbitMQ、Redis、本地 StoragePort、NestJS API、真实 Docling 和 Mock Ark Provider 跑通：Outbox 投递、Worker claim、并行分支、Markdown 上传、融合、标准化、结果保存和任务重投均成功。联调过程中发现并修复了三处真实契约偏差：Outbox 缺失 `requestId`、Artifact 响应字段不完整、Worker 未使用后端生成的 `sourceFingerprint`。

浏览器在 1440×900 完成以下回归：

- 页面无“全部提炼”，只对当前下拉产品启动任务。
- 实际观察 QUEUED、节点进度、COMPLETED 与来源告警；电商链接跳过不阻断完成。
- 编辑保存后刷新可恢复；上游产品名称改变后由后端返回 STALE，并禁用下一步。
- 重新提炼后 STALE 清除、下一步恢复。
- 双标签制造 409 时，后提交标签的本地编辑保持不被覆盖，并提供“加载最新结果”。
- 浏览器控制台无错误/警告；Web 源码不包含 Ark/Seed 直连，运行请求经 Vite 代理进入 NestJS。

验收截图：

- `docs/验收证据/AI信息提炼-完成态.png`
- `docs/验收证据/AI信息提炼-STALE态.png`
- `docs/验收证据/AI信息提炼-409冲突.png`
- `docs/验收证据/AI信息提炼-重提完成.png`

当前没有 Ark 密钥，因此真实 seed-2.1-turbo 冒烟未执行；Ark 请求体、严格 JSON Schema、重试和修复路径由 MockTransport 契约测试覆盖。提供 `ARK_API_KEY` 和可用 `ARK_MODEL` 后，需再补一次生产 Provider 冒烟。

## 10. 工作区保护

本任务开始时工作区已有未提交修改，尤其涉及环境配置、MinIO、资产、资料包导入、contracts、Compose 和 AI 提炼页面。实施必须在当前内容上增量修改，不覆盖、不回退、不自动提交 Git。
