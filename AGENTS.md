# AGENTS.md

## 1. 项目定位

本项目是公司内部使用的 AI 营销视频素材生产系统。系统以项目为隔离边界，统一管理资料、营销洞察、Prompt、生成任务、工作副本、归档资产和跨项目复用资产。

系统包含三大业务模块：

1. 效果类工作流
2. 定制类工作流
3. 裂变类工作流
   - 爆款视频复刻
   - 数字人口播
   - 局部元素替换

当前实施状态与优先级：

1. 公共项目、文件、资产、工作流草稿和异步任务底座：已完成最小闭环，继续按业务需要增量完善。
2. 效果类第 01 步“资料包导入”：已完成，包含单产品/批量模式、全局视频配置、文件持久化和 revision 并发控制。
3. 效果类第 02 步“AI 信息提炼”：已完成 LangGraph、Docling、Ark、七节点可视化和结果保存，当前正在完善 Result V2《产品素材制作信息卡》。
4. 效果类后续 Prompt、渲染、混剪和导出：按工作流顺序开发。
5. 定制类和裂变类工作流：没有明确要求时不得提前开发。

当前任务只允许修改用户指定的模块及其必要共享契约、迁移和测试。不得因为相邻页面或后续节点存在占位实现而顺带开发。

## 2. 当前技术栈

- 前端：Vue 3 + TypeScript + Vite
- 后端：NestJS + TypeScript
- 数据库：PostgreSQL
- ORM：Prisma
- 包管理：pnpm
- 异步任务：RabbitMQ
- 缓存与任务进度：Redis
- 本地对象存储：MinIO
- 生产对象存储：TOS Adapter（按部署配置启用）
- AI 信息提炼：Python 3.12 + LangGraph + Docling + Pydantic
- 多模态与结构化模型：火山方舟 Ark Responses API，默认 Doubao Seed 2.1 Turbo
- 视频生成：Seedance
- 视频处理：Python + FFmpeg
- 本地编排：Docker Compose

不要在没有说明原因的情况下替换现有技术栈。

增加新的生产依赖前，先说明：

- 为什么需要
- 解决什么问题
- 是否已有依赖可以完成
- 对构建和维护的影响

## 3. 目录边界

前端和后端必须分别维护，禁止跨应用直接引用源码：

- `apps/web`：Vue 前端应用，只负责页面、交互状态和调用 HTTP API
- `apps/api`：NestJS 后端应用，只负责业务规则、数据访问和任务调度
- `workers/effect-extraction`：AI 信息提炼 Python Worker，只通过内部 HTTP API 与 NestJS 协作
- `workers/seedance-worker`：Seedance 异步任务 Worker
- `workers/media-worker`：FFmpeg 等媒体处理 Worker
- `infrastructure/minio`：本地 MinIO 镜像与部署资源

前端公共平台能力放在：

- `apps/web/src/platform/project`：项目上下文与项目切换
- `apps/web/src/platform/asset`：资产选择与资产管理界面
- `apps/web/src/platform/file`：上传与文件预览
- `apps/web/src/platform/job`：任务状态与进度展示

后端公共平台能力放在：

- `apps/api/src/platform/project`：项目管理
- `apps/api/src/platform/asset`：资产管理
- `apps/api/src/platform/file`：文件管理
- `apps/api/src/platform/workflow`：工作流公共调度
- `apps/api/src/platform/job`：异步任务

三大业务工作流分别放在前后端自己的 `workflows` 目录：

- `apps/web/src/workflows/*`：工作流前端页面、组件、Store 与 API 客户端
- `apps/api/src/workflows/*`：工作流后端模块、领域服务与数据访问

工作流固定划分为：

- `effect`
- `customized`
- `fission/clone`
- `fission/avatar`
- `fission/local-replace`
- `fission/shared` 仅允许裂变类三个子工作流内部复用

共享类型放在：

- `packages/contracts`

共享前端组件放在：

- `packages/ui`

AI 信息提炼 Worker 的代码、Prompt 和测试固定放在：

- `workers/effect-extraction/src/effect_extraction`：Graph、Provider、Docling、融合和内部 API Client
- `workers/effect-extraction/src/effect_extraction/prompts`：版本化 `.prompt.txt` 模板
- `workers/effect-extraction/tests`：pytest、mypy 与显式集成测试

Prisma Schema 和迁移固定放在 `apps/api/prisma`。Python Worker 不得维护第二套数据库模型或迁移。

工作流只能调用公共平台能力，不能把业务逻辑写进公共平台目录。

效果类、定制类和裂变类之间禁止直接引用内部实现。

确实需要共享的代码，应提取到：

- `packages/contracts`：前后端共享的数据契约
- `packages/ui`：前端共享的无业务 UI 组件
- 对应应用的 `platform`：应用内部公共能力
- 对应应用的 `workflows/fission/shared`：裂变类内部公共能力

前端不得导入 `apps/api`，后端不得导入 `apps/web`。前后端只能通过 HTTP API 和 `packages/contracts` 中的数据契约协作。Python Worker 不得导入应用源码或直接读取 Prisma；跨语言契约通过消息 Schema、内部 API 和共享 JSON Schema 对齐。

### 3.1 计划文档管理规则

所有准备执行的方案、实施计划和整改计划，必须统一沉淀在项目根目录的：

```text
docs/
```

适用范围包括但不限于：

- 功能实施计划
- 架构设计与重构计划
- 数据库迁移与数据回填计划
- 工作流改造计划
- 问题整改与兼容方案
- 部署、灰度、回滚和验收计划

不得把正式执行计划只保留在聊天记录、临时目录、个人目录或 `.codex` 目录中，也不得把计划文档分散到 `apps/web`、`apps/api`、`packages` 或 `references/prototypes` 中。`references/` 只用于保存外部参考资料和冻结原型，不作为实施计划目录。

如果一个任务需要先制定计划再开发，必须在开始编码前将确认后的计划写入 `docs/*.md`。简单且无需正式计划的修改不强制新建文档；但只要已经生成了要执行的计划，就必须保存到 `docs/`。

计划文档文件名应直接说明业务范围和目的，例如：

```text
docs/工作流草稿与工作副本自动维护方案.md
docs/产品资料包工作副本与Revision整改实施方案.md
docs/效果类工作流-AI信息提炼节点实施方案.md
```

每份执行计划至少应注明：

- 当前状态：待评审、待实施、实施中、已完成、阻塞或废弃
- 目标与实施范围
- 明确不在本次实施中的内容
- 关键数据结构、接口或迁移影响
- 测试与验收标准
- 最后更新时间

实施过程中必须持续更新同一份计划文档，不要为同一计划反复创建“最终版”“修正版”“最新版”等重复文件。发生方案调整时直接记录变更原因和新口径；完成后补充真实代码、迁移、测试、构建与验收结果，不能用计划值代替实际结果。

## 4. 核心业务规则

所有业务数据必须包含 `projectId`。

任何查询都必须按当前项目隔离，禁止项目之间串数据。

工作流数据采用四层生命周期：

1. `WorkflowNodeState`：节点表单、选择项和编辑状态。
2. `WorkingArtifact`：节点生成结果的最新工作副本。
3. `ProjectAsset`：工作流完成后归档的正式项目资产。
4. `GlobalAsset`：用户明确选择后发布的跨项目复用资产。

禁止要求用户在每个节点重复点击“保存到项目资产库”。节点输入、编辑和配置变化只自动保存到 `WorkflowNodeState`，不得直接修改 `ProjectAsset`，也不得创建正式资产版本。

节点状态保存必须支持防抖和合并：文本输入停止后延迟保存，输入框失焦、节点切换前立即保存；内容哈希没有变化时不得重复写入。页面刷新、浏览器异常退出或稍后继续时，应能够恢复当前项目的工作状态，但不得依赖浏览器退出事件完成首次持久化。

生成结果、人工编辑草稿和 `WorkingArtifact` 必须分层。节点生成、重新生成或人工编辑可以先写领域结果表和 `WorkflowNodeState`；只有满足该节点已经确认的提交边界时才更新 `WorkingArtifact`。效果类 AI 信息提炼的提交边界固定为“完成校验”，生成成功和防抖保存不得提前写入营销洞察工作副本。

同一个逻辑产物按 `projectId + workflow + workflowRunId + nodeId + artifactKey` 唯一维护，只覆盖最新工作副本，不因每次编辑创建新资产或新版本。内容哈希没有变化时不得增加 revision、修改 `updatedAt` 或传播下游 STALE；只有有效内容变化时才 revision + 1。

“项目与资产”中的当前项目应分别展示“工作中”和“已归档”数据。工作中数据来自 `WorkflowNodeState` 与 `WorkingArtifact` 的投影视图，不需要复制成正式资产记录，也不得出现在跨项目资产选择器中。

只有用户明确执行“完成工作流并归档”时，系统才把本次工作流的有效 `WorkingArtifact` 统一物化为 `ProjectAsset` 并形成正式版本。普通退出、关闭页面或切换项目只保留草稿并结束会话，不得自动归档。

已归档工作流再次修改时，应创建新的工作副本；只有再次完成并归档后才创建新版本，并保留版本链。

项目归档和全局发布必须分开：Brief、临时 Prompt、失败素材和中间版本可以保留在项目归档中；只有用户明确选择的产品、人物、场景、模板、优质素材或成片，才允许批量发布到全局资产库供跨项目复用。

前端工作流节点不得出现“保存到项目资产库”“保存当前节点产物”或含义相同的节点级手动入库按钮。页面只允许使用非阻塞状态提示，例如“正在保存”“已自动保存”“工作副本已更新”“尚未归档”“归档后有更新”。

跨项目复用采用复制快照：

- 目标项目创建新的资产ID
- 保留来源项目ID
- 保留来源资产ID
- 保留来源版本
- 修改目标资产不能影响源资产

系统公共资产必须先导入当前项目，工作流才能使用。导入属于资产复用操作，不得与节点产物自动保存或项目统一归档混为一套交互。

## 5. 外部模型与异步任务规则

前端禁止直接调用 Ark、Seedance、TOS、MinIO 管理接口或任何需要服务端密钥的外部服务。

统一调用链路：

1. 前端请求 NestJS API。
2. API 校验 `projectId`、revision、幂等键和权限，并事务性创建任务数据。
3. Outbox 将小型任务消息可靠投递到 RabbitMQ。
4. Worker claim 任务并通过受保护的内部 API 读取不可变输入快照。
5. Worker 调用外部模型或本地处理能力，将进度和分支结果写回内部 API。
6. NestJS 原子保存结果，前端只轮询公开任务状态和安全详情。

RabbitMQ 消息只允许携带 schemaVersion、projectId、runId、requestId 等运行标识。禁止把文档正文、Markdown、图片 Base64、模型输入、模型原始输出、对象存储地址或密钥放进消息。

### 5.1 Ark 与 AI 信息提炼

- 生产和默认本地 Provider 为 `ark`；缺少 `ARK_API_KEY` 时 Worker 必须 fail-fast，禁止静默降级 Mock。
- `mock` 只能由自动测试或显式 `EXTRACTION_AI_PROVIDER=mock` 启用，必须保持与真实 Provider 相同的结构化响应契约。
- 默认 `ARK_MODEL=doubao-seed-2-1-turbo-260628`。正常使用只需配置 API Key，不强制 Endpoint ID。
- `ARK_DOCUMENT_MODEL`、`ARK_IMAGE_MODEL`、`ARK_NORMALIZATION_MODEL` 是部署级可选覆盖项，未配置时回退到 `ARK_MODEL`；运行中失败不得擅自切换到其他模型。
- Ark Provider 使用 Responses API 严格 JSON Schema，输出仍须经过 Pydantic 或服务端 Schema 二次验证。
- 429、5xx、网络超时可执行有限重试；请求拒绝、结构错误和业务校验错误不得无限重试。
- 文档、图片和标准化 Prompt 分文件维护，修改时必须同步版本、契约测试和安全边界。

### 5.2 Seedance

Seedance 正确链路仍为“前端 → NestJS → 异步任务 → Worker → Seedance → 结果持久化 → 前端进度”。Seedance 接口暂不可用时保留相同后端接口结构，并由后端显式 Mock；不得在前端组件内模拟真实调用。

### 5.3 密钥与日志

Ark、Seedance、TOS、MinIO 和内部 Worker Token 只能存在于被 Git 忽略的本机 `.env`、进程环境变量或部署平台 Secret 中。

禁止把任何真实 API Key、Token 或 Secret 写入：

- 前端代码或构建产物
- Git 跟踪文件和历史提交
- `.env.example`
- 测试、Fixture 或 Mock 数据
- Prompt、Markdown、截图或聊天内容
- 应用、Worker、HTTP 或 Docker 日志

日志和数据库诊断只允许保存安全化字段，例如阶段、错误类型、尝试次数、总耗时、Token 用量和不可逆请求标识。不得记录 Prompt 正文、文档正文、图片 Base64、完整模型输出或密钥。

## 6. 前端开发规则

正式页面禁止继续使用组件内写死的业务数据。

即使暂时使用 Mock 数据，也必须通过 API 或 Mock Service 返回。Mock 必须保持与共享契约一致，并能被真实 API 无缝替换。

页面状态至少区分：

- 初始状态
- 加载状态
- 成功状态
- 空状态
- 失败状态

不要修改任务范围之外的UI。

复用原型时，原型只作为布局和业务流程参考，不直接复制整份 HTML 到正式项目。

公共组件放入 `packages/ui`；仅单个工作流使用的组件保留在对应工作流目录。

工作流页面还必须遵守：

- 后端持久化状态是任务进度、STALE、告警和终态的唯一事实源。
- 轮询必须可在刷新后恢复；切换项目或产品时取消旧请求、关闭旧详情并防止状态串写。
- 公共拓扑、节点 ID、字段上限和状态枚举必须从 `packages/contracts` 引用，不得在前端复制第二套常量。
- 节点详情只展示用户能理解和用于决策的信息；禁止展示 storage key、MIME、内部 revision、模型标识、Prompt、原始 JSON 或技术堆栈。
- 警告与错误必须去重并使用安全化中文文案，同一个原因不得在拓扑卡、来源卡和详情底部重复出现。
- 所有新增弹窗和交互必须支持键盘、ESC、焦点恢复、窄屏和明确的 loading/empty/error 状态。

## 7. 后端开发规则

Controller 只处理：

- 请求参数
- 权限与项目上下文
- 调用Service
- 返回结果

业务规则放在 Service 或 Domain 层。

数据库访问通过 Repository 或 Prisma Service 完成。

禁止在Controller中直接编写复杂数据库查询和工作流逻辑。

异步模型和视频任务不得阻塞 HTTP 请求。

所有创建、查询、修改和删除操作必须校验 `projectId`。

任务型后端能力还必须遵守：

- Run 与 Outbox 必须同事务创建，避免数据库已写入但消息丢失。
- 同一业务对象的活动任务需要数据库约束、锁或等价机制保证唯一；只靠前端禁用按钮不够。
- claim、lease、heartbeat、重领和重复消息必须幂等；过期 Worker 不得覆盖新 attempt 的结果。
- Redis 只作为进度缓存，读取失败时必须回退 PostgreSQL 权威状态。
- 内部 Worker API 使用独立共享 Token 和 attempt token；Worker 不获得数据库或对象存储凭据。
- 公开 API 响应必须通过白名单 DTO 投影，不能直接返回分支 metadata、存储位置或模型原始数据。
- 错误分类必须保留安全 error code、尝试次数和耗时，同时向用户返回稳定、可理解的文案。

## 8. 类型与接口规则

前后端共用的数据类型放在：

`packages/contracts`

开发前后端或跨语言 Worker 并行功能前，先定义并冻结接口契约。

禁止前端和后端分别维护两套含义相同但字段不同的类型。

AI 信息提炼的结果契约、JSON Schema、Graph 拓扑、节点状态和公开详情类型统一维护在 `packages/contracts`。Python Pydantic 模型必须与同一 Schema 对齐；修改字段时必须同时更新：

- TypeScript 类型与常量
- 共享 JSON Schema
- Prisma 持久化和必要迁移
- Python Pydantic/Provider/Pipeline
- 前端表单、默认值和校验
- 历史数据适配器与测试

结果结构升级必须增加 `schemaVersion` 并提供确定性历史适配。禁止通过调用付费模型完成数据库迁移，也不得隐式改写历史 `WorkingArtifact` revision。

API响应采用统一结构：

```ts
type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  requestId?: string;
};
```

## 9. 效果类资料包导入规则

效果类第 01 步是 AI 信息提炼的唯一上游资料来源。修改该模块时保持以下口径：

- 支持单产品和批量资料包模式，两种模式的草稿、配置、revision 和校验状态分别保存。
- 产品资料分为商品图片和产品文档；文件由后端校验、保存和提供项目隔离的预览/内容接口。
- SKU 是内部标识，不要求用户在资料包表单或清单中填写。
- 全局视频配置固定为视频时长、画幅比例、风格基调、投放渠道和禁用元素。新增字段或单产品覆盖必须先经过需求确认。
- 草稿和上传文件属于工作态数据，不得在节点级直接物化为正式 `ProjectAsset`。
- 所有写接口使用 revision、`If-Match` 或等价 CAS；前端保存队列必须避免并发覆盖和跨项目串写。
- 只有服务端权威校验通过后才允许推进下游，不能以浏览器本地校验代替。

## 10. 效果类 AI 信息提炼规则

### 10.1 范围与拓扑

Step 02 只提炼当前产品下拉框选中的产品，不提供“一键全部提炼”。固定公开节点为：

```text
LOAD_AND_SNAPSHOT
  ├─ DOCUMENT
  ├─ IMAGE
  ├─ COMMERCE
  └─ FORM
       ↓ waiting edge: ALL
    FUSION
       ↓
    NORMALIZATION
```

节点 ID、边和状态只以 `packages/contracts` 为准。当前 COMMERCE 分支固定 `SKIPPED`；存在链接时返回可见告警，不自行实现网页抓取。

LangGraph state 必须保持最小：

```python
InputState = {"project_id": str}
OutputState = {"extract_result_id": str}
```

runId、draftId、productId、requestId、attemptToken 和 sourceFingerprint 放入 runtime context。文档 Markdown、图片结果、分支输出和标准化 JSON 通过内部 API 外部化，禁止进入 Graph state。

### 10.2 分支职责与融合

- DOCUMENT：Docling 本地解析 PDF/DOCX 为 Markdown，再抽取文档明确表达的产品事实、卖点、受众、场景和背书。
- IMAGE：逐图处理技术输入并调用多模态模型，识别包装、形态、质地、构图和使用画面。
- FORM：读取资料导入节点的权威人工字段和全局视频配置；节点详情只展示五项全局视频配置。
- FUSION：使用确定性代码合并、冲突处理和稳定去重，不调用模型。
- NORMALIZATION：通过严格 Schema 整理标准结果和有边界的营销策略建议。

来源优先级固定为：

```text
当前人工修正 > 当前用户表单配置 > 文档明确事实 > 图片明确事实 > AI 策略推断
```

产品名、规格、配方、产地、认证、功效、销量和信任背书等硬事实不得推断。价格带、人群、痛点、决策动因、营销目标、场景、渠道和视觉策略允许基于现有证据保守补全，但必须标识为建议；建议价格使用区间并包含“建议、需确认”。

### 10.3 Result V2《产品素材制作信息卡》

当前结果契约为 schemaVersion 2，按五层展示：

1. 产品基础层：品类、名称、核心规格、价格带、外观特征。
2. 卖点层：核心卖点、次要卖点、信任背书。
3. 用户层：目标受众、核心痛点、决策动因、营销目标。
4. 场景层：使用场景、购买场景、情绪共鸣场景。
5. 制作规则层：视频时长、画幅、投放渠道、禁用元素、视觉风格基线。

字段上限必须引用共享契约常量。核心卖点 1～3 项，超出内容按含义迁入次要卖点而不是截断；信任背书没有明确证据时为空数组。

结果持久化必须区分：

- `generatedResult`：模型结果和服务端恢复的权威表单配置。
- `draftResult`：应用字段级人工覆盖后的当前可编辑结果。
- `manualOverrides`：按字段保存的人工覆盖；数组完整保存，人工清空也是有效值。

重新提炼时继承人工覆盖，并在 Worker 完成后由 NestJS 再次确定性覆盖，不能只依赖 Prompt。历史 V1 结果使用统一适配器读取；迁移不得调用模型，也不得隐式提交 V2 工作副本。

生成、重新提炼和人工编辑只更新领域结果与节点草稿。只有用户点击“完成校验”且通过结果结构、上游 revision、依赖哈希和最新 Run 校验后，才提交 `marketing-insight:{productId}` WorkingArtifact。

### 10.4 任务、部分失败与展示

- 同一产品只允许一个 QUEUED/RUNNING Run；使用来源指纹、幂等键、租约和数据库约束处理并发。
- 文档和图片按源文件记录结果；部分文件成功、部分失败时分支为 `PARTIAL`，可继续融合成功内容。
- 资料快照节点展示本次实际使用的素材卡：图片缩略图、文档扩展名、文件名、资料类型和文件大小。
- 图片识别节点按快照顺序逐图展示独立结果；不得只展示聚合字段，也不得泄露原图存储地址。
- 工作流弹窗展示真实持久化节点状态，刷新后恢复；节点可点击查看安全摘要。
- 公开错误与告警按 code 和消息去重。文档 Ark 超时统一显示“文档 AI 抽取超时”，并只保留安全错误类型、尝试次数和耗时。
- `currentNode` 不能作为并行节点状态的唯一依据；公开 nodes 数组由分支持久化状态推导。

详细方案以以下文档为准：

- `docs/效果类工作流-AI信息提炼节点实施方案.md`
- `docs/效果类AI信息提炼-分节点模型路由实施方案.md`
- `docs/效果类AI信息提炼-产品素材制作信息卡完善实施方案.md`

## 11. 本地部署与运行规则

根目录 `.env.example` 只能提供安全占位符。开发者复制为被 Git 忽略的 `.env` 后配置本机环境。

基础设施：

```powershell
docker compose up -d
```

AI 信息提炼 Worker：

```powershell
docker compose --profile effect-extraction up -d --build effect-extraction-worker
```

Compose 中：

- `docling-model-init` 是一次性模型初始化任务，成功后 `Exited (0)` 属于正常终态。
- `effect-extraction-worker` 是常驻消费者，必须保持运行。
- Docling 模型存放在 `docling-models` named volume，Worker 以只读方式挂载。
- Docling 使用 CPU 版 PyTorch；不得无理由引入 CUDA、NVIDIA 或 Triton 依赖。
- Worker 内部 API 地址跟随 `API_PORT`，Docker 访问宿主机使用 `host.docker.internal`。

默认 Ark Model ID 已配置，真实运行只要求本机填写 `ARK_API_KEY`。不要要求用户额外创建 Endpoint；只有用户主动使用自定义推理接入点时才配置 `ep-...`。

## 12. 测试与验收规则

修改必须按风险执行最小充分验证，并在交付时报告实际命令和结果。不得把计划数字或历史测试结果写成当前通过结果。

TypeScript 常规门禁：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm lint
pnpm exec prettier --check .
```

完整门禁：

```powershell
pnpm check
```

Python Worker：

```powershell
Set-Location workers/effect-extraction
uv run --frozen pytest
uv run --frozen mypy src tests
```

容器配置与镜像：

```powershell
docker compose --profile effect-extraction config --quiet
docker compose --profile effect-extraction build effect-extraction-worker
```

真实 Docling 和 Ark 测试必须通过显式环境开关启用。真实 Ark 测试会产生费用，未获用户授权或缺少真实本机 Key 时不得执行，也不得用跳过项冒充通过。

涉及前端交互时还必须完成浏览器回归，至少覆盖加载、空态、失败、刷新恢复、产品/项目切换、窄屏、键盘、并发冲突和浏览器不直连 Ark。截图放入 `docs/browser-regression/`，不得包含密钥或敏感业务正文。

## 13. Git 与工作区保护

- 工作区已有修改默认属于用户或其他任务，必须保留；不得 reset、checkout、覆盖或顺带格式化无关文件。
- 提交前只暂存当前任务文件，并检查 staged diff、敏感信息和 `git diff --check`。
- 除非用户明确要求，否则不要创建 Git 提交、推送、强制推送或修改远端分支。
- 子代理不得自行提交；由主代理在集成、测试和用户授权后统一处理。
- 不得提交 `.env`、本地存储、模型缓存、Docker 数据盘或真实测试产物。
- 密钥一旦进入提交历史，先在云端废弃/轮换，再重写尚未推送的历史；不得点击 Push Protection 绕过链接。
- 禁止使用 `git reset --hard`、`git checkout --` 或其他会丢失工作区内容的命令，除非用户明确指定目标并授权。

## 14. 原型参考规则

凡是涉及页面、组件、交互或视觉样式的前端任务，必须先查看 `references/prototypes/` 中对应的冻结原型，并以原型作为正式前端的默认设计基准。不得在已有原型覆盖的功能上另起一套页面结构或视觉方案。

业务模块与原型文件固定对应如下：

| 正式功能                                                       | 必须参考的原型                                                 | 具体参考范围                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| 全局系统外壳、顶部导航、当前项目入口、项目与资产入口、公共弹窗 | `references/prototypes/integrated/system-integrated-demo.html` | 系统级导航、整体蓝白视觉、页面容器和公共入口                 |
| 效果类完整工作流                                               | `references/prototypes/effect/effect-workflow.html`            | 导入、提炼、Prompt、渲染、模板混剪入口、成片输出等效果类流程 |
| 效果类模板混剪与时间轴精修                                     | `references/prototypes/effect/effect-mix-workbench.html`       | 模板配置、批量智能素材填充、成片工程列表、精修工作台和时间轴 |
| 定制类工作流                                                   | `references/prototypes/customized/customized-workflow.html`    | Brief、分镜脚本、逐镜 Prompt、资产绑定、逐镜渲染和交付流程   |
| 裂变类爆款视频复刻                                             | `references/prototypes/fission/fission-workflows.html`         | “爆款视频复刻”业务模块及其工作流节点                         |
| 裂变类数字人口播                                               | `references/prototypes/fission/fission-workflows.html`         | “数字人口播”业务模块及其工作流节点                           |
| 裂变类局部元素替换                                             | `references/prototypes/fission/fission-workflows.html`         | “局部元素替换”业务模块及其工作流节点                         |

如果一个任务同时涉及系统公共外壳和具体工作流，应以具体工作流原型决定业务页面，以整合版原型决定全局导航和公共容器。原型索引与用途说明见 `references/prototypes/README.md`。

前端实现必须继承对应原型中已经确认的：

- 业务流程和步骤顺序
- 页面信息结构和业务字段
- 页面布局、区域比例和内容密度
- 蓝白配色、卡片层级、间距、圆角和按钮层级
- 表格、表单、弹窗、工作流画布和状态反馈的交互方式
- Mock 场景、状态和异常文案

“强制参考样式”不等于复制原型代码。禁止直接复制原型中的整份 HTML、内联 CSS、全局脚本或组件内 Mock 实现。所有正式功能必须使用当前 Vue、NestJS、Prisma 和共享契约重新实现，并将可复用视觉模式拆分为正式 Vue 组件。

每个开发任务必须明确说明：

- 上表中对应的原型文件完整路径
- 具体参考的业务模块、流程节点或页面区域
- 本任务允许实现的功能范围
- 明确不在本任务中实现的相邻模块

执行前端任务时，必须先打开并检查对应原型，再开始设计和编码。不得只写“参考原型实现”。如果任务没有给出具体参考区域，应依据上表主动定位并把范围收敛到当前功能，禁止顺带迁移整套页面。

只有出现以下情况时才允许偏离原型样式：

- 用户在当前任务中明确要求修改原型设计
- 原型交互不满足正式数据、权限、响应式或可访问性要求
- 原型中存在已经被用户确认废弃的旧功能

发生偏离时，必须在实施前说明原型现状、偏离位置、原因和替代方案；未说明时默认保持原型样式。不得以“优化”“现代化”或“重新设计”为由自行改变用户已确认的界面。

当原型、任务说明和本文件存在冲突时，优先级为：

1. 用户当前任务要求
2. `AGENTS.md` 中的工程与业务规则
3. 冻结原型中的交互和视觉表现

原型中的网络调用、数据存储方式和技术实现不具有约束力；正式工程的接口、安全、状态管理和数据持久化仍以本文件的工程规则为准。
