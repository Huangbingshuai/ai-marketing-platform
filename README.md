# AI 营销素材智能生成系统

面向公司内部运营和内容制作人员的 AI 视频素材生产平台。

系统覆盖效果类、定制类和裂变类营销视频生产流程，并统一管理项目、资料、Prompt、视觉资产、视频素材、剪辑工程和最终成片。

> 当前处于正式工程开发阶段，优先实现效果类工作流。

## 当前开发目标

第一阶段只打通效果类最小完整链路：

```text
创建项目
→ 导入商品资料
→ 信息提炼
→ 生成 Prompt
→ 创建 Seedance 任务
→ 查看生成结果
→ 手动保存到项目资产库
```

## 前后端边界

本项目采用前后端分离架构：

- `apps/web` 是独立的 Vue 前端应用，只通过 HTTP API 访问后端。
- `apps/api` 是独立的 NestJS 后端应用，负责业务规则、数据库和异步任务。
- `packages/contracts` 只保存前后端共享的数据契约，不包含任何一端的业务实现。
- 前端禁止直接导入后端源码，后端禁止直接导入前端源码。

开发环境中，Vite 将 `/api` 请求代理到 NestJS；生产环境可以分别部署前端静态资源和后端 API。若端口 `3000` 已被占用，只需修改根目录 `.env` 的 `API_PORT`，代理会自动跟随；也可以通过 `VITE_API_PROXY_TARGET` 单独覆盖代理目标。

## 已落地：项目创建能力

项目创建最小能力已在提交 `71d8676` 中落地。该次实现只负责创建项目，不包含资产库和具体业务工作流。

### 功能范围

- 前端按照 `references/prototypes/integrated/system-integrated-demo.html` 的系统顶栏、蓝白配色和公共弹窗重新实现。
- 页面提供单一“创建项目”入口，弹窗包含项目名称和项目说明。
- 创建过程区分初始、提交中、失败和成功状态；失败信息来自后端统一 API 响应。
- 前端通过 HTTP 调用 NestJS，不保存组件内写死的项目数据。
- 后端通过 `ProjectController → ProjectService → ProjectRepository → PrismaService` 写入 PostgreSQL。
- 前后端共享的项目类型和创建请求类型统一放在 `packages/contracts/src/project.ts`。

本次能力对应的主要目录：

```text
apps/web/src/platform/project/            # 创建按钮、弹窗和前端 API 客户端
apps/api/src/platform/project/            # Controller、Service、Repository 和 DTO
apps/api/prisma/schema.prisma             # Project 数据模型
apps/api/prisma/migrations/               # PostgreSQL 迁移
packages/contracts/src/project.ts         # 前后端共享契约
```

### 创建接口

```http
POST /api/projects
Content-Type: application/json
```

请求体：

```json
{
  "name": "广味食品 · 夏季投放",
  "description": "夏季短视频素材生产项目"
}
```

字段规则：

- `name`：必填，去除首尾空格后不能为空，最长 120 个字符。
- `description`：可选，最长 500 个字符；空字符串按 `null` 入库。
- 新项目默认状态为 `ACTIVE`。

成功响应遵循统一结构：

```json
{
  "success": true,
  "data": {
    "id": "项目 UUID",
    "name": "广味食品 · 夏季投放",
    "description": "夏季短视频素材生产项目",
    "status": "ACTIVE",
    "createdAt": "ISO 8601 时间",
    "updatedAt": "ISO 8601 时间"
  }
}
```

本地联调示例：

```powershell
$body = @{
  name = '广味食品 · 夏季投放'
  description = '夏季短视频素材生产项目'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri 'http://localhost:3000/api/projects' `
  -ContentType 'application/json' `
  -Body $body
```

### 数据落库

项目数据写入 PostgreSQL 的 `projects` 表，核心字段包括：

- `id`：UUID 主键。
- `name`：项目名称。
- `description`：可选项目说明。
- `status`：`DRAFT`、`ACTIVE` 或 `COMPLETED`，创建时默认为 `ACTIVE`。
- `createdAt`、`updatedAt`：创建与更新时间。

修改 Prisma 模型后执行：

```powershell
pnpm db:migrate
pnpm db:generate
```

### 验证

```powershell
# 项目模块测试
pnpm --filter @ai-marketing/api test
pnpm --filter @ai-marketing/web test

# 全仓质量检查
pnpm check
```

项目创建的 Service 测试覆盖字段归一化、默认状态和空说明入库；前端 API 测试覆盖 POST 请求体与后端错误信息透传。

## 已落地：效果类工作流“资料包导入”

效果类工作流第 01 步已使用 Vue、NestJS、Prisma 和共享契约正式实现。页面视觉与交互以以下冻结原型为基准：

- `references/prototypes/integrated/system-integrated-demo.html`：系统顶栏、项目上下文和公共入口。
- `references/prototypes/effect/effect-workflow.html`：效果类工作流画布和资料包导入节点。

完整实施约束、接口、数据模型和验收矩阵见 [效果类工作流-资料包导入节点实施方案](docs/效果类工作流-资料包导入节点实施方案.md)。

### 已实现能力

- 支持“单产品导入”和“多品类批量导入”，两种模式的资料包、全局配置、校验和 revision 分别保存，切换不丢数据；本节点不要求用户填写产品名称、品类或 SKU，产品信息由下一节点 AI 提炼。
- 产品资料标准化为两类：商品图片（主图、细节图、场景图，支持 JPG/PNG/PSD/WebP）和产品文档（产品卖点、受众画像、合规禁忌词、投放渠道，支持 Word/Excel/PDF/纯文本）。
- SKU 是后端生成的内部唯一标识，前端表单、清单模板和用户校验不要求填写 SKU。
- 支持 CSV/XLSX 清单预览、配套文件匹配、错误行提交与后续修复。
- 支持上传、删除、重传、服务端内容重试以及必须重新选择文件的失败处理。
- 批量模式支持按电商链接或资料文件搜索、新增资料包、批量删除和批量重试。
- 全局视频配置严格按效果类原型，仅展示视频时长、画幅比例、风格基调、投放渠道和禁用元素；产品可独立覆盖并恢复继承。
- 所有下拉选项支持搜索和自定义，选项层向上展开。
- 草稿、文件和配置全部保存到后端，刷新可恢复，不同项目按 `projectId` 严格隔离。
- 只有服务端权威校验通过后才能推进到下一节点。

### 数据与并发策略

- `EffectImportWorkspace` 记录项目当前导入模式。
- `EffectImportDraft` 按项目和模式分别保存草稿、配置、revision 和校验结果。
- `EffectImportProduct` 和 `EffectImportMaterial` 保存产品与资料状态。
- `EffectManifestImport` 和 `EffectManifestStagedFile` 保存清单预览、幂等键和阶段文件。
- 所有写接口使用 revision/`If-Match`；前端通过项目级单飞队列、AbortController 和代数门禁避免丢更新或串项目。
- 页面会后台预取另一种导入模式的草稿，切换时优先使用缓存即时展示，并在后台完成服务端切换。

### 正式资产入库

工作流草稿不会自动成为项目资产。用户点击“保存到项目资产库”后，效果类模块通过平台 `AssetService` 复制正式文件并创建 `Asset/AssetVersion`。同一资料包再次主动入库会创建新版本；同一次网络重试使用幂等键恢复，不会重复创建版本。

开发环境默认使用 `LocalStorageAdapter`，文件保存到 `.local-storage/`；生产 TOS Adapter 不在本节点的实现范围内。

### 主要 API

基础路径：

```text
/api/projects/:projectId/workflows/effect/source-import
```

该路径下提供工作区与草稿加载、模式切换、产品 CRUD、资料上传/重传/重试/删除、清单模板/预览/提交/取消、权威校验、正式资产入库和节点推进接口。统一响应结构为 `ApiResponse<T>`。

### 质量验证

```powershell
pnpm --filter @ai-marketing/contracts test
pnpm --filter @ai-marketing/api test
pnpm --filter @ai-marketing/web test
pnpm --filter @ai-marketing/api typecheck
pnpm --filter @ai-marketing/web typecheck
pnpm build:api
pnpm build:web
```

当前测试覆盖项目隔离、revision 冲突、清单解析、文件签名、上传补偿、失败重试、正式入库幂等与版本化、前端请求队列、草稿缓冲和原型布局约束。

## 本地准备

要求：

- Node.js 22.12+
- pnpm 10+
- Docker Compose（用于本地 PostgreSQL、Redis 和 RabbitMQ）

首次启动：

```powershell
Copy-Item .env.example .env
docker compose up -d
pnpm install
pnpm dev
```

默认地址：

- Web：<http://localhost:5173>
- API 健康检查：<http://localhost:3000/api/health>
- RabbitMQ 管理台：<http://localhost:15672>（本地默认账号 `guest/guest`）

根目录 `.env` 同时供 Vite 与 NestJS 读取。TOS 和 Seedance 密钥只允许配置在后端运行环境，不得写入前端源码、测试或日志。

### 独立启动与构建

```powershell
# 只启动前端（http://localhost:5173）
pnpm dev:web

# 只启动后端（http://localhost:3000/api）
pnpm dev:api

# 分别验证生产构建
pnpm build:web
pnpm build:api
```

日常联调仍可使用 `pnpm dev` 同时启动两个进程。前端只依赖 API 契约和 HTTP 地址，因此前后端可以独立开发、测试和部署。

### 工程校验

```powershell
pnpm check
```

该命令会执行共享契约构建、ESLint、Prettier 校验、全仓类型检查、测试和生产构建。独立执行 `pnpm typecheck` 时也会先生成 `packages/contracts/dist`，因此可在干净检出后直接运行。

Prisma Client 会在 `pnpm install` 后自动生成。当前工程已经包含正式业务模型和迁移；修改数据模型后通过 `pnpm db:migrate` 创建新迁移，并通过 `pnpm db:generate` 重新生成 Prisma Client。

## 目录结构

```text
ai-marketing-platform/
├─ apps/
│  ├─ web/                         # Vue 前端
│  │  └─ src/
│  │     ├─ app/                   # 应用入口与布局
│  │     ├─ api/                   # HTTP 基础封装
│  │     ├─ platform/              # 项目、资产、文件、任务等公共前端能力
│  │     ├─ workflows/
│  │     │  ├─ effect/             # 效果类前端
│  │     │  ├─ customized/         # 定制类前端
│  │     │  └─ fission/
│  │     │     ├─ shared/
│  │     │     ├─ clone/
│  │     │     ├─ avatar/
│  │     │     └─ local-replace/
│  │     ├─ shared/                # 无业务通用前端代码
│  │     └─ styles/
│  └─ api/                         # NestJS 后端
│     └─ src/
│        ├─ common/                # 后端公共技术组件
│        ├─ config/                # 环境配置
│        ├─ database/              # Prisma 数据访问
│        ├─ platform/              # 项目、资产、文件、任务等公共后端能力
│        └─ workflows/
│           ├─ effect/             # 效果类后端
│           ├─ customized/         # 定制类后端
│           └─ fission/
│              ├─ shared/
│              ├─ clone/
│              ├─ avatar/
│              └─ local-replace/
├─ packages/
│  ├─ contracts/                   # 前后端共享类型
│  └─ ui/                          # 共享 Vue UI 组件
├─ workers/                        # Seedance 与媒体异步 Worker
├─ references/prototypes/          # 冻结的历史交互原型
└─ docs/
```

更详细的依赖规则见 [目录结构与前后端边界](docs/目录结构与前后端边界.md) 和 [工程架构与边界](docs/architecture.md)。
