# 效果类信息提炼 Worker 规则

适用于 `workers/effect-extraction/**`，并继承 `workers/AGENTS.md`。

## 固定拓扑

提炼流程保持：

`LOAD_AND_SNAPSHOT → DOCUMENT / IMAGE / COMMERCE / FORM → FUSION → SEMANTIC_REFINEMENT → NORMALIZATION`

- 四个分析分支可并行，单个分支失败不得无条件拖垮全部任务。
- `FUSION` 只融合有证据的结果并记录冲突，不臆造缺失事实。
- `NORMALIZATION` 负责契约化输出、来源映射、警告和质量摘要。
- 当前 COMMERCE 分支固定为 `SKIPPED`；输入中出现链接时返回可见告警，不擅自实现网页抓取。
- Graph State 保持最小：输入只需 `project_id`，输出只需 `extract_result_id`。runId、draftId、productId、requestId、attemptToken 与 sourceFingerprint 放 runtime context；Markdown、图片结果、分支输出和标准化 JSON 通过内部 API 外部化。

## 分支职责

- DOCUMENT：商品文档、Brief、规格、卖点和限制。
- IMAGE：包装、产品外观、可见文字、场景与视觉特征。
- COMMERCE：结构化商品字段、渠道信息、价格/规格等明确事实。
- FORM：用户在页面确认或补充的结构化配置；明确人工输入优先级。

事实冲突时保留来源和冲突警告。人工确认字段可覆盖自动提取，但必须保存覆盖前值与来源，不可悄悄改写历史证据。

来源优先级固定为：

`当前人工修正 > 当前用户表单配置 > 文档明确事实 > 图片明确事实 > AI 策略推断`

产品名、规格、配方、产地、认证、功效、销量与信任背书等硬事实不得推断。价格带、人群、痛点、营销目标、场景、渠道与视觉策略只允许基于证据保守建议，并明确标为建议或待确认。

## 输出与版本

- 输出遵循 Result V3《产品素材制作信息卡》五层：产品基础层、卖点层、用户层、场景层、制作规则层。`targetAudiences` 是可编辑受众事实列表，`targetAudience` 只作为服务端派生的历史兼容摘要。事实、推断、建议、警告、来源引用与质量摘要不可混在一个自由文本字段。
- 每个业务字段应能追溯到文件、页面、图片、表单或上游资产。
- 核心卖点保持 1～3 项，超出内容按含义迁入次要卖点而不是截断；没有明确证据时信任背书为空数组。
- 持久化区分 `generatedResult`、应用人工覆盖后的 `draftResult` 和字段级 `manualOverrides`。数组覆盖完整保存，人工清空也是有效值。
- 重新提炼继承人工覆盖，并在 Worker 完成后由 API 确定性再次应用；历史 V1/V2 通过统一适配器读取，不调用模型迁移，也不隐式提交 V3 revision。
- 任务结果写入提炼节点的待确认结果；用户确认后才提交营销洞察等 WorkingArtifact revision。
- 相同规范化内容不得因重复运行产生无意义 revision。

## 运行时

- 默认使用真实 Ark/模型 Provider；模型名称、超时和并发从配置读取。
- 默认 `ARK_MODEL=doubao-seed-2-1-turbo-260628`；文档、图片和标准化模型仅作部署级可选覆盖。正常运行只要求 API Key，不强制 Endpoint ID。
- 缺少凭证或模型配置时 fail fast；只有显式测试开关允许 Mock。
- Ark 使用 Responses API 的严格 JSON Schema，返回后仍需 Pydantic/共享 Schema 二次校验。只对 429、5xx 和网络超时做有限重试。
- 文档解析运行时（如 Docling）与 Compose 依赖必须固定版本并有健康检查。

## 测试

- 覆盖四分支全成功、单分支失败、多分支冲突、空输入、模型非法结构、取消和重试。
- 覆盖人工覆盖、来源追踪、部分结果和规范化内容指纹。
