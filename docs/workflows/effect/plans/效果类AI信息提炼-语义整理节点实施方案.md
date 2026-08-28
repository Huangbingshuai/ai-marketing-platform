# 效果类 AI 信息提炼：语义整理节点实施方案

## 1. 状态与范围

- 状态：已实施，真实付费端到端回归通过，待人工验收
- 日期：2026-08-28
- 工作流：效果类
- 业务节点：第 2 节点“AI 信息提炼”

本次只解决提炼信息中痛点、决策动因、使用场景、购买场景和情绪场景的语义重复。目标受众拆分、卖点证据、次要卖点可视性和营销目标批次化不在本次范围。

## 2. 拓扑与职责

顶层业务流程不变；信息提炼 Worker 在 `FUSION` 与 `NORMALIZATION` 之间增加一个可持久化、可重试、用户可见的 `SEMANTIC_REFINEMENT` 节点：

```text
LOAD_AND_SNAPSHOT
  ├─ DOCUMENT
  ├─ IMAGE
  ├─ COMMERCE
  └─ FORM
       ↓ waiting edge
    FUSION
       ↓
    SEMANTIC_REFINEMENT
       ↓
    NORMALIZATION
```

`SEMANTIC_REFINEMENT` 内部保持为单一节点：先做稳定字符串规范化和完全重复去重，再使用 Ark 文本向量召回同字段近似事实，最后以一次严格结构化 Seed 2.1 Turbo 请求判断语义组并生成规范主题。节点不会拆成更多 LangGraph 子节点。

## 3. 数据与算法

- 处理字段：`corePainPoints`、`decisionDrivers`、`usageScenarios`、`purchaseScenarios`、`emotionalScenarios`。
- 只允许同字段归并，不跨字段比较。
- 关系类型：`SAME_MEANING`、`PARENT_CHILD`、`SAME_FAMILY`；模型认为内容不同或无法可靠判断时不归并。
- 原始表述完整保存在节点 `metadata.semanticGroups` 中；标准化候选只写规范主题。
- 每条原始表述最多属于一个归并组；组成员不得丢失、重复或引用不存在的事实。
- 人工覆盖仍由 API 在 Worker 完成后确定性重放，语义节点不改写历史人工覆盖。
- 向量只用于候选召回，不能单独作为删除依据。
- 向量和模型输入不写 Graph state、数据库公开响应或日志；节点只持久化安全摘要、规范主题和原始成员映射。

语义判定默认使用 `doubao-seed-2-0-lite-260428`，可用 `ARK_SEMANTIC_MODEL` 单独覆盖；该任务是候选对分类与规范主题生成，不需要沿用更慢的多模态 Turbo 模型。向量模型默认使用 `doubao-embedding-vision-251215`，复用 `ARK_API_KEY`，允许用 `ARK_EXTRACTION_EMBEDDING_MODEL` 覆盖。多模态向量端点一次只发送一个文本并限制并发，因此正常本地使用仍只要求填写一个 `ARK_API_KEY`。

## 4. 状态、恢复与接口

- Prisma 和共享契约新增 `SEMANTIC_REFINEMENT` 分支/节点枚举。
- `EffectExtractionBranchOutput` 继续作为唯一节点输出账本，唯一键仍为 `projectId + runId + branch`。
- RabbitMQ 消息、公开 API 路径、Run 幂等、租约和 Outbox 不变。
- Worker 重投时复用已经成功持久化的节点结果；Graph state 仍只保留小型路由数据，最终只输出 `extract_result_id`。
- `GET /runs/:runId` 返回语义节点状态；节点详情只展示整理前后数量和归并组，不展示向量、相似度、Prompt、Token、模型名或存储地址。
- 历史 Run 没有该分支记录时返回 `PENDING` 或按历史终态显示为未执行，不伪造成功数据。

## 5. 用户展示

工作流弹窗在“多源融合”和“标准化与结果保存”之间增加“语义整理”卡片。状态颜色、键盘交互、右侧详情和窄屏布局沿用现有实现。

点击节点时展示：

- 已整理的信息条数。
- 归并后的主题数量。
- 每个规范主题及其原始表述。
- 未产生归并时的明确空状态。
- 安全化失败或部分完成原因。

## 6. 测试与验收

- Contracts：节点和边完整、枚举唯一、旧响应兼容。
- API：状态映射、项目隔离、节点详情不泄漏内部数据。
- Worker：同字段归并、跨字段隔离、稳定 ID、向量乱序/超时/429、非法向量、非法模型分组、幂等重跑和 state 白名单。
- 广式腊肠样例：两条日常佐餐痛点、两条家庭用餐场景和两条围餐情绪分别归组；年节采购与礼赠形成一个规范主题并保留原始成员。
- Web：节点顺序、运行状态、点击详情、刷新恢复、失败状态和窄屏布局。
- 回归：TypeScript 类型检查与测试、Python pytest/mypy/Ruff、前后端构建、Worker Docker 构建和 `git diff --check`。
- 默认自动测试使用 Mock Provider，不执行真实 Ark 付费请求；真实向量与 Seed 冒烟需显式启用。

## 7. 生命周期

语义整理结果仍属于本次提炼 Run 的待确认草稿。只有用户点击“完成校验”后才提交新的 `marketing-insight:{productId}` WorkingArtifact revision；规范化内容指纹未变化时不得增加 revision。Prompt 节点仍只消费已确认的具体 `artifactId + revision + contentHash`。

## 8. 实施与验证记录

已完成：

- Contracts、Prisma 枚举和迁移新增 `SEMANTIC_REFINEMENT`，本地数据库迁移已成功应用。
- LangGraph 已调整为 `FUSION → SEMANTIC_REFINEMENT → NORMALIZATION`，Graph state 未新增大字段。
- Worker 使用同字段向量近邻召回和一次严格 Schema 语义判定；无同字段多项时不调用向量或 Seed。
- 判定失败或超时时节点以 `PARTIAL` 保留融合原文继续标准化，并记录安全错误类型、尝试次数与耗时。
- API 节点详情仅投影规范主题、字段类型、语义关系和原始表达，不公开向量、相似度、Prompt、Token 或模型标识。
- Web 工作流弹窗已增加可点击“语义整理”节点；桌面和 800px 窄屏均无横向溢出。

实际验证：

- `pnpm typecheck`：通过。
- `pnpm test`：Contracts 15、API 283、Web 161，共 459 项通过。
- `pnpm build`：Contracts、UI、Nest API、Vue Web 全部通过。
- `uv run mypy src`：16 个 Worker 源文件无错误。
- `uv run pytest --basetemp .pytest-paid-e2e-final`：66 项通过，3 项需显式环境的集成测试跳过。
- `uvx ruff check`：新增语义模块及其独立测试通过；全 Worker 未配置 Ruff 基线，未将既有告警计入本次失败。
- `docker compose config --quiet`、Worker Docker build：通过；新镜像启动后成功消费 `effect.extraction.requested`。
- 浏览器：节点顺序、历史 Run 空态、点击详情、800×900 响应式和控制台错误检查通过。

自动测试通过 MockTransport 验证了向量端点请求、严格 Schema、模型路由和安全响应解析；随后已补充真实 Ark 付费端到端回归，记录如下。

### 8.1 真实付费端到端回归

- 首次真实 Run `384f8047-d918-4bcc-9227-70c1a2662d58` 完成到 100%；Docling、文档、电商、融合和标准化成功，图片分支部分完成。
- 24 次真实语义向量请求均成功，但语义裁决误用 Seed 2.1 Turbo，连续 3 次等待 120 秒后超时并安全降级。
- 同时发现 PARTIAL 节点详情仍显示“语义整理已完成”的状态文案错误。
- 已将语义裁决的无配置默认值调整为 Seed 2.0 Lite，并修正 PARTIAL/FAILED 详情摘要。
- 第二次真实 Run `23608e29-b008-4ee0-8344-f13a568c22ee` 中语义裁决成功，归并 11 组；但浏览器核对最终信息卡时发现标准化模型会重新扩写已归并的购买场景。
- 已在标准化模型返回后确定性恢复语义节点成功产出的五类列表，防止去重结果被下游重新展开；最终真实浏览器回归已确认生效。
- 第三次真实 Run `2154f91b-9ed5-4bfe-b5e9-509b29fd9320` 验证确定性恢复生效：最终购买场景只保留“节日相关场景送礼、作为伴手礼”，刷新后保持一致；语义裁决一次成功，耗时约 27.8 秒。
- 同次运行发现图片提示词要求每张图片生成完整 21 字段营销策略，真实输出过长并导致三张图片全部超时。已将图片提示词升级为 V3 可见信息提取：保留图片详情需要的名称、规格、外观、可见卖点、直接场景和视觉风格，限制数量与长度，其余策略字段固定为空；模型仍使用 Seed 2.1 Turbo。
- 最终真实 Run `b2016bf0-3af7-4eff-a558-e1807ae773d3` 完成到 100%，七个公开节点均为成功。文档、图片、电商、表单、融合、语义整理和标准化结果均通过浏览器核对。
- V3 图片分支 3/3 成功，三张图片并行请求分别在第 1、2、3 次尝试返回，最长墙钟耗时约 322 秒；节点详情可逐图展示可见产品事实。功能正确性已恢复，但 Seed 2.1 Turbo 的图片尾延迟和输出 Token 仍偏高，属于后续性能优化项。
- 最终 Run 的语义裁决使用 Seed 2.0 Lite，一次成功，耗时约 31.7 秒，归并出“蒸制后食用”和“节日送礼伴手礼采购”两组；标准化使用 Seed 2.0 Mini，一次成功，耗时约 21.7 秒。
- 浏览器验证最终购买场景只保留“节日送礼伴手礼采购”，语义整理节点展示原始表达映射；刷新页面后最终信息卡完整恢复，浏览器控制台无错误或警告。
- 本轮共执行 4 次完整真实 Ark 付费 Run。真实密钥仅从本机环境变量读取，未进入日志、文档或版本控制。
