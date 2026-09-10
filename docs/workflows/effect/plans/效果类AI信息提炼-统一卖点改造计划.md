# 效果类 AI 信息提炼：产品基础与统一卖点改造计划

状态：已完成

## 目标

效果类“AI 信息提炼”节点只维护两类用户可见内容：产品基础信息和统一卖点列表。卖点不再拆成核心卖点、次要卖点、受众、痛点、决策动因与三类场景等独立字段；口味、原料、工艺、结构、性能、吃法、使用方式、适用人群、用户需求、使用场景和可信背书，只要有资料依据且能帮助后续视频创意，都作为独立卖点保存。

本次直接覆盖当前业务结构，不新增 V3/V4 类型、Schema 联合或并行生成流程。提炼任务的固定拓扑、异步执行、草稿自动保存、人工确认、WorkingArtifact revision 与下游待更新规则保持不变。

## 当前唯一结果结构

```ts
type EffectExtractionResult = {
  productCategory: string;
  productName: string;
  coreSpecification: string;
  priceRange: string;
  visualFeatures: string;
  sellingPoints: string[];
};
```

- `sellingPoints` 至少一项，最多 100 项，单项最多 1000 字。
- 只清理空值和完全相同的重复值，不因主题接近自动删除用户事实。
- 每条新提炼卖点应是可独立理解、带明确主语或产品指向的完整事实表达。
- 现有 `resultSchemaVersion` 仅保留为存储基础设施字段，不参与业务分支，不新增新的版本号。

## 历史信息卡转换

API 统一通过无版本名称的归一化入口读取结果。旧信息卡打开时确定性折叠为当前结构，不调用模型、不立即改写数据库、不增加 revision；用户后续保存、重新提炼或确认时才持久化当前结构。

- 产品品类、名称、规格、价格和外观继续保留在产品基础信息中。
- 核心卖点、次要卖点、可信背书、目标受众、核心痛点、决策动因、使用场景、购买场景和情绪场景按原顺序合并到 `sellingPoints`。
- `targetAudience` 只在旧结果没有 `targetAudiences` 时作为兜底迁移。
- `marketingGoal` 不迁移，因为它是任务目标而不是产品事实。
- 时长、画幅、分辨率、渠道、视觉风格和禁用元素不迁移，因为这些配置分别属于 Prompt 或视频渲染节点。
- 完全相同的值只保留一次；来源与图片建议标记同步归并到新的 `sellingPoints` 字段。

## 跨层实现

1. Contracts：覆盖 TypeScript 类型、JSON Schema、常量和契约测试，只暴露产品基础字段与 `sellingPoints`。
2. API：以单一归一化函数替换带版本名称的结果适配器；同步处理 generatedResult、draftResult、manualOverrides、来源映射、更新与完成校验。
3. Extraction Worker：当前执行图收敛为 `LOAD_AND_SNAPSHOT → DOCUMENT / IMAGE / COMMERCE → FUSION → SEMANTIC_REFINEMENT → NORMALIZATION`；三个资料分支统一产出基础信息和卖点，语义整理不再执行跨字段迁移。
4. Prompt Worker：产品基础继续形成身份事实，每条卖点一对一进入事实应用表；所有非空卖点均可被创意规划使用，不再从旧字段词池映射。
5. Web：信息卡只展示“产品基础”和“卖点”两块；卖点使用无重复前缀的单列文本框，支持添加、删除、来源提示和自动保存。
6. 文档：同步根 AGENTS、效果类工作流指南、Extraction Worker 规则和 README，删除五层信息卡与版本化业务口径。

## 生命周期边界

- 直接上游仍是已确认的产品资料包及其 `artifactId + revision`。
- 生成和人工编辑只更新领域草稿与 `WorkflowNodeState`。
- 用户点击“完成校验”后才提交 `marketing-insight:{productId}`。
- 规范化内容指纹未变化时不增加 revision。
- 只有已存在且消费旧营销洞察 revision 的 Prompt 结果才标记待更新。
- 历史 WorkingArtifact 在只读转换时不被暗中重写。

## 验收

- TypeScript、JSON Schema、Pydantic 严格一致，当前结果不能写入旧业务字段。
- 旧信息卡的所有可用产品与营销事实都进入统一卖点，营销目标和制作参数不进入。
- 读取转换不增加 revision；保存与重新提炼继续正确继承人工覆盖。
- 文档、图片、电商三个资料分支和部分失败流程保持正常；已废弃的表单分支不再参与新任务。
- Prompt 节点能消费全部卖点，不再依赖核心/次要/受众/痛点/场景词池。
- 紫苏梅子酱、广式腊肠、洁面产品、磁吸移动电源和旅行箱均使用同一结构。
- 页面覆盖加载、空态、错误、待更新、编辑、完成校验和窄屏状态。
- 执行 Contracts、API、Web、Extraction Worker、Prompt Worker 测试、类型检查、生产构建与 `git diff --check`。

## 实施结果（2026-09-10）

- Contracts、API、Web、Extraction Worker 和 Prompt Worker 已统一消费产品基础信息与 `sellingPoints`；当前写入不再包含核心/次要卖点、受众、痛点、决策动因或场景词池。
- API 读取边界已验证历史字段按顺序折叠，当前 `sellingPoints` 存在时保持权威；读取不会写回数据库或增加 revision。
- Extraction Worker 在没有可信卖点时明确失败，不再写入“待补充”占位卖点；基础字段和卖点长度、卖点唯一性与 JSON Schema 对齐。
- Prompt Worker 已验证 100 条卖点、1000 字单项、五类商品统一映射、事实视觉策略分片恢复和多事实绑定。
- 自动测试：Contracts 26 项、API 293 项、Web 201 项、Extraction Worker 92 项通过（5 项显式集成门控跳过）、Prompt Worker 371 项通过（1 项显式 Ark 集成门控跳过）。
- 类型与构建：Contracts、API、Web 类型检查和生产构建通过；两个 Worker mypy 通过；本任务 Python 文件 Ruff 通过。
- 浏览器验收：真实历史山茶花信息卡成功折叠为 28 条统一卖点；桌面端保持双栏，860px 以下自动单栏，未触发重新提炼或任何付费调用。
