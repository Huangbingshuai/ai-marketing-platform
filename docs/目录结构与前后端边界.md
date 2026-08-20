# 目录结构与前后端边界

## 目标

项目保持一个代码仓库，但前端、后端和异步 Worker 分别运行、分别构建。三大业务工作流在前后端内部采用相同名称隔离，方便单人开发时快速定位代码，也方便后续使用独立 Codex worktree 并行开发。

## 运行单元

| 运行单元        | 目录                      | 职责                           |
| --------------- | ------------------------- | ------------------------------ |
| Web             | `apps/web`                | 页面、交互状态、调用 API       |
| API             | `apps/api`                | 业务规则、数据库、创建异步任务 |
| Seedance Worker | `workers/seedance-worker` | 调用和轮询 Seedance            |
| Media Worker    | `workers/media-worker`    | FFmpeg、媒体探测和合成         |

## 前后端协作规则

```text
Vue Web
   │ HTTP / SSE
   ▼
NestJS API
   │ RabbitMQ
   ├───────────────┐
   ▼               ▼
Seedance Worker   Media Worker
```

1. 前端不得导入 `apps/api` 下的任何文件。
2. 后端不得导入 `apps/web` 下的任何文件。
3. 前后端共享的请求、响应和枚举放入 `packages/contracts`。
4. `packages/contracts` 不得依赖 Vue、NestJS、Prisma 或浏览器 API。
5. Seedance 密钥只允许出现在 API 或 Worker 的运行环境中。

## 工作流代码边界

前端和后端分别维护自己的工作流实现，不在仓库根目录建立 `workflows`：

```text
apps/web/src/workflows/             # 页面、组件、Store、API 客户端
├─ effect/
├─ customized/
└─ fission/{shared,clone,avatar,local-replace}/

apps/api/src/workflows/             # NestJS 模块、领域服务、Repository
├─ effect/
├─ customized/
└─ fission/{shared,clone,avatar,local-replace}/
```

效果类、定制类和裂变类不能直接引用彼此的内部代码。跨工作流复用业务产物时，必须先进入项目资产库，再由目标工作流通过资产 API 读取。

## 公共平台边界

每个应用内部的 `platform` 只保存多个工作流共同依赖的能力：

- project：项目上下文与项目隔离
- asset：资产和版本
- file：文件上传与对象存储
- workflow：运行记录与节点状态
- job：异步任务与进度
- health：服务健康检查

- `apps/web/src/platform/*` 负责项目上下文、资产选择、上传预览和任务进度等前端能力。
- `apps/api/src/platform/*` 负责项目、资产、文件、工作流调度和异步任务等后端能力。
- 前后端不能因为目录名称相同而直接共享实现，只能通过 HTTP/SSE 和 `packages/contracts` 协作。

## 新功能放置判断

```text
只属于一个工作流？
├─ 是 → 放到对应 workflows 目录
└─ 否
   ├─ 是项目、资产、文件或任务能力 → 放到当前应用的 platform
   ├─ 是前后端数据结构 → 放到 packages/contracts
   └─ 是无业务 Vue 组件 → 放到 packages/ui
```
