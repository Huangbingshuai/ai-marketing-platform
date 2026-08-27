# 工程架构与边界

## 依赖方向

```text
apps/web/src/platform/*  <── apps/web/src/workflows/*
          │                           │
          └──────── HTTP / SSE ───────┘
                         │
                         ▼
apps/api/src/platform/*  <── apps/api/src/workflows/*
                         │
                         ▼ RabbitMQ
                     workers/*

apps/web + apps/api ──> packages/contracts
```

- `packages/contracts` 只放共享数据契约，不依赖应用或业务工作流。
- `packages/ui` 只放共享前端组件，不承载业务请求和工作流状态。
- 每个应用内部的 `platform` 提供项目、资产、文件、调度和任务等通用能力，不包含效果类、定制类或裂变类规则。
- 每个应用内部的 `workflows` 只能调用同一应用的公共平台能力；各工作流之间不得引用内部实现。
- 前端与后端只能通过 HTTP/SSE 和 `packages/contracts` 协作，不得跨应用导入源码。
- `apps/api` 负责组合后端模块、读取环境和暴露 HTTP 接口，Controller 保持轻量。
- `workers` 执行耗时任务，Seedance 调用与轮询不得阻塞 HTTP 请求。

## 当前底座

- pnpm workspace 管理应用和共享包。
- 根目录统一 TypeScript、ESLint、Prettier、Vitest 和构建命令。
- API 默认前缀为 `/api`，响应统一包装为 `ApiResponse<T>` 并返回 `x-request-id`。
- Prisma 使用 PostgreSQL driver adapter；生成代码位于 `apps/api/src/generated/prisma`，不纳入 Git。
- 本地 Compose 提供 PostgreSQL、Redis、RabbitMQ，业务客户端按实际开发阶段接入。
- TOS 与 Seedance 密钥只通过后端环境变量配置。

## 数据约束

- 除项目实体本身外，业务数据必须携带 `projectId`，读写均按当前项目隔离。
- 工作流结果先作为待入库产物存在，只有用户主动保存后才创建正式资产。
- 同一产物重复保存时创建新版本；跨项目复用时复制快照并保留来源信息。

这些约束应在共享契约、Service/Domain 层和 Repository 查询三处共同落实，不能只依赖前端传参。
