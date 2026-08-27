# Contracts 契约规则

适用于 `packages/contracts/**`。

- 本目录是 Web、API 与 Worker 跨进程数据结构的唯一事实来源。
- 契约应表达业务含义，不泄漏某个框架、ORM 或模型供应商的内部类型。
- 新字段默认向后兼容；删除、改名、改变枚举语义或必填性属于破坏性变更，必须提供迁移方案。
- TypeScript 类型、JSON Schema、Python 模型或生成物必须由同一契约同步产生或经过一致性测试。
- 时间使用明确时区的 ISO 8601；金额、比例、时长和分辨率必须写明单位。
- ID 字段语义清楚区分 `projectId`、`workflowRunId`、`artifactId`、`taskId`、`assetId`。
- 任务状态、错误码、分页和幂等字段不得由各模块自由发明。
- 契约变更必须补充正常、边界、缺字段、未知枚举和兼容性测试，并回归所有消费者。
