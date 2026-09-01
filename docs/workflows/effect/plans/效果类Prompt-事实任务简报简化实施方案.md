# 效果类 Prompt：事实任务简报简化实施方案

状态：已完成

## 一、问题与目标

当前 Worker 把一条创意需要使用的事实拆成“视觉任务、业务背景、产品锚点、产品边界、支持事实”等多种角色。当卖点、痛点、受众或场景不适合直接作为画面证明时，系统会另选产品名称、规格或外观作为视觉任务，导致真正的业务重点退化为可选背景。最终 Prompt 虽然与商品有关，却常只绑定产品名称和规格，没有深度使用营销洞察。

本次只改造效果类第 3 节点 Prompt 生成的 Worker 内部契约，将每条任务收缩为：

```text
一个必须实现的业务重点 focusFact
+ 少量可搭配事实 allowedFacts
+ 一份只做真实性边界的 productSnapshot
+ focusFact 对应的安全视觉使用策略
```

目标是让卖点、痛点、受众、决策动机和场景成为创意真正要解决的任务，而产品名称、规格和外观只负责保证商品身份准确，不再与业务重点争夺“主要事实”位置。

## 二、范围与非目标

### 实施范围

- 简化 `CreativeFactAssignment` 内部模型，并兼容读取旧的已持久化分片。
- 简化事实分配、方向事实调度、生成模型输入和 Mock Provider。
- 生成候选增加 `focusFactId` 与逐字证据，Worker 只验证引用和证据位置，不判断语义。
- 评估模型继续判断事实是完整实现、部分实现还是未实现。
- 更新 Worker 单元测试、模板测试和说明文档。

### 非目标

- 不修改八阶段工作流拓扑。
- 不修改 HTTP 路径、Prisma Schema、公开 Prompt 结果结构或页面布局。
- 不修改 WorkingArtifact 提交边界。
- 不修改视频渲染、模板混剪及其他工作流。
- 不恢复六类 Prompt 配额或六条生成分支。

## 三、数据与生成流程

### 1. 最小事实任务简报

新任务内部结构：

```ts
type CreativeFactAssignment = {
  focusFactId: string;
  allowedFactIds: string[];
  assignmentHash: string;
};
```

- `focusFactId`：本条必须完整实现的一个业务事实，优先轮动核心/次要卖点、痛点、受众、决策动机及使用/购买/情绪场景。
- `allowedFactIds`：与重点兼容的少量已确认事实，包含 `focusFactId`，用于自然补充人物、场景或产品关系。
- `productSnapshot`：由 Provider 从产品名称、品类、核心规格和视觉特征确定性编译，只提供事实边界，不要求逐项声明绑定。
- `focusPolicy`：读取该重点事实的视觉使用策略，告诉模型可以直接展示、通过动作体现，还是只能作为人物/场景/产品关系语义表达；不得另选一个事实替代重点。

旧分片中的多角色结构在读取时迁移为该最小结构，不写回伪造的新业务结果。

### 2. 创意方向与事实分配

- 创意方向模型必须为每个方向至少关联一个可用业务事实。
- 模型遗漏强制事实时不再由 Worker 将其随意塞进语义无关的方向，而是判定方向规划响应无效并执行既有结构恢复流程。
- 方向调度继续均衡使用业务事实；每条任务从所属方向中领取一个 `focusFactId`。
- 商品名称、品类、规格和外观可以出现在商品快照中，但不替换 `focusFactId`。

### 3. 候选生成与事实确认

模型输出增加：

```ts
focusFactId: string;
focusFactEvidence: {
  evidenceText: string;
  evidenceSource: "CONTENT" | "CREATIVE_CORE" | "NARRATIVE" |
    "SCENE" | "PERSONA" | "PRODUCT_RELATION";
};
```

Worker 只做确定性检查：

- `focusFactId` 必须等于任务分配的重点事实。
- 该事实必须出现在 `declaredFactIds`。
- `evidenceText` 必须逐字存在于声明的正文、创意主线或六维字段。
- 所有声明事实都必须来自 `allowedFactIds`。

Worker 不判断这段文字是否在语义上完整表达卖点、痛点或场景。评估模型基于完整事实原文，将重点事实判断为 `EXACT / SEMANTIC_FULL / PARTIAL / NONE`；只有前两种才能成为最终事实绑定。

## 四、生命周期与兼容

- 直接上游仍为已提交且当前有效的营销洞察和全局视频配置，结果继续记录实际消费的 artifact revision 与内容哈希。
- 生成与评估只更新领域草稿和 `WorkflowNodeState`。
- 只有用户完成校验后才提交 `prompt-batch:{productId}` WorkingArtifact。
- 旧任务分片可读取；新任务只写最小事实简报。
- 本次字段仅存在于 Worker 内部模型和阶段分片，不扩展公开 API。

## 五、测试与验收

- 验证每条新任务只有一个 `focusFactId`，且 `allowedFactIds` 包含重点并保持小规模。
- 验证产品名称、规格或外观不会替换被分配的卖点、痛点、受众或场景。
- 验证旧多角色分片可以迁移读取。
- 验证生成模型缺少重点事实、引用其他任务事实或伪造证据位置时，该候选被拒绝。
- 验证语义完整性由评估模型结论决定，Worker 不做字符或业务语义推断。
- 验证方向规划遗漏强制事实时不会被 Worker 随机补进其他方向。
- 回归精确数量、向量 MMR、一次补充、共用提示词、人工编辑/单条重生成和 WorkingArtifact 边界。
- 执行 Worker pytest、mypy、Ruff 和 `git diff --check`。

完成后在本文记录真实测试结果并将状态更新为“已完成”。

## 六、实际实施结果

- 已将新任务的事实分配收缩为一个 `focusFactId` 和最多五个 `allowedFactIds`；商品快照独立提供名称、品类、规格与视觉边界。
- 已移除 Worker 在创意方向遗漏事实时随机补挂事实的逻辑；方向模型必须自行覆盖业务事实，否则响应按结构异常处理。
- 新候选必须返回重点事实及其证据位置，Worker 只核对引用范围和证据是否真实存在，不判断业务语义。
- 重点事实是否真正实现继续由评估模型判断；未实现只参与软提醒和择优扣分，不新增会破坏精确数量的硬门禁。
- 最终展示绑定由最多三项提高为最多五项，并优先保留卖点、痛点、受众、决策动机和场景等深层业务事实。

实际验证结果：

- `uv run --frozen pytest -q`：完整 Worker 测试套件通过，1 项显式 Ark 集成测试按默认配置跳过。
- `uv run --frozen mypy src`：通过，17 个源文件无类型错误。
- `uv run --frozen ruff check src tests`：通过。
- `git diff --check`：通过。
