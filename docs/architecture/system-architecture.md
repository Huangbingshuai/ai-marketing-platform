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
- 系统固定五条工作流：效果类、定制类、爆款复刻、数字人口播、局部元素替换。每个应用内部的 `workflows` 只能调用同一应用的公共平台能力；不同工作流之间不得引用彼此的内部实现。
- 前端与后端只能通过 HTTP/SSE 和 `packages/contracts` 协作，不得跨应用导入源码。
- `apps/api` 负责组合后端模块、读取环境和暴露 HTTP 接口，Controller 保持轻量。
- `workers` 按工作流和任务边界执行耗时工作；Seedance 调用、轮询与媒体处理不得阻塞 HTTP 请求。运行单元及目录见[仓库边界](repository-boundaries.md)。

## 当前底座

- pnpm workspace 管理应用和共享包。
- 根目录统一 TypeScript、ESLint、Prettier、Vitest 和构建命令。
- API 默认前缀为 `/api`，响应统一包装为 `ApiResponse<T>` 并返回 `x-request-id`。
- Prisma 使用 PostgreSQL driver adapter；生成代码位于 `apps/api/src/generated/prisma`，不纳入 Git。
- 本地 Compose 提供 PostgreSQL、Redis、RabbitMQ，业务客户端按实际开发阶段接入。
- TOS 与 Seedance 密钥只通过后端环境变量配置。

## 数据约束

- 除项目实体本身外，业务数据必须携带 `projectId`，读写均按当前项目隔离。
- 草稿、工作副本和正式项目资产是不同状态。正式提交点由对应工作流定义，可以是用户确认，也可以是完整成功并通过服务端校验后的自动提交。
- 业务 revision 仅在已确认内容变化时增长；相同内容不重复增加 revision。跨项目复用须通过明确的发布或复制动作创建目标项目内的资产快照，并保留来源信息。

这些约束应在共享契约、Service/Domain 层和 Repository 查询三处共同落实，不能只依赖前端传参。
