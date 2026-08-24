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

## 11. 2026-08-24 增量：LangGraph 工作流可视化

本次在第 02 步页面标题操作区增加唯一的“查看工作流”按钮，位置与产品下拉框、“开始/重新提炼”按钮相邻。按钮在运行前、运行中和完成后均可使用，打开只读弹窗展示实际 LangGraph 拓扑与后端持久化状态，不展示或允许编辑中间业务数据。

固定拓扑由共享契约统一定义，前端不得复制另一套节点名称或执行顺序：

```text
资料快照
  ├─ 文档解析
  ├─ 图片识别
  ├─ 电商链接
  └─ 表单配置
       ↓ waiting edge
    多源融合
       ↓
    标准化与结果保存
```

七个固定节点 ID 为：

| 节点 ID             | 展示名称         | 拓扑分组 |
| ------------------- | ---------------- | -------- |
| `LOAD_AND_SNAPSHOT` | 资料快照         | 输入     |
| `DOCUMENT`          | 文档解析         | 并行分支 |
| `IMAGE`             | 图片识别         | 并行分支 |
| `COMMERCE`          | 电商链接         | 并行分支 |
| `FORM`              | 表单配置         | 并行分支 |
| `FUSION`            | 多源融合         | 融合     |
| `NORMALIZATION`     | 标准化与结果保存 | 输出     |

节点公开状态统一为 `PENDING`、`RUNNING`、`SUCCEEDED`、`PARTIAL`、`SKIPPED`、`FAILED`，分别对应等待、运行中、成功、部分成功、已跳过和失败。`EffectExtractionRun` 增加完整 `nodes: EffectExtractionNodeExecution[]`，每个节点只公开 `nodeId`、`status`、安全化 `warnings` 和安全化 `errorMessage`。响应不得包含 Markdown、图片内容、模型输入、结构化中间结果、对象存储地址或 Worker 内部字段。

后端以 `EffectExtractionBranchOutput` 为六个业务节点的唯一状态来源；资料快照节点依据 Run 状态及分支是否开始推导。缺少分支记录时返回 `PENDING`；Run 失败时，仍处于 `RUNNING` 的节点对外映射为 `FAILED`。所有查询继续以 `projectId` 隔离，现有公开接口路径保持不变：

- `POST /products/:productId/runs`
- `GET /runs/:runId`

弹窗复用现有 Run 轮询自动更新。刷新页面后，打开弹窗会重新获取当前 Run；切换产品时立即关闭旧弹窗，避免旧产品状态串写。弹窗支持遮罩、ESC、关闭按钮、键盘焦点约束和 `role="dialog"`；窄屏下四个并行节点改为纵向布局。视觉继续遵循 `references/prototypes/effect/effect-workflow.html` 的蓝白卡片、圆角、间距和按钮层级，不引入图形库，不改变页面十二字段、自动保存、WorkingArtifact 或统一归档生命周期。

## 12. 2026-08-24 增量：真实 Ark Endpoint 接入

Worker 的生产默认 Provider 调整为 Ark，Mock 仅允许由自动测试或显式本地配置启用。推荐配置如下，密钥和 Endpoint ID 只写入已被 Git 忽略的本机 `.env`，不得写入仓库、前端、测试数据、截图或日志：

```dotenv
EXTRACTION_AI_PROVIDER=ark
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL=ep-...
ARK_API_KEY=<仅本机配置>
```

`ARK_MODEL` 使用方舟控制台创建的 Seed 2.1 Turbo Endpoint ID（`ep-...`），不将展示名称或模型家族名当作可调用 Endpoint。Compose 和 Worker 默认值均为 `ark`；当 Ark 模式缺少 `ARK_API_KEY`、`ARK_MODEL` 或其他必需配置时，Worker 必须在启动阶段 fail-fast，不允许静默降级为 Mock。需要本地 Mock 时必须显式配置：

```dotenv
EXTRACTION_AI_PROVIDER=mock
```

继续复用现有 `httpx` Ark Responses Provider，不新增生产依赖。文本候选、图片理解和最终标准化继续使用 Responses API；图片通过多模态 `input_image` 传入，标准化结果使用严格 JSON Schema 并由 Pydantic 二次校验。429、5xx 和网络超时按既有策略有限重试；模型、Endpoint 或 Schema 不兼容时将任务标记失败，并仅向工作流弹窗返回安全化错误。日志不得记录 API Key、Authorization、请求正文、图片 Base64、Markdown 原文或完整模型输出。

浏览器仍只调用 NestJS API；Ark 密钥和 Ark 请求只能存在于 Worker 侧。当前工程继续使用 RabbitMQ、数据库持久化与前端轮询展示进度，不引入 LangGraph 前端 SDK，也不改变现有任务恢复机制。

## 13. 2026-08-24 增量测试与验收口径

本次增量完成后需执行以下验证，并将实际命令、结果、失败原因和截图继续回填本文档：

- Contracts：七节点拓扑完整、节点 ID 唯一、边只引用有效节点、Run 响应节点状态合法。
- API：覆盖并行分支乱序，以及 `PENDING/RUNNING/SUCCEEDED/PARTIAL/SKIPPED/FAILED` 映射；验证 Run 失败映射、项目隔离、Redis 降级和中间输出不泄漏。
- Worker：Graph 节点集合与公开契约一致；验证 Ark Responses 请求、严格 Schema、有限重试、日志脱敏、默认 Ark fail-fast 和 Mock 只能显式启用。
- Web：验证按钮唯一、弹窗开关、运行中自动更新、刷新恢复、产品切换关闭、告警/失败展示、ESC/焦点/遮罩交互及窄屏纵向布局。
- 回归：执行 TypeScript 类型检查、Lint、单元测试、生产构建、Python pytest/mypy、Compose 配置检查和 Worker Docker 构建。
- 浏览器：实际观察四分支并行、融合、标准化与完成状态；确认 Network 中仅请求 NestJS，不存在浏览器直连 Ark。
- 生命周期：真实提炼完成后核对数据库标准结果、WorkingArtifact 自动更新、刷新恢复；确认没有新增节点级“保存到项目资产库”按钮，且未提前创建 ProjectAsset。

真实 Ark 冒烟测试必须显式启用，至少覆盖：文本候选抽取、图片理解和最终标准化。测试过程不得打印请求正文、图片 Base64 或密钥；未显式启用时应安全跳过，不能用 Mock 结果冒充真实模型验收。

## 14. 真实模型验收前置条件与当前限制

执行真实 Seed 2.1 Turbo 验收前，用户需先在火山方舟控制台开通模型并创建可用 Endpoint，再把 `ARK_API_KEY` 和 `ARK_MODEL=ep-...` 写入本机 `.env`。Endpoint 创建、云端权限与费用不属于代码实施范围，本任务不自动创建或开通云资源。

截至 2026-08-24，用户已有 Ark API Key，但尚需先创建并配置 Seed 2.1 Turbo Endpoint。因缺少可调用的 `ep-...`，真实模型冒烟和实际产品资料包验收仍是待执行项；在此之前只能完成请求契约、配置 fail-fast、Mock 回归和浏览器交互验证。本节是对第 9 节“当前没有 Ark 密钥”这一历史验收记录的现状更新，不改写当时的测试事实。

## 15. 2026-08-24 实施结果与验收记录

本次增量已完成七节点公共契约、API 持久化状态映射、前端真实状态弹窗、Ark 默认 Provider、显式 Mock、真实 Ark 条件冒烟测试及配置文档。实施时保留了工作区原有的 WorkflowNodeState、WorkingArtifact、文件对象和依赖修订改动，仅对两处会阻塞全仓 Lint 的既有代码做了无行为变化的机械修正（移除未使用类型导入、将未重新赋值变量改为 `const`）。未创建 Git 提交。

实际验证结果：

| 验证项              | 命令或方式                       | 结果                                                                              |
| ------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| TypeScript 类型检查 | `pnpm typecheck`                 | 通过                                                                              |
| TypeScript 全量测试 | `pnpm test`                      | 通过；Contracts 9、API 110、Web 87，共 206 项                                     |
| Lint                | `pnpm lint`                      | 通过                                                                              |
| 前后端生产构建      | `pnpm build`                     | 通过                                                                              |
| Python 测试         | `uv run --frozen pytest`         | 13 通过，3 跳过；跳过项为需显式环境开关的 Docling/真实 Ark 集成                   |
| Python 类型检查     | `uv run --frozen mypy src tests` | 通过；23 个源文件                                                                 |
| Compose 配置        | `docker compose config --quiet`  | 通过                                                                              |
| 工作区差异检查      | `git diff --check`               | 通过；仅有 Windows LF/CRLF 提示                                                   |
| 浏览器桌面回归      | 本地 Vite + 只读 Mock API        | 通过；唯一按钮、七节点拓扑、部分完成、跳过、告警、关闭与结果页面均正常            |
| 浏览器键盘回归      | ESC 关闭并读取活动焦点           | 通过；关闭后焦点回到“查看工作流”按钮                                              |
| 浏览器窄屏回归      | 540×900 视口读取计算样式         | 通过；四个并行节点变为单列且宽度一致                                              |
| 浏览器请求边界      | 记录本地 Mock API 请求           | 通过；只出现 `/api/projects/...` NestJS 路径，未出现 Ark 域名或 `/responses` 直连 |

浏览器验收截图：

- `docs/browser-regression/ai-extraction-workflow-desktop.png`
- `docs/browser-regression/ai-extraction-workflow-mobile.png`

真实 Ark 冒烟未执行：当前仓库根目录本机 `.env` 中未检测到非空 `ARK_API_KEY`，也未检测到 `ARK_MODEL=ep-...`；因此 `RUN_ARK_INTEGRATION` 保持关闭，未发起付费请求。用户创建 Endpoint 并补齐本机配置后，需执行 `RUN_ARK_INTEGRATION=1 uv run pytest tests/test_ark_integration.py`，再用实际产品资料包完成最终模型验收。

Worker Docker 镜像构建未能在当前机器完成。首次构建在安装约 2GB 的 Docling/PyTorch Linux CUDA 依赖时发生 Docker I/O 错误并导致 Docker Desktop 退出；恢复 Docker 后确认系统盘仅剩约 0.3GB，第二次构建为避免再次压垮 Docker 被主动停止。该问题不影响本轮 Python 测试、mypy、Compose 配置或应用构建结论，但镜像产物仍待释放足够磁盘空间后重跑 `docker compose --profile effect-extraction build effect-extraction-worker`。本轮未擅自清理 Docker 缓存或用户文件。
