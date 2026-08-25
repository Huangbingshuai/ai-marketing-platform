# 效果类工作流——差异化 Prompt 批量生成节点实施方案

- 当前状态：实施中（Prompt 质量与节点详情整改）
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

## 7. 2026-08-25 Prompt 质量与节点详情整改（已被第 9 节纠正）

### 7.1 变更原因

浏览器回归发现，现有候选生成模板及 Mock 只产出一段式创意概述，虽然包含六维标签，但缺少可直接供视频素材生成消费的时间轴分镜、主体动作、产品细节、镜头执行、光线质感、声音/字幕及负向约束。与此同时，公开节点详情仅投影批次数量、分片、剔除和补齐等少量通用字段，多数节点没有对应 metadata，导致右侧详情缺少可用于理解和验收的信息。

> 纠正记录：本节曾错误地把单条 Prompt 设计成覆盖完整时长的多镜头视频方案，与“一条 Prompt → 一个素材片段 → 后续混剪”的正式链路冲突。第 9 节为当前实施口径；本节仅保留为变更历史，不再作为验收依据。

### 7.2 本轮目标与范围

- 保持公开拓扑、批次设置、结果表和 WorkingArtifact 提交边界不变。
- 将候选生成内部 Ark Schema 升级为结构化素材生成方案：每条包含创意核心、分时段镜头、画面与主体动作、产品聚焦、景别/运镜、光线质感、声音或字幕以及负向约束；Worker 再确定性拼装最终中文 Prompt。
- 策略规划和候选生成 Prompt 增加高质量正例、低质量反例与逐项自检要求。示例只作为结构与详略度基准，不得复制示例中的产品事实。
- Mock Provider 使用与真实 Provider 相同的分镜结构和最终拼装路径，避免浏览器验收被低质量规则文本误导。
- 拆分模型路由：策略规划使用独立轻量模型覆盖项，候选生成保留 Seed 2.1 Turbo；分别增加最大输出 Token 和最小推理强度配置。默认候选模型仍回退 `ARK_PROMPT_MODEL/ARK_MODEL`，运行失败不得静默切换模型。
- 节点详情按节点白名单展示真实安全摘要：输入快照、维度池规模与示例、正交组合示例、候选结构/分片进度、标准化结果、双重去重指标、门禁结论、补齐缺口和保存结果。允许展示已标准化的业务示例，不展示模型标识、内部 Prompt 模板、原始响应、Token 明细、存储位置或内部标识。
- 前端详情布局复用上一个 AI 信息提炼节点的状态、更新时间、刷新、字段卡片和加载/错误反馈模式；保持冻结原型的蓝白弹窗、左右分栏和窄屏结构。

本轮不修改片段渲染、Seedance、混剪、导出、相似度算法或数据库表结构，也不执行真实 Ark 付费调用。

### 7.3 数据、接口与部署影响

- Python 内部模型新增分镜草稿结构；跨服务 `EffectPromptItem.content` 仍为字符串，已有结果兼容，不新增数据库迁移。
- `EffectPromptStageOutput.metadata` 继续保存 JSON，但 Worker 只写安全化计数、短文本示例和质量值；公开 API 依据 `nodeId` 二次白名单投影。
- 新增部署项：`ARK_PROMPT_STRATEGY_MODEL`、`ARK_PROMPT_CANDIDATE_MODEL`、`ARK_PROMPT_STRATEGY_MAX_OUTPUT_TOKENS`、`ARK_PROMPT_CANDIDATE_MAX_OUTPUT_TOKENS`、`ARK_PROMPT_REASONING_EFFORT`。旧 `ARK_PROMPT_MODEL` 继续作为兼容回退。

### 7.4 测试与验收标准

- Worker：严格分镜 Schema、示例模板版本、确定性 Prompt 拼装、产品名/指定卖点/时间轴/镜头/负向约束完整性、节点级模型与 Token 参数、Mock/Ark 契约一致。
- NestJS/Contracts：每个公开节点只返回允许字段；未知 metadata、模型、模板、原始响应、Token 和内部 ID 不得泄露。
- 前端：逐个点击 10 个节点，右栏均有与阶段匹配的说明或明确等待态；支持刷新、加载、错误、更新时间、长文本换行、窄屏、ESC 和焦点恢复。
- 执行 `pnpm check`、Worker `pytest/mypy`、Compose config/build 和浏览器回归；未获额外授权不执行真实 Ark。

## 8. 2026-08-25 Prompt 列表操作完整性整改

### 8.1 当前节点与上下游边界

- 当前属于效果类工作流第 3 个业务节点“Prompt 生成”，直接读取第 2 节点已完成校验的 `marketing-insight:{productId}` WorkingArtifact；产品级批次设置保存在 `PROMPT_GENERATION:{productId}` WorkflowNodeState，并作为执行输入快照的一部分。
- 本节点领域结果仍为 `EffectPromptResult`；正式提交粒度仍为 `prompt-batch:{productId}`。人工新增、修改、删除、单条重生成和批量重生成只更新领域草稿与节点状态，不在操作按钮点击时提交 WorkingArtifact。
- 只有用户点击“完成校验”且数量、六维差异、双重去重和上游依赖均通过时，才更新 `prompt-batch:{productId}` WorkingArtifact。有效内容哈希变化后由既有工作副本机制在提交边界传播下游 STALE；未校验编辑不提前影响第 4 节点。
- 单条重生成继续使用 Prompt 稳定 `item.id` 和 `code` 原位替换；下游只消费完成校验后的批次、稳定 ID、内容哈希和依赖快照，不读取页面临时状态。
- 本轮明确不开发第 4 节点视频渲染、Seedance、模板混剪、成片输出，也不修改 AI 信息提炼、相似度算法、模型 Prompt 或数据库结构。

### 8.2 本轮目标与实施范围

- 逐项验真截图中的搜索、人工添加、修改、复制、删除、单条重新生成和批量导出，沿用现有公开 API、服务端分页与 revision/CAS，不新增生产依赖。
- 删除操作增加二次确认、ESC 关闭、焦点恢复和明确忙碌状态，避免误删或重复提交。
- 区分删除与单条重生成的进行中状态，阻止同一时刻重复点击或交叉触发，避免两个按钮同时显示错误的加载态。
- 复制优先使用 Clipboard API，并为浏览器权限或非安全上下文提供本地降级复制；复制不修改节点草稿。
- 批量导出继续从服务端权威结果生成 JSON，不从当前分页或搜索结果拼装；生成任务执行期间禁止导出旧快照。
- 完善前端静态交互断言和服务层/API 测试，覆盖按钮接线、CAS、权威导出及单条原位重生成。

### 8.3 测试与验收标准

- Prompt 专项前端与后端测试全部通过；新增交互必须通过 TypeScript、ESLint 和 Prettier。
- 删除确认支持确认、取消、遮罩、ESC 与焦点恢复；确认期间不能重复提交。
- 复制成功或降级失败均给出安全中文反馈；搜索仍由服务端在 ID、内容、片段类型和六维标签上过滤并保持 10 条分页。
- 单条重生成只替换目标项并保留稳定 ID、code、顺序和其他条目；批量导出包含服务端完整权威批次，不受当前页和搜索词影响。
- 完成后在本节记录真实测试、构建和页面回归结果，不以计划值代替执行结果。

### 8.4 实施与验收结果

- 当前状态：已完成。搜索、人工添加、修改、复制、删除、单条重新生成和批量导出继续复用服务端权威结果、项目隔离与 revision/CAS；没有新增生产依赖，也没有触碰第 4～6 节点。
- 删除按钮已增加二次确认、遮罩/ESC 取消、确认中防重复提交和触发按钮焦点恢复；删除与单条重生成改为独立忙碌类型，不再让两个按钮同时显示加载态或交叉重复触发。
- 复制按钮优先使用 Clipboard API，权限或非安全上下文不可用时降级到本地选区复制；失败时只显示安全中文提示，不修改节点草稿。
- 人工添加在服务端读取结果正文前先执行 200 条上限保护，避免为上限批次做不必要的全量质量重算，也不会写出超出共享 Schema 的无效草稿。
- 人工添加和批量导出仅在当前 V2 权威结果已经成功载入时启用；旧 V1、结构无效、加载中或正在生成时保持禁用，批量导出仍包含服务端完整批次而非当前分页/筛选结果。
- V2 设置恢复增加旧快照兼容填充，缺失的新字段使用共享默认值并深拷贝数组/权重，进入页面不再因 `additionalDisabledElements` 缺失而崩溃。
- Prompt 专项测试通过：Web 4 个文件 21 项、API 5 个文件 39 项、Worker 29 项及 mypy 25 个源文件；仓库 ESLint、TypeScript、Contracts 16 项、Web 123 项、API 180 项和前后端生产构建均通过。任务相关文件 Prettier 检查通过；仓库总 `pnpm check` 仅被任务开始前已修改的 `AGENTS.md` 格式告警中断，未擅自改写该用户文件。
- 浏览器回归确认 Prompt 工作区可从旧设置快照恢复；旧 V1 结果会明确要求重新生成，且“人工添加提示词”“批量导出”均为禁用态。第 9 节 Worker V2 源码测试与类型检查已通过，但运行中的容器尚未用该并行改造重建、当前项目仍只有旧 V1 结果，因此本轮未触发真实/Mock 批量生成，也没有写入或提交新的 `prompt-batch:{productId}` WorkingArtifact。

## 9. 2026-08-25 素材片段 Prompt 生成质量方向纠正

### 9.1 当前状态与业务边界

- 当前状态：实施中。
- 当前节点为效果类第 3 节点“Prompt 生成”，只读取最新已提交的 `marketing-insight:{productId}`，产出 `prompt-batch:{productId}`。
- 正确链路为“一条 Prompt → 一个可独立渲染的素材片段”；50 条 Prompt 代表 50 个素材片段方案，不代表 50 条最终成片。
- 六维差异只用于内部组合、分配和去重，必须自然转译成可见场景、单一人物、连续动作、产品关系、单一运镜、光线与节奏，不得在最终正文中输出“创意核心、差异化设定、叙事=、时间轴镜头”等策划元话语。
- 片段标签和六维作为结构化元数据单独保存，不混入可复制的最终视频生成 Prompt。
- 本轮不实施片段渲染、Seedance、模板混剪、时间轴或最终成片节点。

### 9.2 模型与生成契约

- 候选模型严格只返回 `slotId + promptText`；标签、六维、卖点、画幅和目标时长由冻结组合确定性回填。
- 每条 `promptText` 只描述一个场景、一个主要主体、一个连续可见动作和一种主要运镜；禁止多镜头时间轴、完整广告弧、多场景转场和受众画像堆叠。
- 七类主标签固定为钩子、痛点、产品展示、效果展示、卖点讲解、结尾转化、片尾品牌。正文不输出标签名，只执行该标签的单一素材职责。
- 策略规划增加卖点可见证据模式；无来源素材支持的工艺、配方、技术和抽象品质不得伪造成生产过程或效果证明，只能转为合规卖点讲解。
- 策略节点继续使用 Doubao Seed 2.0 Lite，候选节点继续使用 Doubao Seed 2.1 Turbo；其余阶段保持确定性。候选输出上限由 6144 调整为 4096 Token。

### 9.3 执行门禁与接口影响

- 在双重去重前增加执行有效性校验，拒绝元话语、完整时间轴、人物堆叠、缺少可见动作、不可拍证据、片段职责冲突、重复句、事实越界和占位错词。
- Normalization 只做空白、标点和受控枚举规范化，不自动改写或掩盖低质量模型结果；无效候选按原标签和卖点定向补齐。
- 人工新增和编辑执行相同门禁，并返回稳定、可理解的原因码和中文提示。
- 结果 Schema 升级到 V2；旧 V1 完整视频结果保留只读但禁止完成校验，必须重新生成。
- 节点详情展示各阶段业务示例、执行无效数量和安全原因汇总，不展示模型标识、系统 Prompt、原始响应、内部 ID 或存储位置。

### 9.4 测试与验收标准

- 用户提供的完整视频反例必须被元话语、人物堆叠、完整时间轴和不可拍证据规则拒绝。
- 七类片段分别满足单一职责；痛点和部分钩子片段允许不出现产品。
- 最终正文中六维均体现为可执行画面信息，但不得出现六维字段名、内部标签或差异化说明。
- 无生产素材时不得生成工厂、实验室、腌制过程、检测设备或专家背书。
- 50 条批次继续满足标签配额、核心卖点覆盖、任意两条至少三个维度不同及双重重复度阈值。
- 执行 Contracts、NestJS、Vue、Worker pytest/mypy、Compose 和浏览器回归；真实 Ark 仍需用户另行明确授权。
- 完成后在本节记录真实迁移、测试、构建、截图和提交结果，不以计划值代替执行结果。
