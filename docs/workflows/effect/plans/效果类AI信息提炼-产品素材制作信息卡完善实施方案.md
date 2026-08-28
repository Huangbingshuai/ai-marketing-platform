# 效果类 AI 信息提炼产品素材制作信息卡完善实施方案

状态：本地实施与自动化验收完成，真实 Ark 付费验收待显式开启

基线：`416f7e0`（当前工作区另有信息提炼页面未提交修改，实施时保留并合并）
原型基准：`references/prototypes/effect/effect-workflow.html` 的第 02 步“AI 信息提炼”区域

## 1. 目标

将现有 12 字段信息卡升级为五层标准化《产品素材制作信息卡》。模型必须保留用户表单、全局视频配置、文档明确事实和人工修正，同时允许图片理解与标准化节点为缺失的营销策略字段提供有边界的建议。

本次仅整改效果类 AI 信息提炼节点，不实现 Prompt 生成、渲染、最终归档或单产品视频配置覆盖。

## 2. Result V2 契约

```ts
type EffectExtractionResult = {
  productCategory: string;
  productName: string;
  coreSpecification: string;
  priceRange: string;
  visualFeatures: string;
  coreSellingPoints: string[];
  secondarySellingPoints: string[];
  trustBackings: string[];
  targetAudience: string;
  corePainPoints: string[];
  decisionDrivers: string[];
  marketingGoal: string;
  usageScenarios: string[];
  purchaseScenarios: string[];
  emotionalScenarios: string[];
  durationSeconds: number;
  aspectRatio: string;
  deliveryChannels: string;
  disabledElements: string[];
  visualStyleBaseline: string;
};
```

约束：

- AI 标准化阶段核心卖点生成 1～3 项；模型溢出部分按含义迁入次要卖点，不允许截断丢失。
- AI 标准化阶段次要卖点、信任背书最多生成 6 项，用户痛点、决策动因和三类场景最多生成 5 项；这些是模型生成边界，不是人工编辑边界。人工确认后的各列表字段统一最多保存 20 项。
- 信任背书只能来自明确证据；没有证据时为空数组。
- 时长、画幅、渠道和视觉风格的初始值继承资料导入节点全局配置；时长复用数值输入，画幅、渠道和视觉风格复用可搜索、可创建自定义值的选择控件，用户修改后形成字段级人工覆盖。禁用词继续至少包含资料导入节点的全局禁用词。
- `brandTone` 兼容迁移为 `visualStyleBaseline`；营销目标和投放渠道继续保留。

## 3. 来源优先级与人工覆盖

字段来源优先级固定为：

```text
当前人工修正 > 当前用户表单配置 > 文档明确事实 > 图片明确事实 > AI 策略推断
```

- `generatedResult` 保存本次模型标准化结果及服务端恢复的权威表单配置。
- `draftResult` 保存应用字段级人工覆盖后的可编辑结果。
- `manualOverrides` 按字段保存人工值；数组按完整数组保存，人工清空也是有效覆盖。
- 保存结果时，以 `generatedResult` 为基线重新计算覆盖字段；恢复为生成值时移除对应覆盖。
- 重新提炼时继承上一份结果的 `manualOverrides`，Worker 完成后由服务端再次确定性覆盖，不能只依赖 Prompt 自觉保留。
- 上游表单中的产品名、品类和全局视频配置在模型生成阶段保持最高来源优先级；模型不得改写数值、单位或禁用词。用户在信息卡中对制作规则的显式选择属于人工覆盖，不反向修改资料导入节点配置。

## 4. AI 节点职责

- DOCUMENT：只抽取文档明确表达的事实、卖点、受众、场景和背书；不补造证据。
- IMAGE：识别包装、形态、质地、构图和使用画面，并补充建议价格带、视觉卖点、人群、痛点、动因、营销目标和三类场景。
- FUSION：按确定性优先级合并、去重和记录来源，不调用模型。
- NORMALIZATION：将融合候选整理为 V2，完成卖点分层和策略补全；硬事实不得推断，策略建议不得伪装成用户事实。

三份 Prompt 均升级到 V2，包含完整 JSON 示例、反例和输出前自检。建议价格必须使用区间并包含“建议、需确认”。图片不得虚构规格、配方、产地、认证、功效、销量或信任背书。

## 5. API、迁移与兼容

- 保持现有公开 API 路径，更新请求与响应中的结果结构。
- 工作区产品状态增加 `resultSchemaVersion` 与 `manualOverrideFields`。
- `EffectExtractionResult` 增加 `manualOverrides Json`，默认空对象。
- 历史 V1 结果通过统一适配器读取：旧场景文本整体保留为一项、旧 `brandTone` 映射为视觉风格基线、前三项卖点保留为核心卖点、其余迁入次要卖点。
- V1 新增字段使用空数组或有效视频配置初始化；迁移过程不调用付费模型。
- 历史正式 WorkingArtifact 不隐式改写；只有用户重新提炼、保存并完成校验后才提交 V2 工作副本。

## 6. 前端展示

- 延续冻结原型的蓝白配色、卡片层级、双列密度和底部公共节点导航。
- 产品基础层展示品类、名称、规格、价格带和外观特征。
- 卖点层分为核心卖点、次要卖点和辅助信任背书。
- 用户层展示受众、核心痛点、决策动因和营销目标。
- 场景层展示使用、购买和情绪共鸣场景。
- 制作规则层直接复用资料导入节点的配置控件：时长允许在 1～300 秒间输入，画幅、渠道和视觉风格既可选择预设，也可搜索并创建自定义值；禁用词保持可编辑标签形式。
- 不恢复大面积来源提示横幅；价格建议直接带“建议、需确认”限定语。
- 保留 1 秒防抖保存、失焦刷新、revision CAS 和“完成校验”提交边界。

## 7. WorkingArtifact 边界

生成、重新提炼和人工编辑只更新 `EffectExtractionResult` 与节点草稿。只有“完成校验”通过后才按 V2 规范化 `contentHash` 提交 `marketing-insight:{productId}`：

- hash 相同：WorkingArtifact ID、revision、updatedAt 均不变化。
- hash 不同：原位更新并 revision + 1，仅此时传播下游 STALE。
- 历史 V1 读取适配和数据库迁移不得隐式增加 WorkingArtifact revision。

## 8. 实际执行与验收记录

执行日期：2026-08-25。

### 8.1 已完成实现

- 新增 Prisma 迁移 `20260825120000_expand_effect_extraction_result_v2`，为提炼结果增加 `manualOverrides Json`；本地 16 个迁移均已应用，数据库状态为最新。
- Contracts、严格 JSON Schema、NestJS 校验与 Python Pydantic 模型已统一为 schema v2。
- 历史 V1 由后端读取适配器转换为 V2；迁移不调用模型、不改写旧 WorkingArtifact。
- DOCUMENT、IMAGE、NORMALIZATION 三份 Prompt 均升级为 `2.0.0`，并分别补充字段边界、完整示例与输出前自检；FUSION 仍为确定性规则。
- IMAGE 阶段可输出建议价格带、用户痛点、决策动因、营销目标及三类场景；规格、配方、产地、认证、销量与信任背书继续受禁止臆造规则约束。
- 服务端对产品名、品类和全局禁用词执行确定性保护；时长、画幅、渠道与视觉风格以导入配置生成初始值，但允许保存为字段级人工覆盖，并在重新提炼后重新应用；人工空数组也作为有效覆盖保存。
- 前端已按五层信息结构展示并编辑全部 V2 字段；AI 生成数量保持 V2 分层约束，人工编辑列表统一最多补充到 20 项；未恢复来源提示横幅。
- WorkingArtifact 提交边界保持不变：生成和自动保存只更新结果草稿，显式“完成校验”才按 V2 hash 提交。

### 8.2 自动化验证

- Contracts：2 个测试文件、9 项测试通过。
- API：25 个测试文件、133 项测试通过。
- Web：21 个测试文件、109 项测试通过。
- Worker：32 项通过、3 项真实 Ark 集成测试按显式开关跳过。
- Python `mypy`：通过，无类型错误。
- 根目录 ESLint：通过。
- TypeScript/Vue 全仓类型检查：通过。
- API、Web、Contracts 与 UI 生产构建：通过。
- Worker Docker 镜像：构建成功；重建后已连接 `effect.extraction.requested` 队列。
- MinIO、PostgreSQL、RabbitMQ 与 Redis：本地容器均为 healthy；MinIO 9000/9001 正常暴露。
- `git diff --check`：通过。

### 8.3 `pnpm check` 说明

`pnpm check` 已执行，其 lint 阶段通过；format 阶段仅被本任务范围外、当前未跟踪的 `apps/web/src/workflows/effect/prompt-generation/` 六个文件拦截。本次新增和修改文件已经格式化，后续 typecheck、test 与 build 均已分别执行并通过。为避免覆盖用户正在进行的 Prompt 生成节点修改，本次未擅自格式化该目录。

### 8.4 待显式开启的外部验收

真实 Ark 图片独立输入属于付费外部调用，自动测试默认不发起；当前以 Prompt/Provider、严格 Schema、部分输入流水线和 Mock 端到端测试覆盖。启用现有真实集成测试开关后，可进一步记录真实图片的字段覆盖率、Token 和延迟，但不影响本次本地实现与构建结果。
