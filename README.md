# AI 营销素材智能生成系统

公司内部使用的 AI 营销视频素材生产平台。系统以项目为隔离边界，统一管理产品资料、营销洞察、Prompt、生成任务、工作副本和归档资产。

当前优先建设效果类黄金链路，已完成公共项目底座、资料包导入、AI 信息提炼和素材片段 Prompt 生成；视频渲染、模板混剪和成片导出仍按工作流顺序继续开发。

> 文档状态：与 `main` 分支当前已提交实现同步
>
> 最后更新：2026-08-26

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

已经落地的核心能力：

- Vue 3 前端、NestJS API、PostgreSQL + Prisma 数据层和共享 TypeScript 契约。
- 项目上下文、项目隔离、工作流草稿、工作副本、正式资产和版本生命周期。
- 效果类单产品/批量资料包导入、图片与文档上传、全局视频配置、revision 并发控制和刷新恢复。
- RabbitMQ Outbox 可靠投递、Redis 进度缓存、任务租约和重复消息恢复。
- Python 3.12 + LangGraph AI 提炼 Worker。
- 独立 Prompt 生成 Worker：六类素材片段条件路由、分片并发、执行门禁、双重去重和最多三轮定向补齐。
- Docling 本地解析 PDF/DOCX，模型文件通过 Docker named volume 持久化。
- 电商链接静态抓取、JSON-LD/OpenGraph/京东内嵌数据解析，以及隔离 Playwright Chromium 动态渲染兜底。
- 火山方舟 Ark Responses API 文档抽取、图片理解、电商信息补全和标准结果生成。
- 七节点工作流状态弹窗、节点详情、逐文件处理结果、告警和安全化错误展示。
- Result V2《产品素材制作信息卡》五层结构、人工修正、来源追踪、冲突报告和旧版结果兼容。
- 提炼结果草稿自动保存；只有完成校验后才提交 `WorkingArtifact`，完成整个工作流时才统一归档为 `ProjectAsset`。

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
                         ├─ AI 信息提炼：Docling + Ark Seed 2.1 Turbo
                         │                 └─ commerce-renderer：隔离 Playwright Chromium
                         └─ Prompt 生成：Seed 2.0 Lite 策略 + Seed 2.1 Turbo 候选
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
  ├─ 文档解析：Docling → Markdown → Ark 文档字段抽取
  ├─ 图片识别：图片预处理 → Ark 多模态逐图识别
  ├─ 电商链接：安全校验 → 静态解析 → Playwright 兜底 → Ark 商品字段抽取
  └─ 表单配置：读取导入节点的全局视频配置
             ↓ 等待四分支完成
          多源融合
             ↓
       标准化与结果保存
```

电商分支优先读取 JSON-LD、OpenGraph、商品正文和京东页面内嵌数据；静态内容不足时调用独立 `commerce-renderer`。没有链接时节点为 `SKIPPED`；受到登录、验证码或平台风控限制时，不尝试绕过限制，并以安全化告警继续融合其他资料。

事实字段的融合优先级为：当前人工修正/表单 > 文档 > 电商 > 图片。AI 策略推断只补充缺失的建议字段，不覆盖已经确认的事实。数组字段采用稳定去重，同级冲突保留安全告警；最终结果经过严格 JSON Schema 和 Pydantic 校验。

LangGraph state 只保存小型标识：

```python
InputState = {"project_id": str}
OutputState = {"extract_result_id": str}
```

文档 Markdown、图片处理结果、分支输出和标准化 JSON 均外部化存储，不把大文本塞进 Graph state。

Result V2 完整映射前端《产品素材制作信息卡》的五层 20 个字段：

1. 产品基础：品类、产品名称、核心规格、价格带、核心外观特征。
2. 卖点与背书：核心卖点、次级卖点、信任背书。
3. 用户与决策：目标受众、核心痛点、决策因素、营销目标。
4. 使用与情绪场景：核心使用场景、购买场景、情绪场景。
5. 制作规则：统一时长、画幅、投放渠道、全局禁用元素、视觉风格基线。

生成成功和编辑防抖只保存领域结果与页面草稿；用户点击“完成校验”后才提交 `marketing-insight:{productId}` 工作副本。旧版 12 字段结果通过兼容层读取，不要求一次性回填历史数据。

详细设计与验收记录见 [效果类工作流 Step 02「AI 信息提炼」实施方案](docs/效果类工作流-AI信息提炼节点实施方案.md) 和 [产品素材制作信息卡完善实施方案](docs/效果类AI信息提炼-产品素材制作信息卡完善实施方案.md)。

## 素材片段 Prompt 生成工作流

Step 03 读取当前产品已提交的 `marketing-insight:{productId}`，生成供后续逐条渲染和模板混剪使用的素材片段 Prompt。一条 Prompt 对应一个短视频素材片段，不是完整广告或最终成片。

默认批次共 50 条，六类片段分别独立配置数量和 4～15 秒目标时长：

| 片段类型 | 默认数量 | 默认时长 |
| -------- | -------: | -------: |
| 钩子     |       10 |     5 秒 |
| 痛点     |        8 |     5 秒 |
| 产品展示 |       12 |     5 秒 |
| 卖点讲解 |       10 |     5 秒 |
| 结尾转化 |        6 |     5 秒 |
| 片尾品牌 |        4 |     5 秒 |

公开子工作流先把已提交信息卡映射为带稳定 `factId` 的提炼事实，再规划“受众—痛点—场景—卖点—证据—营销目标”关系束，并把关系束编排到六类片段蓝图。策略规划调用 Doubao Seed 2.0 Lite，六类候选生成调用 Doubao Seed 2.1 Turbo；事实来源校验、职责校验、执行门禁、语义/视觉去重、提炼信息覆盖门禁和最多三轮定向补齐均为确定性逻辑，不增加第三次模型审查。

最终 Prompt 只包含可直接执行的场景、主体、连续动作、产品关系、主景别、单一运镜、光线、节奏和结束画面。六维差异、标签、卖点与时长保存在结构化元数据中；画幅、分辨率和统一禁用元素保存在批次级 `renderProfile`。批量生成、定向补齐、安全兜底、单条重生成及人工编辑入口都执行同一正文硬门禁，任何可见 Prompt 都不能包含这些技术参数或统一禁用项原文。第 4 节点提交 Seedance 任务时再把时长、画幅和分辨率编译为独立参数，并把统一禁用元素去重追加一次。

前三轮模型补齐仍不足时，Worker 使用已校验关系束和蓝图生成安全兜底变体；兜底也必须通过同一职责、来源、执行、去重和覆盖门禁。成功批次必须严格等于用户设置的总数及六类配额，否则任务失败且不覆盖上一份有效结果。只有全部门禁通过后，页面才允许“完成校验”并提交 `prompt-batch:{productId}` WorkingArtifact。详细设计、V1～V5 兼容和验收记录见 [差异化 Prompt 批量生成节点实施方案](docs/效果类工作流-差异化Prompt批量生成节点实施方案.md)。

### Prompt 结果与当前项目工作区同步

- Prompt 设置按商品保存为 `PROMPT_GENERATION:{productId}` 节点草稿；项目概览会把商品级 ID 投影为用户可见的“Prompt 生成”节点，并使用最后保存的商品状态展示 revision 和编辑状态。
- 生成成功只更新 Prompt 领域结果和节点草稿，不直接创建工作副本。只有用户点击“完成校验”后，系统才提交 `prompt-batch:{productId}`，随后出现在“当前项目资产 → 工作区产物”中。
- 后一次生成失败不会删除或遮蔽此前成功结果，也不会阻止最新的已完成 PASS 结果执行“完成校验”。
- Prompt 工作副本使用信息卡中的商品名称命名，例如“广式腊肠 差异化 Prompt 批次”；若名称缺失才回退到产品 ID。

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

共享或正式环境还应替换 `.env` 中的 MinIO 密码和 `EFFECT_EXTRACTION_WORKER_TOKEN`。前端代码、测试、README、`.env.example` 和 Git 历史中都不得出现真实密钥。

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
3. 启动仅供 Worker 访问的 `commerce-renderer` 动态页面渲染服务。
4. 模型初始化和渲染服务健康检查通过后，启动 `effect-extraction-worker` 消费 RabbitMQ 队列。

`docling-model-init` 显示 `Exited (0)` 是正常行为，它是一次性初始化任务，不是常驻服务。Docling 已嵌入 Worker，不需要再单独启动一个 Docling 容器。

检查运行状态：

```powershell
docker compose --profile effect-extraction ps
docker compose logs --tail 100 docling-model-init
docker compose logs --tail 100 commerce-renderer
docker compose logs --tail 100 effect-extraction-worker
```

Worker 和 `commerce-renderer` 应保持 `Up`，RabbitMQ 队列应出现消费者。真实 Ark 模式缺少 Key 时 Worker 会启动失败，不会静默降级为 Mock。

### 5. 启动素材片段 Prompt Worker

正常 Ark 模式：

```powershell
docker compose --profile effect-prompt-generation up -d --build effect-prompt-generation-worker
docker compose logs --tail 100 effect-prompt-generation-worker
```

策略规划使用低成本模型，候选分支使用 Turbo；每片最多 8 条、全图最大并发 3，并按小分片动态限制输出 Token。运行失败不会自动切换模型。

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
docker compose --profile effect-extraction build commerce-renderer effect-extraction-worker
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
│  ├─ effect-extraction/           # LangGraph + Docling + Ark Worker
│  ├─ effect-commerce-renderer/    # 隔离 Playwright Chromium 渲染服务
│  ├─ effect-prompt-generation/    # 六类素材片段 Prompt LangGraph Worker
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

核心接口包括加载产品工作区、保存六类设置、分页筛选结果、启动批量/单条重生成、查询 Run 与安全节点详情、人工增删改、完成校验和权威 JSON 导出。Worker 内部 API 使用独立 `EFFECT_PROMPT_WORKER_TOKEN` 与 attempt token。

## 常见排障

### 提炼任务一直停在“等待中”

先检查消费者：

```powershell
docker compose --profile effect-extraction ps
docker compose logs --tail 200 effect-extraction-worker
```

如果 RabbitMQ 中有 ready 消息但消费者数量为 0，说明 Worker 没有运行。常见原因是 `ARK_API_KEY` 缺失、内部 Token 不一致或 API 端口配置不一致。

### Docling 启动后立即停止

`docling-model-init` 本来就是一次性任务。`Exited (0)` 表示模型初始化成功；只有非 0 退出码才需要查看日志。真正需要常驻的是 `effect-extraction-worker`。

### 文档节点显示“文档 AI 抽取超时”

Docling 解析与 Ark 文档字段抽取是两个阶段。该提示表示 Ark 抽取阶段超时，界面只公开安全化的错误类型、尝试次数和耗时，不展示正文或模型请求。

### 电商节点信息较少或读取失败

先检查 Worker 与渲染服务：

```powershell
docker compose --profile effect-extraction ps
docker compose logs --tail 200 commerce-renderer
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

- [工程架构与边界](docs/architecture.md)
- [目录结构与前后端边界](docs/目录结构与前后端边界.md)
- [项目、工作流草稿与资产管理通俗说明](docs/项目、工作流草稿与资产管理通俗说明.md)
- [效果类工作流资料包导入节点实施方案](docs/效果类工作流-资料包导入节点实施方案.md)
- [效果类工作流 AI 信息提炼节点实施方案](docs/效果类工作流-AI信息提炼节点实施方案.md)
- [产品素材制作信息卡 Result V2 完善实施方案](docs/效果类AI信息提炼-产品素材制作信息卡完善实施方案.md)
- [AI 信息提炼分节点模型路由实施方案](docs/效果类AI信息提炼-分节点模型路由实施方案.md)
- [差异化 Prompt 批量生成节点实施方案](docs/效果类工作流-差异化Prompt批量生成节点实施方案.md)
- [MinIO 存储与本地部署方案](docs/效果类导入素材-MinIO存储与本地部署方案.md)
- [AI 信息提炼 Worker 说明](workers/effect-extraction/README.md)
- [电商动态渲染服务说明](workers/effect-commerce-renderer/README.md)
- [素材片段 Prompt Worker 说明](workers/effect-prompt-generation/README.md)

## 当前限制

- 电商链接只支持无需登录的公开商品页；不支持登录态、验证码绕过、平台专用逆向接口和跨项目网页结果缓存。
- 平台反爬或页面数据不完整时，电商分支可能只得到部分确定性字段或失败，但不会阻塞其他资料分支继续融合。
- AI 信息提炼只处理当前选中的产品，不支持一键批量提炼。
- Result V2 的自动化回归已完成，真实 Ark 质量验收需显式开启并会产生模型调用费用。
- Mock Provider 只允许测试或显式本地配置使用，生产默认 Ark 且缺少 Key 时立即失败。
- Seedance 素材片段渲染、模板混剪和成片导出尚未进入当前实现范围。
