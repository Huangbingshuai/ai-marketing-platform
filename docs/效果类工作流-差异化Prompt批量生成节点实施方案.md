# 效果类工作流——差异化 Prompt 批量生成节点实施方案

- 当前状态：已完成
- 最后更新时间：2026-08-25
- 原型基准：`references/prototypes/effect/effect-workflow.html` 中第 03 步差异化 Prompt 批量生成区域

## 1. 目标与实施范围

将现有第 03 步从浏览器 `localStorage` 与前端规则 Mock 升级为真实的异步子工作流闭环。保留四项批次设置、产品切换、质量统计、Prompt 列表、编辑、单条重生成、服务端导出和十条分页，并增加可恢复、可点击的子工作流进度弹窗。

本次包含共享契约、JSON Schema、Prisma 迁移、NestJS 公开与内部 API、独立 Python LangGraph Worker、RabbitMQ/Outbox、前端接入、WorkingArtifact 提交边界、部署配置和测试。

本次不实现片段渲染、Seedance、混剪、时间轴精修和成片导出，也不重构 AI 信息提炼业务。工作区内既有 AI 信息提炼未提交修改必须保留。

## 2. 已确认业务口径

- 一次 Run 只处理当前产品；不提供一键全部生成。
- 数量范围 10～200，默认 50。
- 每条保存叙事、场景、人物、卖点、镜头和情绪完整六维；任意两条至少三个维度不同。
- 核心卖点轮动覆盖；模型不得创造硬事实、功效或信任背书。
- 语义重复度默认不超过 15%，视觉结构化重合度默认不超过 20%。首版使用确定性结构化代理算法，不增加 Embedding 依赖。
- 全量重生成保留人工编辑和人工新增项，再补足目标数量；单条重生成只替换目标项。
- 生成、补齐、重生成和人工编辑只更新领域结果与节点草稿。只有当前产品“完成校验”后才提交 `prompt-batch:{productId}` WorkingArtifact。
- 达到三轮补齐上限仍未通过时保留 `NEEDS_REVIEW` 草稿，不允许提交下游。

## 3. 子工作流与持久化

公开拓扑固定为：

```text
LOAD_AND_SNAPSHOT
  → STRATEGY_PLANNING
  → DIMENSION_COMBINATION
  → CANDIDATE_GENERATION
  → NORMALIZATION
  → [SEMANTIC_DEDUP || VISUAL_DEDUP]
  → QUALITY_GATE
  → REPLENISH（必要时回到候选生成，最多三轮）
  → RESULT_SAVE
```

LangGraph state 只保存项目 ID、轮次、分片 ID 与计数；正文和完整结果通过受保护内部 API 持久化到 PostgreSQL。Worker 使用独立队列、Token、claim/lease/heartbeat 和 attempt token；RabbitMQ 消息只携带运行标识。

新增 `EffectPromptRun`、`EffectPromptStageOutput`、`EffectPromptShardOutput` 与 `EffectPromptResult`。结果区分 `generatedResult`、`draftResult` 和 `manualOverrides`，写入使用 revision/CAS。WorkingArtifact 依赖当前营销洞察 revision 与产品级 Prompt 设置执行哈希。

## 4. 接口与质量规则

公开 API 统一位于：

```text
/projects/:projectId/workflows/effect/prompt-generation
```

提供工作区、产品结果分页/搜索、启动批量或单条 Run、Run/节点详情、人工新增修改删除、完成校验和权威 JSON 导出。内部 Worker API 位于 `/internal/workers/effect-prompt-generation`。

语义代理以可变正文的中文字符 3-gram Dice 和结构化内容意图签名判重；视觉代理按场景 35%、人物 20%、镜头 30%、情绪 15% 加权判重。批次指标为违规 Prompt 对占全部 Prompt 对的比例。系统先剔除高度相似或六维差异不足候选，再按缺口 1.25 倍补齐。

## 5. 测试与验收标准

- Contracts：Schema、拓扑、范围与非法数据。
- NestJS：项目隔离、事务 Outbox、幂等、活动 Run 唯一、租约、防旧 attempt、CAS、人工覆盖、提交门禁与脱敏。
- Worker：六维距离、卖点覆盖、分片、确定性质量、三轮补齐、部分失败、严格 Ark Schema 与 Mock。
- 前端：加载/空态/失败、刷新恢复、产品/项目切换、子图、编辑器六维、搜索分页、键盘、窄屏和 409。
- 门禁：`pnpm check`、Worker `pytest/mypy`、Compose config/build 和浏览器回归。真实 Ark 仅在用户另行授权且 Key 可用时执行。

## 6. 实施记录

2026-08-25 完成实施：

- 新增共享 TypeScript 契约、严格 JSON Schema、公开子图拓扑与设置/结果/API 类型；前端、NestJS 和 Python Pydantic 已统一字段口径。
- 新增 Prisma 迁移 `20260825170000_create_effect_prompt_generation`，建立 Run、Stage、Shard、Result、租约、幂等和产品级活动任务唯一约束；迁移已在本地 PostgreSQL 成功执行。
- 新增 NestJS 公开 API 与受保护 Worker API，实现事务 Outbox、CAS、项目隔离、双重质量重算、人工覆盖、单条原位重生成、提交门禁和事务内依赖复核。
- 新增独立 `workers/effect-prompt-generation`，实现 LangGraph `Send` 分片、最多三轮补齐、Ark 严格 Schema、显式 Mock、断点恢复、运行期缓存清理与安全日志。
- 第 03 步前端已移除 Prompt `localStorage` Mock，接入服务端工作区、设置保存、轮询恢复、分页搜索、六维编辑器、单条重生成、服务端导出和安全化子图详情；片段渲染及后续节点未改动。
- `pnpm check` 通过：Contracts 12 项、Web 119 项、API 161 项测试全部通过，lint、Prettier、TypeScript 与生产构建通过。
- Worker `uv run --frozen pytest` 19 项通过，`uv run --frozen mypy src tests` 22 个源文件通过；Compose 配置校验和 Worker 镜像构建通过。
- 浏览器使用显式 Mock Provider 完成 50 条批量生成、刷新恢复、10 条分页、安全节点详情、单条原位重生成、窄屏弹窗、ESC 与焦点恢复回归；截图见 `docs/browser-regression/effect-prompt-subworkflow-completed.png` 与 `docs/browser-regression/effect-prompt-subworkflow-narrow.png`。回归结果仅保存在领域草稿，未点击“完成校验”，未提交 Prompt WorkingArtifact。
- 未执行真实 Ark 付费测试；后续需在用户明确授权且本机 Key 可用时另行执行。
