# 效果类工作流 Step 02「AI 信息提炼」实施方案

## 1. 目标与边界

本任务只实现效果类工作流第 02 步“AI 信息提炼”。前端保留产品下拉框，顶部按钮只处理当前选中的产品，不提供批量提炼。

已确认的工程决策：

- 数据源与结果库沿用 PostgreSQL + Prisma，不新增 MySQL。
- Python 使用 LangGraph 和本地 Docling，但不直接连接数据库或对象存储。
- NestJS 负责项目隔离、不可变输入快照、任务状态和结果持久化；Python 通过受保护的内部 Worker API 协作。
- 电商链接采用 HTTPX 静态抓取、Trafilatura 清洗、隔离 Playwright 动态渲染兜底和 Ark 严格结构化抽取；无链接或页面受限时不阻断其他来源融合。
- seed-2.1-turbo 通过可配置 Ark Provider 接入；开发与自动测试显式使用同契约 Mock Provider，生产禁止静默 Mock。
- 提炼生成结果和人工修改先保存在领域结果表与节点草稿中，不自动提交 WorkingArtifact，也不进入正式项目资产库。
- 当前产品只有点击“完成校验”并通过依赖与结构校验后，才提交 `marketing-insight:{productId}` 工作副本；相同 `contentHash` 不增加 revision。
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
  coreSellingPoints: string[];
  secondarySellingPoints: string[];
  trustBackings: string[];
  targetAudience: string;
  corePainPoints: string[];
  decisionDrivers: string[];
  marketingGoal: string;
  usageScenarios: string[];
  purchaseScenarios: string[];
  emotionalScenarios: string[];
  durationSeconds: number;
  aspectRatio: string;
  deliveryChannels: string;
  disabledElements: string[];
  visualStyleBaseline: string;
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
- `POST /results/:resultId/validate`：校验当前结果及上游依赖，并按 contentHash 提交当前产品洞察工作副本。

内部 Worker API 使用 `x-worker-token`，提供 claim、heartbeat/progress、输入快照、素材流、分支 upsert、complete 和 fail。RabbitMQ 消息只包含 schemaVersion、projectId、runId 和 requestId，不包含正文、图片或密钥。

Worker complete 只写入 `EffectExtractionResult` 并刷新页面恢复基线，不再直接写入 WorkingArtifact。人工编辑自动保存同样不提交工作副本；只有显式完成校验才会使洞察 revision 变化并传播下游 STALE。

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

Ark Provider 使用 `ARK_BASE_URL`、`ARK_API_KEY` 和部署级分节点模型路由。`ARK_DOCUMENT_MODEL`、`ARK_IMAGE_MODEL`、`ARK_NORMALIZATION_MODEL` 分别控制文档抽取、图片理解和结果标准化，未配置时回退到 `ARK_MODEL`；FUSION 继续由确定性代码完成。429、5xx 和超时执行有限指数退避；结构校验失败只允许一次修复请求。日志禁止输出密钥、base64、Markdown正文和完整模型输入。详细规则见 `docs/效果类AI信息提炼-分节点模型路由实施方案.md`。

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

当前没有 Ark 密钥，因此真实 seed-2.1-turbo 冒烟未执行；Ark 请求体、严格 JSON Schema、重试和修复路径由 MockTransport 契约测试覆盖。提供 `ARK_API_KEY` 后，需再补一次生产 Provider 冒烟。

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

## 12. 2026-08-24 增量：真实 Ark 模型接入

Worker 的生产默认 Provider 调整为 Ark，Mock 仅允许由自动测试或显式本地配置启用。推荐配置如下，密钥只写入已被 Git 忽略的本机 `.env`，不得写入仓库、前端、测试数据、截图或日志：

```dotenv
EXTRACTION_AI_PROVIDER=ark
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_API_KEY=<仅本机配置>
```

Worker 与 Compose 默认使用 `doubao-seed-2-1-turbo-260628`，因此正常部署只需配置 `ARK_API_KEY`。`ARK_MODEL` 保留为可选覆盖项，可填写其他已授权 Model ID 或 `ep-...` Endpoint ID。Compose 和 Worker 默认 Provider 均为 `ark`；当 Ark 模式缺少 `ARK_API_KEY` 或其他必需配置时，Worker 必须在启动阶段 fail-fast，不允许静默降级为 Mock。需要本地 Mock 时必须显式配置：

```dotenv
EXTRACTION_AI_PROVIDER=mock
```

继续复用现有 `httpx` Ark Responses Provider，不新增生产依赖。文本候选、图片理解和最终标准化继续使用 Responses API；图片通过多模态 `input_image` 传入，标准化结果使用严格 JSON Schema 并由 Pydantic 二次校验。429、5xx 和网络超时按既有策略有限重试；模型标识、Endpoint 或 Schema 不兼容时将任务标记失败，并仅向工作流弹窗返回安全化错误。日志不得记录 API Key、Authorization、请求正文、图片 Base64、Markdown 原文或完整模型输出。

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

执行真实 Seed 2.1 Turbo 验收前，用户需先在火山方舟控制台开通模型并授权 API Key 访问，再把真实 `ARK_API_KEY` 写入本机 `.env`。默认 Model ID 已由工程配置，无需创建自定义 Endpoint，也无需填写第二个模型变量。只有主动切换模型或自定义推理接入点时才覆盖 `ARK_MODEL`。云端权限、Endpoint 创建与费用不属于代码实施范围，本任务不自动创建或开通云资源。

截至 2026-08-24，用户已有 Ark API Key，且控制台显示该 Key 已获 Doubao-Seed-2.1-turbo 的 Model ID 调用权限，因此无需先创建自定义 Endpoint。把真实 `ARK_API_KEY` 写入本机 `.env` 后，即可执行真实模型冒烟和实际产品资料包验收。本节是对第 9 节“当前没有 Ark 密钥”这一历史验收记录的现状更新，不改写当时的测试事实。

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

真实 Ark 冒烟未执行：当时仓库根目录本机 `.env` 中未检测到真实 `ARK_API_KEY` 和可调用的 `ARK_MODEL`；因此 `RUN_ARK_INTEGRATION` 保持关闭，未发起付费请求。补齐本机真实配置后，需执行 `RUN_ARK_INTEGRATION=1 uv run pytest tests/test_ark_integration.py`，再用实际产品资料包完成最终模型验收。

Worker Docker 镜像构建未能在当前机器完成。首次构建在安装约 2GB 的 Docling/PyTorch Linux CUDA 依赖时发生 Docker I/O 错误并导致 Docker Desktop 退出；恢复 Docker 后确认系统盘仅剩约 0.3GB，第二次构建为避免再次压垮 Docker 被主动停止。该问题不影响本轮 Python 测试、mypy、Compose 配置或应用构建结论，但镜像产物仍待释放足够磁盘空间后重跑 `docker compose --profile effect-extraction build effect-extraction-worker`。本轮未擅自清理 Docker 缓存或用户文件。

## 16. 2026-08-24 Docling 本地部署补充验收

第 15 节记录的 Docker 构建限制已解除。本机 Docker Desktop 4.67.0 的 WSL2 数据目录已通过 Docker Desktop 自身设置接口从系统盘迁移至 `D:\DockerDesktop\wsl`；迁移前对已 TRIM 的动态 VHDX 做原地压缩，未删除镜像、容器或命名卷。迁移后旧 C 盘 VHDX 不再存在，原有 5 个容器、6 个镜像和 5 个命名卷均保留，PostgreSQL、RabbitMQ、Redis、MinIO 恢复为 healthy。

Worker 依赖锁已显式把 `torch` 和 `torchvision` 绑定至 PyTorch CPU 索引，移除 CUDA、NVIDIA 和 Triton 包。镜像实际验证为 `Docling 2.117.0`、`torch 2.13.0+cpu`、`torch.cuda.is_available() == false`。Docling 2.117.0 不再提供镜像内旧 `docling-tools` 可执行文件，模型初始化改用官方 `docling.utils.model_downloader.download_models(output_dir=...)` API。

实际部署与验证结果：

| 验证项          | 结果                                                              |
| --------------- | ----------------------------------------------------------------- |
| Worker CPU 镜像 | 构建成功；`ai-marketing-platform-effect-extraction-worker:latest` |
| 模型初始化服务  | `docling-model-init` 退出码 0                                     |
| 持久模型卷      | `ai-marketing-platform_docling-models`，约 1.3GB                  |
| 模型目录        | Layout、TableFormer/CodeFormula、图片分类器及 RapidOCR 均已落盘   |
| DOCX 容器解析   | 通过；Markdown 包含“测试商品规格 500ml”                           |
| PDF 容器解析    | 通过；Markdown 包含“Product specification 500ml”                  |
| Python 全量测试 | 14 passed、3 skipped                                              |
| Python mypy     | 通过，无错误                                                      |

当前本机 `.env` 的模型已配置为默认 Seed 2.1 Turbo，只剩 `ARK_API_KEY` 仍为占位符，因此未启动真实 Ark Worker，也未发起付费模型请求。Docling 本地解析部署已经完成；填入真实 Key 后再启动 `effect-extraction-worker` 即可进行真实资料包端到端验收。

## 17. 2026-08-24 Model ID 直调兼容

根据方舟控制台 API Key 权限页，当前 Key 可通过 Model ID 直接访问 Doubao-Seed-2.1-turbo，且未配置自定义推理接入点。因此 Worker 已取消 `ARK_MODEL` 必须以 `ep-` 开头的限制；默认模型固定为 `doubao-seed-2-1-turbo-260628`，同时继续允许通过 `ARK_MODEL` 覆盖为其他 Model ID 或自定义 Endpoint ID。Ark 默认 Provider、缺少 API Key 时 fail-fast、显式 Mock、请求重试、严格 JSON Schema 和日志脱敏策略均保持不变。

本次验证结果：Ark 配置及契约测试 `5 passed, 1 skipped`；Python 全量测试在指定工作区临时目录后为 `14 passed, 3 skipped`；`mypy src tests` 通过（24 个源文件）；`docker compose --profile effect-extraction config --quiet` 通过。真实 Ark 冒烟保持关闭，未使用占位凭据发起付费请求。

## 18. 2026-08-24 仅 API Key 配置

为减少本地配置项，Worker、Compose 和本机示例统一把 `doubao-seed-2-1-turbo-260628` 设为默认模型。正常使用只需在被 Git 忽略的 `.env` 中填写真实 `ARK_API_KEY`；`ARK_MODEL` 继续作为可选覆盖项，用于未来切换模型版本或使用自定义 Endpoint。真实冒烟测试未设置 `ARK_MODEL` 时也使用同一默认值。

本次验证结果：Ark 配置及契约测试 `5 passed, 1 skipped`；Python 全量测试 `14 passed, 3 skipped`；`mypy src tests` 通过（24 个源文件）；Compose 展开后的 Worker 模型为 `doubao-seed-2-1-turbo-260628`。真实 Ark 冒烟保持关闭，未发起付费请求。

## 19. 2026-08-24 完成校验提交工作副本

- Worker 生成或重新生成成功只写入 `EffectExtractionResult` 并刷新 `WorkflowNodeState` 恢复基线，不再写入 `marketing-insight` WorkingArtifact。
- 人工编辑的 1 秒防抖、失焦和切换前 flush 只保存结果表与 NodeState；页面显示“存在未校验修改”，不伪装成工作副本已更新。
- 新增当前产品“完成校验”操作，强制 flush 后校验结果结构、最新已完成任务、资料包 revision、产品有效配置 revision 和 `executionInputHash`，成功后才提交 `marketing-insight:{productId}`。
- 提交 payload 的产品名称、品类和 SKU 取生成任务的权威输入快照，不受导入节点尚未校验的后续编辑影响。
- 全部 ACTIVE 产品的洞察工作副本都为 `COMMITTED + CURRENT` 后才允许进入 Prompt 节点。重复校验相同内容返回 `unchanged=true`，不增加 revision 或传播 STALE。本轮 API 提炼定向测试 24 项、API 全量 118 项、Web 全量 89 项通过；全仓 `pnpm check`、Worker pytest/mypy、Compose 配置与 MinIO health 均通过。

## 20. 2026-08-24 提炼节点空白页修复

浏览器复现确认，进入步骤 2 后 `EffectInfoExtractionNodePage` 在 setup 阶段执行 `EFFECT_EXTRACTION_GRAPH_EDGES.filter(...)` 时抛出异常，导致整个节点组件未挂载。共享 contracts 源码和构建产物均包含七节点常量；根因是 Vite 8 对本地 CommonJS workspace 包进行依赖预构建后只暴露 default，而页面使用具名导入。前端 Vite 配置已对 `@ai-marketing/contracts` 显式启用 `optimizeDeps.needsInterop`，并通过 `vite --force` 重建本地依赖缓存；新增配置回归断言防止该互操作选项被误删。

验证结果：提炼信息卡、产品选择、开始提取按钮和七节点工作流弹窗恢复；ESC 关闭弹窗后焦点回到“查看工作流”。提炼布局测试 `5 passed`，Web 全量测试 `89 passed`，Web typecheck 和生产构建通过，`git diff --check` 通过。未改变冻结原型布局、业务字段、API 或工作流生命周期。

## 21. 2026-08-24 节点安全摘要详情

七个 LangGraph 节点现均可通过鼠标、Enter 或 Space 选择，选中节点会在弹窗右侧打开只读详情面板。未启动任务时，面板使用当前产品、人工配置和资料清单生成安全预览；任务已创建后，前端按需请求本次 Run 的持久化分支摘要，并在节点轮询更新时保持所选节点与当前产品隔离。切换产品或关闭弹窗会中止详情请求并清空旧数据。

新增公开接口保持既有基础路径：

```text
GET /projects/:projectId/workflows/effect/information-extraction/runs/:runId/nodes/:nodeId
```

接口先校验项目、Run 和七个固定节点 ID，再从不可变输入快照、`EffectExtractionBranchOutput` 与最终 `EffectExtractionResult` 生成展示 DTO。详情只允许返回：

- 资料快照的素材类型数量、文件名与资料类型；
- 文档和图片节点识别出的用户可理解商品字段；
- 人工配置、融合字段、最终十二字段及其来源标签；
- 电商链接域名，不返回完整 URL；
- 节点处理状态和安全化告警。

字段映射采用显式白名单、数量限制、文本长度限制和 URL/Base64/本地路径脱敏。响应不包含 `sourceId`、`storageKey`、`artifactStorageKey`、原始 Markdown、网页正文、模型 Prompt、图片 Base64、任意未识别 metadata 或 Worker 内部地址。资料来源文件名会移除客户端目录，仅保留 basename。

前端详情面板沿用冻结原型的蓝白卡片、圆角和紧凑信息密度；未引入新图形依赖。桌面端为“拓扑 + 详情”双栏，1120px 以下自动纵向排列。弹窗的 ESC、遮罩关闭、焦点陷阱和关闭后焦点恢复继续有效，不改变十二字段编辑、完成校验、WorkingArtifact 或统一归档生命周期。

本次实际验证结果：

| 验证项                | 命令或方式                                                                                                         | 结果                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| TypeScript 类型检查   | `pnpm typecheck`                                                                                                   | 通过                                                          |
| Lint                  | `pnpm lint`                                                                                                        | 通过                                                          |
| TypeScript 全量测试   | `pnpm test`                                                                                                        | 通过；Contracts 9、API 122、Web 89，共 220 项                 |
| 前后端生产构建        | `pnpm build`                                                                                                       | 通过                                                          |
| 节点详情 API 定向测试 | `pnpm --filter @ai-marketing/api test -- effect-extraction-node-detail.spec.ts effect-extraction.service.spec.ts`  | 13 项通过；覆盖安全白名单、URL/路径/sourceId 不泄漏与项目隔离 |
| 节点详情 Web 定向测试 | `pnpm --filter @ai-marketing/web test -- effect-info-extraction-layout.spec.ts effect-info-extraction.api.spec.ts` | 8 项通过；覆盖唯一入口、节点选择标记、详情面板和编码路径      |
| Python 测试           | `uv run pytest -q --basetemp <workspace-temp>`                                                                     | 16 通过、3 跳过；跳过项为显式启用的 Docling/真实 Ark 集成     |
| Python 类型检查       | `uv run mypy src tests`                                                                                            | 通过；26 个源文件                                             |
| Compose 配置          | `docker compose config --quiet`                                                                                    | 通过                                                          |
| Worker Docker 构建    | `docker compose --profile effect-extraction build effect-extraction-worker`                                        | 通过；CPU Docling/Ark Worker 镜像已生成                       |
| 浏览器桌面回归        | 本地 Vite + NestJS + PostgreSQL                                                                                    | 通过；资料快照、图片和文档节点可切换并显示当前安全摘要        |
| 浏览器键盘回归        | `Shift+Tab` + Enter、ESC                                                                                           | 通过；键盘选择节点，ESC 后焦点返回“查看工作流”                |
| 浏览器窄屏回归        | 600×800 视口读取布局                                                                                               | 通过；详情位于拓扑下方，页面无横向溢出                        |

浏览器验收截图：`docs/browser-regression/ai-extraction-node-detail.png`。本轮未启动真实 Ark 任务，也未发起付费模型请求；真实模型端到端验收仍需把本机 `.env` 中的 `ARK_API_KEY` 占位符替换为有效 Key。

## 22. 2026-08-24 QUEUED 任务诊断与用户视角收敛

针对 Run `8730b116-c4c5-4ca9-8661-cf13c85f1310` 长时间停留在第一个节点前的问题，现场核对确认：Run 已于 `07:05:10` 创建，Outbox 于 `07:05:12` 成功发布且状态为 `PUBLISHED`；RabbitMQ 队列 `effect.extraction.requested` 有 1 条 ready 消息、0 条 unacknowledged 消息和 0 个消费者。因此阻塞点不在 LangGraph、Docling 或资料快照节点，而是 `effect-extraction-worker` 未运行。当前本机 `.env` 的 `ARK_API_KEY` 仍为占位符，真实 Ark 模式按安全策略会拒绝启动。

同时发现本机 API 使用 `API_PORT=3100`，而 Compose Worker 的内部 API 地址此前写死为 3000。Compose 已改为使用 `http://host.docker.internal:${API_PORT:-3000}/api`；本机配置展开后实际为 `http://host.docker.internal:3100/api`。现有 RabbitMQ 消息未删除，填入有效 Ark Key 并启动 Worker 后仍可继续消费。

前端对长时间未被接单的任务增加用户可理解的提示：QUEUED 超过 30 秒后显示“AI 提炼服务暂未接单”，明确任务已保存且不会丢失，不再显示“等待异步 Worker”这类内部技术文案。

节点详情也按用户决策价值收敛：

- 资料快照只显示图片、文档、品牌规范、参考视频的非零数量和具体文件名。
- 移除产品名称、品类、系统 SKU、资料 revision、画幅、时长、渠道等与“有哪些资料”无关的信息。
- 文档和图片节点移除解析字符数、模型截断标记、图片处理尺寸、字节数、MIME 等技术参数，只保留文件名、处理状态和用户可理解的商品字段。
- 节点说明改为“读取文档中的产品信息”“识别图片中的商品信息”“生成可继续编辑的产品信息卡”等业务文案。
- 1120px 以下将拓扑与详情改为上下布局，保证并行节点标题和说明具有足够宽度。

本轮验证：TypeScript 类型检查、Lint 和生产构建通过；全量测试为 Contracts 9、API 123、Web 92，共 224 项；节点详情 API 定向 14 项、Web 定向 10 项通过。Python 为 21 项通过、3 项真实集成测试按配置跳过，mypy 26 个文件无错误。Compose 展开后的 Ark Provider 为 `ark`，Worker 内部 API 地址为 3100。浏览器确认资料快照只出现“1 份商品图片”和文件名，在 1032px 视口下详情位于拓扑下方且无横向溢出。验收截图已更新为 `docs/browser-regression/ai-extraction-node-detail.png`。

后续在 Docker Desktop 恢复后已完成 CPU Worker 镜像刷新，占位 Key 启动拦截、快照契约兼容、表单部分成功、可靠重试和图片受控并发均已固化进当前镜像。`effect-extraction-worker` 已使用真实 Ark 配置持续运行并消费队列，不再存在本节记录的构建限制。

## 23. 2026-08-24 真实 Ark 端到端验收与运行恢复

填入真实 `ARK_API_KEY` 后完成了本机真实资料包验收。现场先后排除了 Worker 未启动、内部 Worker Token 不一致、API 端口不一致以及 Python 快照模型缺少 `dependencySnapshot/dependencies` 字段四个阻塞点。Python 已显式接收后端依赖快照元数据，继续保持 `extra="forbid"` 的严格契约；内部 Token 只存在于被 Git 忽略的本机 `.env` 和运行环境中。

真实 Ark Responses API 的文档候选、三张图片理解和最终标准化请求均返回 HTTP 200；Docling 在本机 CPU 容器中成功解析 `广式腊肠资料包.docx` 并上传 Markdown 中间产物。干净回归 Run `07c5a421-76b1-4680-b7b6-086a94fc2f60` 最终为 `COMPLETED / 100%`，结果 ID 为 `8dc21202-867b-4899-a77e-a48589c9f8b9`。七节点终态为：资料快照成功、文档成功、图片成功、电商无链接跳过、表单缺少品类时部分成功、融合成功、标准化成功。

运行恢复期间同步修复：

- 表单有人工字段但名称或品类不完整时标记 `PARTIAL`，提示“将由其他资料补充”，不再错误标记为 `FAILED` 并阻断融合。
- Worker 遇到明确可重试错误时先调用后端 fail/requeue 流程释放租约，再重投消息；FusionError 和未知 RuntimeError 不再即时重投并制造租约冲突。
- 同一产品的图片理解改为最多三路受控并发，结果保持资料顺序稳定；与文档分支合计最多四个并发模型任务。
- 前端把 `product_category conflict resolved...` 等内部英文冲突报告转换为“品类存在多种识别结果，已优先采用产品文档内容”等简短中文，不展示内部字段名和候选保留实现。

最终浏览器回归确认：当前产品显示“广式腊肠 · 已完成”；工作流弹窗显示 100%；资料快照可点击，详情只显示“3 份图片、1 份文档”、文件名和资料类型，不包含 SKU、MIME、Revision、存储地址或模型输入；英文冲突文案数量为 0。提炼结果已写入结果表与节点草稿；已确认的上一版工作副本保持 `CURRENT / AVAILABLE`，最新生成结果仍按既有生命周期等待用户完成校验后更新 WorkingArtifact。

本轮新增/更新验证：全仓 Lint 通过；TypeScript 全量测试为 Contracts 9、API 124、Web 95，共 228 项；前后端生产构建通过；Python 全量测试 24 项通过、3 项真实配置门控测试跳过；mypy 27 个源文件无错误；Compose 配置校验、Worker Docker 镜像构建和重建启动通过；API 与 Web 健康检查均为 HTTP 200；RabbitMQ 队列为 0 ready、0 unacknowledged、1 consumer。真实密钥未输出到日志、测试、文档或聊天。

## 24. 2026-08-24 节点数据展示与全局视频配置收敛

实施前按用户要求将上一阶段已验证状态提交为 Git 快照 `7d4c42d feat: complete effect extraction workflow`；被忽略的本机 `.env` 与真实 Ark Key 未进入提交。本节变更保留在该快照之后，未再次提交。

表单配置节点不再把十二字段产品信息、分辨率或帧率展示为表单数据，只展示导入节点已经确认的五项全局视频配置：视频时长、画幅比例、风格基调、投放渠道、禁用元素。新 Run 的不可变快照显式携带可选 `globalVideoConfig`；Worker 优先读取该配置，历史 Run 缺少此字段时兼容回退到原有生效配置。产品名称与品类仍作为原架构规定的人工优先融合输入，但不会出现在表单配置节点详情中；缺少品类不再使表单分支变为 `PARTIAL`，也不再产生与视频配置无关的提示。历史 Run 中旧版“表单尚未填写品类”提示在公开展示层被过滤，对应无其他问题的表单节点按成功展示，不修改数据库历史记录。

资料快照改为与导入节点“已导入素材”一致的紧凑素材卡：图片显示真实缩略图，文档显示扩展名标识，每张卡展示文件名、资料类型和文件大小。预览地址只指向现有项目隔离的 NestJS 素材内容接口，不返回 TOS/MinIO storage key、模型输入或原始中间结果。图片识别节点按本次快照顺序逐图展示，每张图片都有独立缩略图、处理状态和该图识别出的业务字段；不再在逐图卡片前重复展示聚合候选字段。

浏览器使用真实已完成 Run 回归：资料快照显示 3 张商品图片和 1 份 DOCX，三张缩略图均成功加载；图片识别节点 DOM 中存在 3 张图片、3 个独立结果卡；表单配置节点恰好显示 5 个字段，旧版品类缺失提示数量为 0，历史表单节点兼容显示“已完成”。新版 Worker 镜像已构建并重建启动，RabbitMQ 保持 0 ready、0 unacknowledged、1 consumer。

最终验证：`pnpm typecheck`、`pnpm lint`、`pnpm build` 均通过；TypeScript 全量测试为 Contracts 9、API 127、Web 96，共 232 项；Python 全量测试 24 项通过、3 项显式集成门控跳过；mypy 27 个源文件无错误；Compose 配置校验和 Worker Docker 构建通过。

## 25. 2026-08-24 文档 AI 超时分类与提示去重

Ark Provider 不再把超时、网络、限流、服务端异常、请求拒绝和结构化响应异常统一压缩为同一句英文。每次失败只持久化安全诊断字段：错误类型、实际尝试次数和总耗时毫秒，不保存请求正文、Markdown、模型原始响应、图片 Base64、Endpoint 或密钥。文档分支遇到 `AI_TIMEOUT` 时公开错误固定为“文档 AI 抽取超时”，错误码为 `DOCUMENT_AI_TIMEOUT`。

节点公开状态会按消息内容去重，并移除与主错误相同的分支告警和单文件告警，因此拓扑卡片与右侧详情只显示一次失败原因。旧 Run 若仍保存通用英文错误，仅在文档分支从 Run 创建到分支结束的安全时长达到 100 秒时兼容识别为超时，避免把快速的 Schema 或请求错误误报成超时。

验证结果：Provider、Pipeline 和内部 API 定向测试 11 项通过；API 节点状态与详情定向测试 20 项通过；Python 全量测试 32 项通过、3 项显式集成门控跳过，mypy 27 个源文件无错误；TypeScript 类型检查、Lint、全量测试、生产构建和 Worker Docker 构建通过。Worker 已重建运行，RabbitMQ 为 0 ready、0 unacknowledged、1 consumer。本轮未触发真实付费 Ark 请求。

## 26. 2026-08-24 “添加卖点”按钮修复

“核心卖点建议 1–3 个”只表示内容建议，不再作为按钮的硬性上限。此前模型结果包含 3 条以上卖点时，前端以 `length >= 3` 禁用按钮，导致用户无法继续补充；现已把前后端共同上限统一为共享契约常量 20。已有 6 条卖点时按钮保持可用，点击后追加一个带“请输入核心卖点”占位提示的空输入框，并继续触发现有防抖自动保存；达到 20 条时才禁用并显示明确上限说明。

本轮验证：Contracts 9、API 131、Web 97，共 237 项 TypeScript 测试通过；类型检查、Lint、Prettier、生产构建和 `git diff --check` 通过。自动浏览器点击因本地 URL 安全策略被阻止，未绕过限制；本地 5173 服务已启动，保留给人工刷新验收。

## 25. 2026-08-24 分节点模型路由

模型配置已从单一 `ARK_MODEL` 扩展为部署级分节点路由：DOCUMENT 使用 `ARK_DOCUMENT_MODEL`，IMAGE 使用 `ARK_IMAGE_MODEL`，NORMALIZATION 使用 `ARK_NORMALIZATION_MODEL`；三个专用变量为空时分别回退到 `ARK_MODEL`。FUSION 继续使用确定性规则，不调用模型。旧环境只配置 `ARK_MODEL` 时保持兼容，运行期失败重试不自动切换模型。

每次模型调用返回独立业务结果和安全 `aiCall` 指标，文档及图片指标写入各自 BranchItem，标准化指标写入 NORMALIZATION Branch。指标包含阶段、实际配置模型、提示词版本、Token、总延迟和尝试次数；usage 缺失或非法时 Token 保存为 null，不影响结果。节点详情继续通过白名单投影，不公开模型标识、Prompt、正文、图片 Base64 或内部调用指标。详细设计和执行记录见 `docs/效果类AI信息提炼-分节点模型路由实施方案.md`。

最终验证：Worker 全量测试 29 项通过、3 项真实集成门控跳过；mypy 27 个源文件无错误；API 节点详情安全投影 6 项通过；Compose 配置校验和 Worker 镜像构建通过；全仓 `pnpm check` 通过，Contracts 9、API 129、Web 96 项测试及 API/Web 生产构建全部通过。用户确认账号可使用全部模型后，DOCUMENT Lite、IMAGE Turbo、NORMALIZATION Mini 的最小真实 Ark 严格 Schema 冒烟通过，真实 Key 未输出或写入文档。

## 26. 2026-08-24 图片驱动的营销信息补全

现场问题确认：旧版图片提示词禁止推断价格、人群和营销目标，旧版标准化提示词又要求只能清理候选数据，因此资料未明确填写的策略字段只能输出“待补充”。本轮将图片分析和标准化提示词升级为 `1.1.0`，建立“硬事实保护、营销策略可推断”的边界。

产品名、规格、配方、产地、认证、功效和销量继续要求明确证据；价格带、目标人群、营销目标、创意卖点、使用场景、渠道、品牌调性和合规风险可以基于已识别品类、视觉特征、规格和场景保守补全。推断价格必须为区间并明确包含“建议、需确认”，不得伪装成用户提供的精确售价；卖点不得升级为无法证明的成分、产地、医疗功效或绝对化承诺。

使用现有广式腊肠主图执行真实“IMAGE Turbo → NORMALIZATION Mini”验收，在不提供文档候选的情况下成功补出建议价格带、目标人群、营销目标、3 项视觉卖点、多个使用场景、品牌调性、建议渠道和合规禁用项；图片无法确认的产品名与规格仍保持“待补充”。两次调用均通过严格 JSON Schema 和 Pydantic 校验，真实 Key 未输出。

## 27. 2026-08-25 产品素材制作信息卡 V2

结果契约升级为 schema v2，并按产品基础、卖点、用户、场景和制作规则五层展示。核心卖点强制 1～3 项，新增次要卖点、辅助信任背书、核心痛点、决策动因、购买场景和情绪共鸣场景；原 `brandTone` 迁移为 `visualStyleBaseline`。时长、画幅、渠道和视觉风格初始继承资料导入节点配置，并直接复用相同的数值输入及可创建自定义值选择控件形成字段级人工覆盖；禁用词继续至少包含资料导入节点配置。

DOCUMENT、IMAGE、NORMALIZATION 三份 Prompt 已升级至 `2.0.0`。图片节点负责在不虚构硬事实与信任背书的前提下补充建议价格、人群、痛点、决策动因、营销目标和三类场景；NORMALIZATION 将溢出的核心卖点迁入次要卖点，且通过独立的 `protected_user_input_json` 接收人工覆盖。API 在 Worker 返回后再次确定性恢复表单配置和 `manualOverrides`，模型不能覆盖用户输入。

生成、重新提炼和自动保存仍不提交 WorkingArtifact；只有“完成校验”才按 V2 contentHash 更新 `marketing-insight:{productId}`。历史 V1 JSON 通过读取适配器转换，旧工作副本不会因迁移隐式增加 revision。详细实施与验收记录见 `docs/效果类AI信息提炼-产品素材制作信息卡完善实施方案.md`。

## 28. 2026-08-25 电商链接解析节点

COMMERCE 分支已从固定 `SKIPPED` 升级为“静态抓取优先、浏览器渲染兜底、Ark 严格结构化抽取”。运行快照仍只接收当前产品的单个 `commerceUrl`，不新增数据库字段或公开 API。HTTPX 以流式方式读取最多 3 MiB 的 HTML，逐次校验最多三次重定向；优先解析 JSON-LD `Product/Offer/AggregateOffer`、OpenGraph 和商品规格，再由 Trafilatura 生成最多 80,000 字符的干净 Markdown。页面仅返回 JavaScript 空壳时，Worker 使用 Bearer Token 调用独立 `commerce-renderer` 服务，由非 root Playwright Chromium 在无 Cookie、禁止下载和 Service Worker 的独立 Context 中渲染，图片、视频和字体在请求前被屏蔽，DOM 上限 2 MiB、总超时 25 秒。

Worker 和 Renderer 均只允许 HTTP/HTTPS 与 80/443 端口，拒绝 URL 凭据、私网、回环、链路本地、保留地址和云元数据地址；主页面、重定向及浏览器子请求均重新执行 DNS 公网地址校验。服务不登录、不注入 Cookie、不处理验证码，也不绕过平台风控。生产部署仍需在容器出口层阻断私网和元数据地址，作为应用校验之外的第二层保护。

网页正文与结构化元数据在 Prompt 中被明确标记为不可信资料，网页内指令不得改变角色或输出契约。确定性 JSON-LD/OG 字段优先于模型推断，Ark 使用 `ExtractionCandidate.v2` 严格 JSON Schema 和 Pydantic 二次验证。`ARK_COMMERCE_MODEL` 为空时依次回退 `ARK_DOCUMENT_MODEL` 和 `ARK_MODEL`，旧环境仍只需提供 Ark API Key。原始 HTML 只存在于内存；清洗 Markdown 通过内部项目隔离、租约保护的产物接口以 `COMMERCE_MARKDOWN` 幂等写入对象存储，Graph state 和 Branch structured output 只保存候选字段、`sourceHost` 与安全诊断。

状态语义固定为：无链接 `SKIPPED`；抓取和模型成功 `SUCCEEDED`；存在确定性商品字段但 AI 失败 `PARTIAL`；页面受限、不可访问或没有可用信息 `FAILED`。除内部 API 持久化失败外，电商来源失败不会中止其他并行分支。节点详情只白名单展示来源网站、商品名称、品类、价格区间、核心规格和卖点；不公开完整 URL、HTTP 状态、抓取模式、耗时、Token、模型、存储键、HTML、正文或其他内部元数据。历史无链接 Run 的旧告警在详情层隐藏，避免与“未提供商品链接，无需解析”摘要重复。

新增隔离服务位于 `workers/effect-commerce-renderer`，Compose 默认以内部地址 `http://commerce-renderer:8080` 连接且不发布宿主端口。Worker 与 Renderer 镜像均已构建，Renderer 健康检查通过，Worker 已使用新镜像重建并恢复 RabbitMQ 消费。定向验证结果：Worker 54 项通过、3 项真实集成门控跳过，mypy 30 个源文件无错误；Renderer 17 项通过且无警告，严格 mypy 通过；API 电商产物、白名单投影和项目隔离测试通过。全仓 `pnpm check` 通过，包含 Lint、Prettier、TypeScript 类型检查、Contracts 9 项、API 141 项、Web 114 项测试及前后端生产构建。浏览器在全新 Vite 依赖环境中确认工作流弹窗可打开、COMMERCE 节点可点击、无链接状态只展示一次用户可理解的跳过摘要；本轮没有提交新的商品链接或触发付费 Ark 请求。
