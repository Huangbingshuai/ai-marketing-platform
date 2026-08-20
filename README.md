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

Prisma Client 会在 `pnpm install` 后自动生成。首个正式数据模型进入开发后，再通过 `pnpm db:migrate` 创建迁移；当前底座不提前定义业务表。

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
