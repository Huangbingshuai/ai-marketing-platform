# AI 营销素材智能生成系统

公司内部使用的 AI 营销视频素材生产平台。系统以项目为隔离边界，统一管理产品资料、营销洞察、Prompt、生成任务、工作副本和归档资产。

当前优先建设效果类黄金链路，已完成公共项目底座、资料包导入、AI 信息提炼和素材片段 Prompt 生成；视频渲染、模板混剪和成片导出仍按工作流顺序继续开发。

> 文档状态：与当前工作区实现同步
>
> 最后更新：2026-08-31

## 当前进度

```text
项目与资产底座
  └─ 效果类工作流
      ├─ 01 资料包导入        已完成
      ├─ 02 AI 信息提炼       已完成
      ├─ 03 Prompt            已完成
      ├─ 04 渲染              待开发
      ├─ 05 混剪              待开发
      └─ 06 导出              待开发
```

当前六个业务节点的真实实现边界：

| 节点           | 状态   | 当前权威产物与提交边界                                                                                                               |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 01 资料包导入  | 已完成 | 完成校验后提交每个产品的 `source-package:{productId}`，只维护商品资料、图片、文档和电商链接。                                        |
| 02 AI 信息提炼 | 已完成 | 生成 schema v3《产品素材制作信息卡》，只维护产品、卖点、受众、痛点和场景等可信事实；完成校验后提交 `marketing-insight:{productId}`。 |
| 03 Prompt 生成 | 已完成 | 维护数量、时长、视觉风格基调、渠道和禁用元素，生成连贯六维素材 Prompt 批次；完成校验后提交 `prompt-batch:{productId}`。              |
| 04 视频渲染    | 开发中 | 独立维护画幅、分辨率和 Seedance 能力，读取已提交 Prompt 并编译不可变请求快照；完整异步渲染仍在完善。                                 |
| 05 模板混剪    | 待开发 | 尚未实现素材池智能填充、成片工程和时间轴精修。                                                                                       |
| 06 成片输出    | 待开发 | 尚未实现最终合成、质量管理和批量导出。                                                                                               |

已经落地的核心能力：

- Vue 3 前端、NestJS API、PostgreSQL + Prisma 数据层和共享 TypeScript 契约。
- 项目上下文、项目隔离、工作流草稿、工作副本、正式资产和版本生命周期。
- 效果类单产品/批量资料包导入、图片与文档上传、revision 并发控制和刷新恢复。
- RabbitMQ Outbox 可靠投递、Redis 进度缓存、任务租约和重复消息恢复。
- Python 3.12 + LangGraph AI 提炼 Worker。
- 独立 Prompt 生成 Worker：可信事实准备、AI 产品专属创意版图、8～24 个 AI 创意方向、分片事实复核与全批视觉去重复核、连贯六维创意生成、独立质量评估与多用途分类、精确数量择优和一次定向补充。
- Prompt 批次严格匹配用户设置的总数量；钩子、产品展示、效果、结尾转化四类是生成后的推荐/兼容用途标签，不是生成配额或独立生产线。
- Prompt 生成只维护一套八阶段工作流，不再通过代码版本或图版本选择不同执行路径。
- 火山正文向量 + 业务语义簇联合 MMR 择优：通常质量占 70%、相对新颖度占 30%，候选正文近重复率超过 50% 时当轮切换为 60% / 40%；新颖度同时观察正文、场景原子和产品主动作，人工保留项和单条重生成的其他条目作为固定参照。一般相似只影响软排序和提醒，不淘汰候选。
- Docling 本地解析 PDF/DOCX，模型文件通过 Docker named volume 持久化。
- 电商链接静态抓取、JSON-LD/OpenGraph/京东内嵌数据解析，以及隔离 Playwright Chromium 动态渲染兜底。
- 火山方舟 Ark Responses API 文档抽取、图片理解、电商信息补全和标准结果生成。
- 七节点工作流状态弹窗、节点详情、逐文件处理结果、告警和安全化错误展示。
- schema v3《产品素材制作信息卡》五层结构、目标受众列表、受控分辨率、人工修正、来源追踪、冲突报告和旧版结果兼容。
- 提炼结果草稿自动保存；只有完成校验后才提交 `WorkingArtifact`，完成整个工作流时才统一归档为 `ProjectAsset`。

### 当前验证基线

2026-08-28 基于当前工作区代码完成全量自动回归：

| 范围           | 结果                             |
| -------------- | -------------------------------- |
| 共享 Contracts | 3 个测试文件、17 项测试通过      |
| NestJS API     | 相关测试 229 项通过              |
| Vue Web        | 相关测试 152 项通过              |
| 提炼 Worker    | 81 项通过、4 项付费/集成门控跳过 |
| Prompt Worker  | 97 项通过、1 项付费集成门控跳过  |

`pnpm check` 已完整通过 Lint、Prettier、TypeScript 类型检查、测试和生产构建；两个 Worker 的 pytest、mypy 及 Prompt ruff 也已通过。Prompt 与信息卡页面已完成桌面和窄屏浏览器验收。自动测试默认不调用 Ark 或 Seedance 付费接口。

## 系统架构

```text
Vue Web
   │ HTTP /api
   ▼
NestJS API ───── Prisma ───── PostgreSQL
   │  │
   │  ├─ Redis：任务进度与降级缓存
   │  ├─ MinIO：导入文件与 Docling Markdown
   │  └─ RabbitMQ：异步任务消息
   │                   │
   │ internal API      ▼
   └──────────── Python LangGraph Workers
                         ├─ AI 信息提炼：Docling + Ark + 进程内 Playwright Chromium
                         └─ Prompt 生成：事实视觉策略 + 连贯创意 + 独立评估
                                           └─ 火山正文向量 + 本地 NumPy MMR 择优
```

边界约束：

- `apps/web` 只通过 HTTP API 访问后端，不导入后端源码，也不直连 Ark。
- `apps/api` 负责项目隔离、业务规则、任务调度和数据持久化。
- Python Worker 不直连 PostgreSQL、Prisma、MinIO 或 TOS，只使用受保护的 NestJS 内部 API。
- RabbitMQ 消息只携带运行标识，不携带文档正文、图片、模型输入或密钥。
- 前后端共享类型统一维护在 `packages/contracts`。

## AI 信息提炼工作流

Step 02 只处理当前下拉框选中的产品，不提供批量提炼入口。

```text
资料快照
  ├─ 文档解析：Docling → Markdown → 信息表确定性解析；非结构化文档才使用 Ark 兜底
  ├─ 图片识别：图片预处理 → Ark 多模态逐图识别
  ├─ 电商链接：安全校验 → 静态解析 → Playwright 兜底 → Ark 商品字段抽取
  └─ 表单信息：读取导入节点的产品名称与品类
             ↓ 等待四分支完成
          多源融合
             ↓
       语义整理与字段归类
             ↓
       确定性标准化与结果保存（异常时模型兜底）
```

电商分支优先读取 JSON-LD、OpenGraph、商品正文和京东页面内嵌数据；静态内容不足时由提炼 Worker 内置的 Playwright Chromium 渲染动态 DOM。没有链接时节点为 `SKIPPED`；受到登录、验证码或平台风控限制时，不尝试绕过限制，并以安全化告警继续融合其他资料。

事实字段的融合优先级为：当前人工修正/表单 > 文档 > 电商 > 图片。图片模型可根据明确画面证据保守补充卖点、痛点、受众、决策动因、营销目标和场景建议，但不能覆盖已经确认的用户事实；核心外观特征只在资料缺失时由识图补齐。图片产生的核心与次要卖点会完整进入语义整理，不再提前丢弃。语义模型统一负责跨字段归类、同义/父子/同主题关系和字段超量时的信息价值排序，并把用户提供的产品名称、品类、规格和核心外观特征作为不可修改的去重参照；Worker 只验证已有事实 ID、来源权限、字段数量与结构，不使用字符或业务关键词自行判断语义。AI 新提炼容量固定为核心卖点最多 3 项、次要卖点最多 6 项，其余营销信息列表最多 5 项；人工编辑草稿继续使用 20 项安全边界。每项图片建议直接显示在对应信息卡字段内，并标注来源图片。结构化融合结果由 Worker 确定性契约化并通过 Pydantic 校验，只有异常时才调用标准化模型兜底。

LangGraph state 只保存小型标识：

```python
InputState = {"project_id": str}
OutputState = {"extract_result_id": str}
```

文档 Markdown、图片处理结果、分支输出和标准化 JSON 均外部化存储，不把大文本塞进 Graph state。

schema v3 完整映射前端《产品素材制作信息卡》的五层 21 个业务字段：

1. 产品基础：品类、产品名称、核心规格、价格带、核心外观特征。
2. 卖点与背书：核心卖点、次级卖点、信任背书。
3. 用户与决策：逐条目标受众、核心痛点、决策因素、营销目标；历史 `targetAudience` 只作为服务端派生摘要。
4. 使用与情绪场景：核心使用场景、购买场景、情绪场景。
5. 历史兼容字段：旧结果中的视频制作配置仍可读取，但新流程不再把它们作为信息卡事实或下游权威输入。

生成成功和编辑防抖只保存领域结果与页面草稿；用户点击“完成校验”后才提交 `marketing-insight:{productId}` 工作副本。旧版结果通过兼容层读取，不要求一次性回填历史数据；历史大写分辨率会规范成火山接口的小写枚举。

详细设计与验收记录见 [效果类工作流 Step 02「AI 信息提炼」实施方案](docs/workflows/effect/plans/效果类工作流-AI信息提炼节点实施方案.md) 和 [产品素材制作信息卡完善实施方案](docs/workflows/effect/plans/效果类AI信息提炼-产品素材制作信息卡完善实施方案.md)。

## 素材片段 Prompt 生成工作流

Step 03 读取当前产品已提交的 `marketing-insight:{productId}`，生成供后续逐条渲染和模板混剪使用的素材片段 Prompt。一条 Prompt 对应一个短视频素材片段，不是完整广告或最终成片。

当前页面开放 Prompt 总数量、统一片段时长、投放渠道、视觉风格基调和禁用元素。视觉风格默认“AI 根据场景选择”，也可指定整批基调；不再按用途设置数量、时长、语义重复率或画面重合率。钩子、产品展示、效果和结尾转化是生成后的素材用途标签，一条 Prompt 可以有一个推荐用途和多个兼容用途；效果片段只表达已确认的使用结果或产品价值，不允许用画面虚构配方、工艺或功效证明。

视觉风格和渠道直接来自 Prompt 批次设置，不再回读信息卡的历史视频配置。画幅、分辨率和 Seedance 能力由视频渲染节点按商品独立保存；修改它们只影响之后创建的渲染任务，不会使信息提炼或 Prompt 过期。

公开子工作流先准备已确认的产品事实，再通过一次批次级 AI 调用编译事实视觉策略：哪些事实可以直接拍、哪些适合动作展示、哪些只能作商业背景、哪些禁止用画面证明。每次用户重新批量生成都会重新编译，不从历史批次复用；同一任务因网络或 Worker 故障重试时才允许恢复本 Run 已成功的检查点。随后共用提示词只编译一次，批次创意导演会结合事实视觉策略与 Prompt 节点设置的视觉风格基调规划差异化方向；方向数量同时按目标 Prompt 数和必须覆盖的业务事实数计算，范围为 8～24 个，50 条默认规划 20 个。富信息商品的每个方向由模型关联 2～4 项事实，中等或稀疏商品按事实密度降低单方向下限，避免机械重复，但整批仍必须覆盖全部卖点、痛点、受众、决策动机、营销目标和确认场景。同一真实业务空间可以集中承载事实，Worker 按每 4 项事实增加一个方向槽位，不再用固定空间容量迫使模型拆分同义场景。首次遗漏时由模型根据缺失清单完整重规划，Worker 不随机补挂事实。风格基调只控制光线、色彩、材质和镜头质感，不能反向虚构厨房、门店、节庆或人物场景。每条创意任务完整继承所属方向的事实使用方案和只负责商品真实性边界的 `productSnapshot`，再由模型同时生成干净正文与六维创意信息；独立评估模型负责判断计划事实是否真正实现，Worker 不做语义判断。

目标 50 条时，Worker 首轮按目标数量的 `140%` 生成 70 条候选，再按质量与差异化择优保留 50 条。每条至少要有一项卖点、痛点、受众或场景事实，产品名称和规格只能作为身份锚点；核心及次要卖点、核心痛点、目标受众和三类已确认场景必须在批次中得到真实使用。最终选择后仍有遗漏时会针对缺失事实定向补生成并重新评估。最终结果分别记录画面直接依据和创意背景依据；仍有必用事实缺失时进入 `NEEDS_REVIEW`，不会伪造绑定或用产品名称冒充覆盖。

批量生成先按目标数量的 `140%` 生成候选，例如 50 条先生成 70 条，再做精确择优。择优先清理共用尾段、技术参数和共同产品词，通过火山向量接口生成正文向量；Worker 用 NumPy `float32` 矩阵一次计算余弦相似度，并把正文新颖度与场景、人物、产品主动作、镜头和情绪等业务语义簇合并。通常按 `70%` 独立质量分和 `30%` 相对新颖度选择；候选正文近重复率超过 50% 时当轮自动调整为 `60% / 40%`。人工保留项和单条重生成时的其他 Prompt 作为固定参照。相似度达到 `82%` 的正文会形成连通重复组，用于软排序、统计和提醒，不作为数量门禁。重复度偏高或场景、产品主动作过度集中时只触发一次受控多样性补充：AI 先规划并复核 2～4 个新方向，再生成补充候选，不会复用拥挤旧方向或用规则模板拼接凑数。

共用提示词是系统根据禁用元素确定性编译的批次级唯一文本，不另设用户编辑入口。生成模型收到它作为约束但不应复述到每条正文；第 4 节点编译 Seedance 请求时再将同一段文字追加一次，并从渲染节点独立读取画幅与分辨率，不回写单条 Prompt。人工新增或修改只需填写正文和片段时长，并可选择是否在保存后立即使用 AI 分析。关闭时只保存节点草稿且不产生 AI 调用，用户可稍后在卡片上手动开始；开启时保存接口返回准确条目 ID 并创建异步 `ITEM_EVALUATE`。评估器读取当前全部可信事实，在不改写正文的前提下补齐创意主线、六维信息、事实绑定、推荐用途与兼容用途。评估发现事实编造、产品无关或正文破损时，条目显示“需修改”及安全原因；`PENDING` 和 `NEEDS_REVISION` 均不能完成校验或进入视频渲染。

Prompt 条目只维护推荐用途和兼容用途，不再生成或允许人工编辑独立的次级素材标签；搜索、导出和视频渲染也不再传递该字段。

当前 Prompt 工作流只展示八阶段线性拓扑，其中“事实视觉使用策略编译”位于“提炼信息应用映射”之后、“共用提示词编译”之前。新任务和任务恢复都走同一条执行路径，不读取代码版本号。数据库中的业务 revision、上游 revision 和内容哈希继续用于并发控制、变更判断与审计，不属于代码版本。详细设计见 [Prompt 当前工作流实施方案](docs/workflows/effect/plans/效果类Prompt-单一当前工作流收敛实施方案.md)，通俗说明见 [Prompt 生成子工作流节点通俗说明](docs/workflows/effect/guides/效果类Prompt生成子工作流节点通俗说明.md)。

### Prompt 结果与当前项目工作区同步

- Prompt 设置按商品保存为 `PROMPT_GENERATION:{productId}` 节点草稿；项目概览会把商品级 ID 投影为用户可见的“Prompt 生成”节点，并使用最后保存的商品状态展示 revision 和编辑状态。
- 生成成功只更新 Prompt 领域结果和节点草稿，不直接创建工作副本。只有用户点击“完成校验”后，系统才提交 `prompt-batch:{productId}`，随后出现在“当前项目资产 → 工作区产物”中。
- 后一次生成失败不会删除或遮蔽此前成功结果，也不会阻止最新的已完成 PASS 结果执行“完成校验”。
- Prompt 工作副本使用信息卡中的商品名称命名，例如“广式腊肠 差异化 Prompt 批次”；若名称缺失才回退到产品 ID。
- 修改禁用元素会重新编译批次共用提示词并恢复为待校验状态；修改视觉风格或渠道则要求重新生成，均不会在再次完成校验前覆盖已提交工作副本。

排查“已经生成但工作区产物没有 Prompt”时，先区分两个状态：工作流草稿中“Prompt 生成”已开始，表示设置或结果已经保存；工作区产物中存在 Prompt，表示该批次已经通过并完成校验。两者不能互相替代，也不允许生成成功后绕过校验自动入库。

## 本地环境要求

- Windows 11 + Docker Desktop（推荐 WSL2 后端）。
- Node.js 22.12 或更高版本。
- pnpm 10 或更高版本。
- 运行 Python Worker 源码测试时需要 Python 3.12 和 uv；仅使用 Docker 启动 Worker 时不要求宿主机安装 Python。
- 已在火山方舟控制台授权 Doubao Seed 2.1 Turbo 的 API Key。

## 快速启动

以下命令均在仓库根目录执行。

### 1. 安装与配置

```powershell
Copy-Item .env.example .env
pnpm install
```

在被 Git 忽略的 `.env` 中填写真实 Ark Key：

```dotenv
ARK_API_KEY=<仅保存在本机的真实 Key>
```

默认模型已经配置为 `doubao-seed-2-1-turbo-260628`，正常接入只需填写 `ARK_API_KEY`，不要求创建或填写 Endpoint ID。只有主动切换模型版本或使用自定义推理接入点时才覆盖 `ARK_MODEL`。

Prompt Worker 的生产 Compose 默认启用 `PROMPT_SIMILARITY_MODE=vector`，并使用账号已授权的 `doubao-embedding-vision-251215`。该模型通过火山多模态 Embeddings 端点发送纯文本，每个请求一条正文并由独立并发门限控制；本地源码直接启动 Worker 时若未提供这些环境变量，配置类仍保持保守的 `trigram` 默认值。`vector` 模式缺少模型配置或调用失败会明确失败，不会静默退回字符匹配；需要只对照不接管结果时可显式设置 `shadow`。

共享或正式环境还应替换 `.env` 中的 MinIO 密码和 `EFFECT_EXTRACTION_WORKER_TOKEN`。前端代码、测试、README、`.env.example` 和 Git 历史中都不得出现真实密钥。

本地非生产环境未显式配置 Worker Token 时，API 与 Docker Compose 使用一致的 `local-*` 开发默认值，避免任务已入队但 claim 持续 401。生产环境没有默认值，仍必须显式配置彼此一致的独立 Token。

### 2. 启动基础设施

```powershell
docker compose up -d
docker compose ps
```

默认启动 PostgreSQL、Redis、RabbitMQ 和 MinIO。

### 3. 初始化数据库并启动前后端

```powershell
pnpm db:migrate
pnpm dev
```

也可以分别启动：

```powershell
pnpm dev:api
pnpm dev:web
```

### 4. 启动 Docling 与 AI 提炼 Worker

```powershell
docker compose --profile effect-extraction up -d --build effect-extraction-worker
```

该命令会自动完成：

1. 构建 CPU 版 Python Worker 镜像。
2. 运行一次性 `docling-model-init`，把模型下载到 `docling-models` named volume。
3. 启动内置 Playwright Chromium 的 `effect-extraction-worker`，浏览器初始化成功后开始消费 RabbitMQ 队列。

`docling-model-init` 显示 `Exited (0)` 是正常行为，它是一次性初始化任务，不是常驻服务。Docling 已嵌入 Worker，不需要再单独启动一个 Docling 容器。

检查运行状态：

```powershell
docker compose --profile effect-extraction ps
docker compose logs --tail 100 docling-model-init
docker compose logs --tail 100 effect-extraction-worker
```

`effect-extraction-worker` 应保持 `Up`，RabbitMQ 队列应出现消费者。Playwright 浏览器与 Worker 同进程启停；浏览器初始化失败或真实 Ark 模式缺少 Key 时 Worker 会启动失败，不会静默降级为 Mock。

### 5. 启动素材片段 Prompt Worker

正常 Ark 模式：

```powershell
docker compose --profile effect-prompt-generation up -d --build effect-prompt-generation-worker
docker compose logs --tail 100 effect-prompt-generation-worker
```

事实视觉策略、连贯创意与独立评估均通过小分片和独立输出预算执行；创意和评估每片最多 8 条，Provider 在明确结构化响应异常时只重试当前失败分片，不重跑已经成功的分片。策略阶段默认超时 180 秒，候选阶段默认超时 120 秒；运行失败不会自动切换模型。精确数量阶段使用火山正文向量和本地 NumPy MMR，不逐对远程调用。

仅在本地回归或自动测试中显式使用 Mock：

```powershell
$env:PROMPT_AI_PROVIDER='mock'
docker compose --profile effect-prompt-generation up -d --build --force-recreate effect-prompt-generation-worker
docker inspect ai-marketing-platform-effect-prompt-generation-worker-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | Select-String '^PROMPT_AI_PROVIDER='
Remove-Item Env:PROMPT_AI_PROVIDER
```

启动付费回归前必须先检查容器的 `PROMPT_AI_PROVIDER`，避免根目录 `.env` 中的 `ark` 配置被意外继承。Mock 与 Ark 使用相同的结构化响应契约，但 Mock 结果不能代替真实模型质量验收。

## 默认访问地址

| 服务            | 地址                               |
| --------------- | ---------------------------------- |
| Web             | <http://localhost:5173>            |
| API 健康检查    | <http://localhost:3000/api/health> |
| RabbitMQ 管理台 | <http://localhost:15672>           |
| MinIO API       | <http://localhost:9000>            |
| MinIO Console   | <http://localhost:9001>            |

RabbitMQ 本地默认账号为 `guest/guest`。如果修改 `API_PORT`，Vite 代理和 Docker Worker 会跟随根目录 `.env` 配置；自定义部署时也可设置 `VITE_API_PROXY_TARGET` 和 `INTERNAL_API_BASE_URL`。

## 常用命令

```powershell
# 全仓开发
pnpm dev

# 类型检查、测试和构建
pnpm typecheck
pnpm test
pnpm build

# 完整质量门禁：Lint、格式、类型、测试、构建
pnpm check

# Prisma
pnpm db:generate
pnpm db:migrate
pnpm db:studio

# Worker 容器
docker compose --profile effect-extraction build effect-extraction-worker
docker compose --profile effect-extraction up -d effect-extraction-worker
docker compose logs -f effect-extraction-worker
docker compose --profile effect-prompt-generation build effect-prompt-generation-worker
docker compose --profile effect-prompt-generation up -d effect-prompt-generation-worker
docker compose logs -f effect-prompt-generation-worker
```

Python Worker 本地验证：

```powershell
Set-Location workers/effect-extraction
uv sync --dev
uv run pytest
uv run mypy src tests
```

Prompt Worker 本地验证：

```powershell
Set-Location workers/effect-prompt-generation
uv sync --dev
uv run pytest
uv run ruff check src tests
uv run mypy src
```

真实 Ark 冒烟默认跳过，只有显式开启才会调用模型并产生费用：

```powershell
$env:RUN_ARK_INTEGRATION='1'
uv run pytest tests/test_ark_integration.py
Remove-Item Env:RUN_ARK_INTEGRATION
```

测试和日志不会记录 API Key、Prompt 正文、Markdown、图片 Base64 或模型完整响应。

## 数据与资产生命周期

系统使用四层生命周期，避免节点编辑直接污染正式资产：

1. `WorkflowNodeState`：节点表单、选择项和编辑状态，自动防抖保存。
2. `WorkingArtifact`：节点校验通过后的最新工作副本。
3. `ProjectAsset`：用户完成整个工作流并归档后形成的正式项目资产和版本。
4. `GlobalAsset`：用户明确选择后发布的跨项目复用资产。

“当前所在节点”和节点草稿分开维护：进入或切换节点只更新 `WorkflowRun.currentNodeId` 与活跃时间，不创建空的 `WorkflowNodeState`，也不增加草稿 revision。项目概览因此可以立即显示正在编辑的业务节点；只有发生真实表单或结果变化时才保存节点草稿，只有达到节点提交边界时才更新 `WorkingArtifact`。

节点中不提供“保存到项目资产库”按钮。刷新、退出和切换项目只保留草稿与工作副本，不自动归档。所有业务数据和查询必须携带 `projectId`，禁止跨项目串读写。

## 主要目录

```text
ai-marketing-platform/
├─ apps/
│  ├─ web/                         # Vue 3 前端
│  │  └─ src/
│  │     ├─ platform/              # 项目、资产、文件、任务等公共能力
│  │     └─ workflows/             # effect/customized/fission 工作流页面
│  └─ api/                         # NestJS 后端
│     ├─ prisma/                   # Schema 与迁移
│     └─ src/
│        ├─ platform/              # 公共领域能力
│        └─ workflows/             # 业务工作流模块
├─ packages/
│  ├─ contracts/                   # 前后端共享契约与 JSON Schema
│  └─ ui/                          # 共享 Vue UI 组件
├─ workers/
│  ├─ effect-extraction/           # LangGraph + Docling + Ark + Playwright Worker
│  ├─ effect-prompt-generation/    # 连贯六维创意 Prompt LangGraph Worker
│  ├─ seedance-worker/             # Seedance 异步 Worker
│  └─ media-worker/                # 媒体处理 Worker
├─ infrastructure/minio/           # 固定版本的本地 MinIO 镜像
├─ references/prototypes/          # 冻结原型
├─ docs/                           # 架构与实施文档
├─ compose.yaml
└─ .env.example
```

## API 概览

所有响应统一使用：

```ts
type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  requestId?: string;
};
```

AI 信息提炼公开基础路径：

```text
/api/projects/:projectId/workflows/effect/information-extraction
```

核心接口包括：

- 加载当前 draft 下各产品的结果、状态、告警和 STALE 信息。
- 为当前产品创建提炼 Run。
- 轮询 Run 七节点状态与进度。
- 使用 `expectedRevision` 保存完整结果，冲突返回 HTTP 409。
- 完成校验并提交当前产品营销洞察工作副本。

Worker 内部接口由 `x-worker-token` 和 attempt token 保护，不作为浏览器公开 API。

素材片段 Prompt 公开基础路径：

```text
/api/projects/:projectId/workflows/effect/prompt-generation
```

核心接口包括加载产品工作区、保存数量/时长/渠道/视觉风格/禁用元素、按推荐或兼容用途分页筛选、启动批量生成、单条重生成或 `ITEM_EVALUATE`、查询 Run 与安全节点详情、人工增删改、完成校验和权威 JSON 导出。禁用元素变化会重新编译内部批次共用提示词并使用 revision 并发控制，再次完成校验后才更新 `prompt-batch:{productId}` WorkingArtifact。Worker 内部 API 使用独立 `EFFECT_PROMPT_WORKER_TOKEN` 与 attempt token。

## 常见排障

### 提炼任务一直停在“等待中”

先检查消费者：

```powershell
docker compose --profile effect-extraction ps
docker compose logs --tail 200 effect-extraction-worker
```

如果 RabbitMQ 中有 ready 消息但消费者数量为 0，说明 Worker 没有运行。常见原因是 `ARK_API_KEY` 缺失、内部 Token 不一致或 API 端口配置不一致。

### Prompt 任务一直停在“等待服务接单 / 0%”

先检查 `effect-prompt-generation-worker` 日志中的 claim 状态。开发环境的 API 与 Compose 已统一使用本地 Worker Token 默认值；生产环境仍必须显式配置 `EFFECT_PROMPT_WORKER_TOKEN`。当前工作流将创意生成和独立评估拆成小分片；若 Ark 明确返回输出上限截断，任务会以 `AI_OUTPUT_TRUNCATED` 停止，不会把同一个不可完成请求盲目重复三次。启用向量模式时还应确认 `ARK_PROMPT_EMBEDDING_MODEL` 已进入容器。

### Prompt 任务失败后页面没有任何提示词

完整 Prompt 批次必须严格满足用户设置的总数量，并且不存在结构破损、未确认事实或实质完全重复等硬问题；当前工作流不要求四类用途配额。一般语义相似只参与向量 MMR 排序和软提醒，不会造成短批次。失败任务不会覆盖上一份有效工作副本。若失败前已有分片成功，结果区会展示其中通过基础结构检查的 Prompt 作为“临时预览”；临时预览只能查看、搜索、分页和复制，不能编辑、导出或完成校验。重新批量生成成功后才会形成新的正式节点结果。

工作流中的红色节点应只有真实失败分支；同批次其他被中断分支显示“已跳过”，不会继续显示“执行中”。若旧失败记录曾保存了错误的当前节点，公开接口会优先按真实失败 Stage 修正显示。

### Prompt 长时间停在“连贯六维创意生成”或“创意质量评估”

当前新任务按小分片执行连贯创意生成与独立评估。页面中的更新时间会随 Worker 心跳刷新并显示尝试次数；刷新页面后继续从后端恢复状态。历史工作流不再在工作区或节点弹窗中展示，也不会被当前 Worker 恢复；需要新结果时直接重新批量生成。

部署时确认以下配置已经进入 Prompt Worker 容器：

```text
ARK_PROMPT_STRATEGY_TIMEOUT_SECONDS=180
ARK_PROMPT_CANDIDATE_TIMEOUT_SECONDS=120
ARK_PROMPT_PROVIDER_MAX_ATTEMPTS=1
```

如果更新时间停止且 Worker 已退出，API 会在租约过期后自动恢复任务；达到三次尝试上限后任务明确失败，此时可以使用页面的“重新批量生成”。

### Docling 启动后立即停止

`docling-model-init` 本来就是一次性任务。`Exited (0)` 表示模型初始化成功；只有非 0 退出码才需要查看日志。真正需要常驻的是 `effect-extraction-worker`。

### 文档节点显示“文档 AI 抽取超时”

Docling 解析与 Ark 文档字段抽取是两个阶段。产品信息表的 Markdown 表格，以及 Word 经 Docling 转换后的“字段标题 + 段落/项目列表”，都会直接按字段白名单解析，不调用 Ark。只有无法可靠识别的非结构化文档才进入 Ark 兜底；该提示表示兜底抽取超时，界面只公开安全化的错误类型、尝试次数和耗时，不展示正文或模型请求。兜底默认使用 45 秒超时、单次尝试和最小思考，避免同一资料反复长时间等待。

### 电商节点信息较少或读取失败

先检查提炼 Worker：

```powershell
docker compose --profile effect-extraction ps
docker compose logs --tail 200 effect-extraction-worker
```

系统只解析无需登录的公开商品页，不注入账号 Cookie，也不绕过验证码或平台风控。受限页面可能只返回可验证的名称、品类和规格，或将电商分支标记为失败后继续使用文档、图片和表单资料；这不代表整个提炼任务停止。

### 模型配置是否需要 Endpoint ID

不需要。当前默认使用已授权的 Seed 2.1 Turbo Model ID。只需在本机 `.env` 填写 `ARK_API_KEY`；`ARK_MODEL`、`ARK_DOCUMENT_MODEL`、`ARK_IMAGE_MODEL` 和 `ARK_NORMALIZATION_MODEL` 都是可选覆盖项。

## 安全规则

- 所有真实密钥只保存在被 Git 忽略的本机 `.env` 或部署平台 Secret 中。
- `.env.example` 只允许占位符。
- 禁止在前端、测试、日志、截图、README、提交记录和聊天中粘贴密钥。
- Ark、Seedance、TOS 和对象存储密钥不得下发给浏览器。
- 如果密钥曾进入 Git 历史，应先在云端轮换，再重写未推送历史；不要绕过 GitHub Push Protection。

## 文档索引

- [文档导航](docs/README.md)
- [工程架构与边界](docs/architecture/system-architecture.md)
- [目录结构与前后端边界](docs/architecture/repository-boundaries.md)
- [项目、工作流草稿与资产管理通俗说明](docs/project-assets/项目、工作流草稿与资产管理通俗说明.md)
- [效果类工作流资料包导入节点实施方案](docs/workflows/effect/plans/效果类工作流-资料包导入节点实施方案.md)
- [效果类工作流 AI 信息提炼节点实施方案](docs/workflows/effect/plans/效果类工作流-AI信息提炼节点实施方案.md)
- [目标受众与全局分辨率贯通实施方案](docs/workflows/effect/plans/效果类目标受众与全局分辨率贯通实施方案.md)
- [产品素材制作信息卡 Result V2 完善实施方案](docs/workflows/effect/plans/效果类AI信息提炼-产品素材制作信息卡完善实施方案.md)
- [AI 信息提炼分节点模型路由实施方案](docs/workflows/effect/plans/效果类AI信息提炼-分节点模型路由实施方案.md)
- [Prompt 当前工作流实施方案](docs/workflows/effect/plans/效果类Prompt-单一当前工作流收敛实施方案.md)
- [Prompt 视觉策略真实付费质量对比](docs/workflows/effect/evidence/Prompt视觉策略两轮真实付费质量对比-2026-08-28.md)
- [MinIO 存储与本地部署方案](docs/workflows/effect/deployment/效果类导入素材-MinIO存储与本地部署方案.md)
- [AI 信息提炼 Worker 说明](workers/effect-extraction/README.md)
- [素材片段 Prompt Worker 说明](workers/effect-prompt-generation/README.md)

## 当前限制

- 电商链接只支持无需登录的公开商品页；不支持登录态、验证码绕过、平台专用逆向接口和跨项目网页结果缓存。
- 平台反爬或页面数据不完整时，电商分支可能只得到部分确定性字段或失败，但不会阻塞其他资料分支继续融合。
- AI 信息提炼只处理当前选中的产品，不支持一键批量提炼。
- 信息卡 schema v3 的自动化回归已完成；Prompt 视觉策略已完成三轮真实 Ark 端到端质量复验。后续任何付费复验仍需显式授权。
- Prompt 结果页会展示批次语义重复度，固定以 82% 相似关系聚合重复组，完成校验要求严格低于 15%；缺少可信向量评估的历史结果只显示“待评估”，不会伪造为 0%。2026-08-31 的 50 条真实付费联调在生成 70 条候选后由用户中止，未产生最终重复度或新工作副本；候选阶段 70/70 与商品相关，形成 69 条创意主线、61 种镜头表达和 35 种人物表达。
- Mock Provider 只允许测试或显式本地配置使用，生产默认 Ark 且缺少 Key 时立即失败。
- Seedance 素材片段渲染目前只完成纯请求编译边界；完整异步渲染任务、模板混剪和成片导出尚未进入当前实现范围。
