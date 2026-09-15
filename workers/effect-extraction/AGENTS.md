# 效果类信息提炼 Worker 规则

适用于 `workers/effect-extraction/**`，并继承 `workers/AGENTS.md`。

## 固定拓扑

提炼流程保持：

`LOAD_AND_SNAPSHOT → DOCUMENT / IMAGE / COMMERCE → FUSION → SEMANTIC_REFINEMENT → NORMALIZATION`

- 三个分析分支可并行，单个分支失败不得无条件拖垮全部任务。
- `FUSION` 只融合有证据的结果并记录冲突，不臆造缺失事实。
- `NORMALIZATION` 负责契约化输出、来源映射、警告和质量摘要。
- COMMERCE 分支没有链接时为 `SKIPPED`；存在公开链接时先做安全静态抓取，内容不足再使用同一 Worker 进程内的 Playwright Chromium 渲染，禁止登录、验证码或平台风控绕过。
- Graph State 保持最小：输入只需 `project_id`，输出只需 `extract_result_id`。runId、draftId、productId、requestId、attemptToken 与 sourceFingerprint 放 runtime context；Markdown、图片结果、分支输出和标准化 JSON 通过内部 API 外部化。

## 分支职责

- DOCUMENT：商品文档、Brief、规格、卖点和限制。
- IMAGE：包装、产品外观、可见文字、场景与视觉特征。
- COMMERCE：结构化商品字段、渠道信息、价格/规格等明确事实。

事实冲突时保留来源和冲突警告。人工确认字段可覆盖自动提取，但必须保存覆盖前值与来源，不可悄悄改写历史证据。

来源优先级固定为：

`当前人工修正 > 文档明确事实 > 电商明确事实 > 图片明确事实 > AI 策略推断`

产品名、规格、配方、产地、认证、功效、销量与信任背书等硬事实不得推断。价格带、人群、痛点、营销目标、场景、渠道与视觉策略只允许基于证据保守建议，并明确标为建议或待确认。

## 当前输出

- 输出只包含产品品类、产品名称、核心规格、价格带、核心外观特征和统一 `sellingPoints`。
- `sellingPoints` 不分核心与次要；每条只表达一个有来源、可独立理解、与当前商品直接相关且能转化为可见产品素材的事实。通常建议控制在 40 项以内，但不得截断结构化标准资料中超过 40 项的独立有效事实，也不得阻止用户继续添加。竞品、泛行业常识、纯文字购买建议、保存或安全提醒，以及未经当前商品证据支持的医疗、保健、营养或成分功效不得进入卖点。
- 原料、口味、工艺、结构、性能、吃法、使用方式、适用人群、用户需求、使用场景和可信背书都可以成为卖点，但不得把营销目标或视频制作参数伪装成产品事实。
- 每个业务字段应能追溯到文件、页面、图片、表单或上游资产。图片只允许补充可见事实，不得推断配方、工艺、产地、认证、功效或销量。
- 卖点为空时任务明确失败并提示补充资料，不得用“待补充”等占位文本制造假卖点。
- 持久化区分 `generatedResult`、应用人工覆盖后的 `draftResult` 和字段级 `manualOverrides`。数组覆盖完整保存，人工清空也是有效值。
- 相同源资料指纹下重新提炼时继承人工覆盖；源资料包 revision 或执行输入哈希变化时，API 保留产品基础字段的人工修正，但清除会整组遮蔽新文档事实的 `sellingPoints` 覆盖。Worker 始终只生成当前源资料结果，人工覆盖只在 Worker 完成后由 API 确定性应用；历史字段只在 API 读取边界折叠到 `sellingPoints`，不调用模型迁移，也不隐式增加 revision。
- 任务结果写入提炼节点的待确认结果；用户确认后才提交营销洞察等 WorkingArtifact revision。
- 相同规范化内容不得因重复运行产生无意义 revision。

## 运行时

- 默认使用真实 Ark/模型 Provider；模型名称、超时和并发从配置读取。
- Playwright Chromium 属于本节点的进程内运行时，必须与 Worker 同容器、同生命周期，不得另建业务容器或内部 HTTP 服务。
- 默认 `ARK_MODEL=doubao-seed-2-1-turbo-260628`；普通产品文档默认使用 `doubao-seed-2-1-pro-260628`，`ARK_DOCUMENT_MODEL` 可作部署级覆盖；图片和标准化模型继续使用各自可选覆盖。正常运行只要求 API Key，不强制 Endpoint ID。
- 缺少凭证或模型配置时 fail fast；只有显式测试开关允许 Mock。
- Ark 使用 Responses API 的严格 JSON Schema，返回后仍需 Pydantic/共享 Schema 二次校验。只对 429、5xx 和网络超时做有限重试。
- 文档解析运行时（如 Docling）与 Compose 依赖必须固定版本并有健康检查。

## 测试

- 覆盖三分支全成功、单分支失败、多分支冲突、空输入、模型非法结构、取消和重试。
- 覆盖人工覆盖、来源追踪、部分结果和规范化内容指纹。
