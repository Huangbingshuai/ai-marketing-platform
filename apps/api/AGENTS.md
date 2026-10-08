# API 后端规则

适用于 `apps/api/**`。开始工作前还必须阅读根 `AGENTS.md` 和对应工作流指南。

## 职责边界

- API 负责鉴权、项目隔离、业务校验、事务、任务编排、持久化、审计与签名访问。
- Controller 只做协议转换和权限入口；业务规则放 Service/Domain；Repository 只负责持久化。
- 跨进程 DTO、事件和状态枚举必须来自 `packages/contracts`，禁止维护同名私有版本。
- 所有项目级查询和写入都必须验证 `projectId` 与用户/组织权限，不能只相信前端传参。

## Run、任务与幂等

- `workflowRunId` 表示一次独立工作流运行，而不是工作流类型。一个项目可以有重跑、分支和历史运行。
- 创建异步任务必须有稳定幂等键；重复请求返回已有任务或明确的新版本，不产生幽灵任务。
- 数据库事务内写业务状态与 Outbox；Worker/模型调用在事务外执行。
- RabbitMQ 消息只携带 schemaVersion、projectId、runId、requestId 等小型标识；正文、Markdown、Base64、模型输入输出、对象存储地址和密钥均通过受保护接口获取。
- 回调和 Worker 写回必须校验任务状态与版本，防止旧任务覆盖新结果。
- 取消、超时、重试、部分失败和人工重跑必须有明确状态迁移。
- 活动任务唯一性必须由数据库约束、锁或等价机制保证，不能只依赖前端按钮禁用。
- claim、lease、heartbeat 和重领必须幂等；Worker 使用独立共享 Token 与 attempt token，不获得数据库凭据。
- Redis 可作进度缓存及经 PostgreSQL 版本校验的只读投影缓存；PostgreSQL 始终权威。缓存键按项目、工作流、Run 和业务对象隔离，TTL 不能代替新鲜度校验；缓存失败回退数据库，不缓存鉴权结果、实时任务权威状态、原始资料正文、二进制或签名 URL。

## 工作副本

- 节点草稿与已确认工作副本分开保存。
- 提交工作副本前计算规范化内容指纹；与上一确认版本相同则保持 revision 不变。
- 下游依赖保存具体 `artifactId + revision`，并由服务端计算待更新状态。
- 同一业务对象使用稳定 `artifactKey`；不要把节点中的所有内容强行塞进一个巨大副本，也不要为每次键入创建副本。

## 安全与可观测性

- 密钥、Token、Cookie、签名 URL 和用户原始敏感内容不得进入日志。
- 日志至少包含脱敏后的 `requestId/projectId/workflowRunId/taskId`，便于追踪。
- Mock 只能通过显式环境配置开启；生产/集成环境缺配置时应失败并报告原因。

## 验证

- 本地 API 开发统一经 `pnpm dev:api` / `pnpm --filter @ai-marketing/api dev` 启动，复用工作区进程互斥入口；不额外启动裸 `nest start --watch`。开发输出 `dist-dev` 不与另一个 watcher 或手工开发构建共用；生产构建使用 `dist`。替换旧进程前核实所有任务与返修均不活跃，按本地开发指南操作。

- 覆盖权限、项目隔离、幂等、状态迁移、内容指纹、revision、旧任务回写和异常分支。
- 修改契约时同步验证 Web、API、Contracts 和相关 Worker。
