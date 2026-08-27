# 效果类 AI 信息提炼分节点模型路由实施方案

状态：实现完成；自动化、容器与真实 Ark 分模型验收通过

更新日期：2026-08-24

## 1. 目标与边界

效果类信息提炼 Worker 的三次模型调用不再强制共用一个模型，而是按任务类型独立路由：

| 阶段            | 任务                                   | 模型要求                 | 配置                      |
| --------------- | -------------------------------------- | ------------------------ | ------------------------- |
| `DOCUMENT`      | 从 Word/PDF 的 Markdown 中抽取候选字段 | 长上下文、文本结构化输出 | `ARK_DOCUMENT_MODEL`      |
| `IMAGE`         | 从产品图片中提取视觉与商品语义         | 多模态、结构化输出       | `ARK_IMAGE_MODEL`         |
| `NORMALIZATION` | 将融合候选规范化为最终十二字段         | 轻量、稳定严格 Schema    | `ARK_NORMALIZATION_MODEL` |
| `FUSION`        | 按固定优先级合并候选                   | 确定性代码               | 不调用模型                |

本次采用部署级配置，不增加前端模型选择、项目配置、数据库字段或公共 HTTP 契约。模型拆分主要用于降低成本和延迟，不承诺仅靠切换模型减少输入 Token；输入规模继续由文档截断、图片压缩、独立提示词和融合后标准化控制。

## 2. 配置与兼容规则

保留 `ARK_MODEL` 作为兼容默认值，新增三个可选变量：

```dotenv
ARK_MODEL=doubao-seed-2-1-turbo-260628
ARK_DOCUMENT_MODEL=
ARK_IMAGE_MODEL=
ARK_NORMALIZATION_MODEL=
```

节点专用值会先去除首尾空白；为空或未设置时回退到 `ARK_MODEL`。Ark 模式启动时，API Key 与三个解析后的模型标识都必须有效；Mock 模式不依赖 Ark 模型配置。专用模型调用失败时不在运行期自动切换到默认模型，仍使用同一模型执行既有有限重试，避免隐藏权限、能力和成本配置错误。

三个专用变量可以相同，也可以填写已授权的 Model ID 或 Endpoint ID。图片模型必须支持图片输入和严格 JSON Schema；文档与标准化模型必须支持当前 Responses API 和严格 JSON Schema。

## 3. Worker 数据流

`WorkerSettings` 负责把四项环境配置解析为文档、图片和标准化三个最终模型。`ArkResponsesProvider` 持有不可变模型路由，每次 `_structured` 调用显式接收本阶段模型；不使用可变“当前模型”状态，保证最多三张图片并发识别时不会串用模型或指标。

Provider 返回业务对象与本次安全调用指标。Pipeline 将文档和图片调用指标写入对应 `BranchItem.metadata.aiCall`，将标准化调用指标写入 `BranchOutput.metadata.aiCall`。已有分支 JSON 字段可承载这些数据，无需迁移。

安全指标结构为：

```json
{
  "stage": "IMAGE",
  "model": "configured-model-id",
  "promptVersion": "1.0.0",
  "inputTokens": 1234,
  "outputTokens": 420,
  "totalTokens": 1654,
  "latencyMs": 1860,
  "attempts": 1
}
```

Token 字段从成功响应的 `usage` 中容错读取，缺失或类型不正确时保存 `null`，不得导致业务调用失败。延迟覆盖本次调用的全部尝试，`attempts` 记录成功所在尝试次数。指标不包含 API Key、Authorization、Prompt、Markdown、图片 Base64、完整模型输入输出或内部地址。普通节点详情继续使用白名单投影，不向前端透传内部 `aiCall`。

## 4. 提示词与结果契约

三次调用继续分别加载：

- `document_extraction.prompt.txt`
- `image_analysis.prompt.txt`
- `result_normalization.prompt.txt`

提示词加载器从文件头部读取 `PROMPT_VERSION` 用于指标；缺少或格式非法时启动测试和调用立即失败。模型拆分不改变 `ExtractionCandidate`、`ExtractionResult`、严格 JSON Schema、Pydantic 二次校验、表单字段恢复或融合优先级。

## 5. 测试与验收

- 配置：覆盖全部专用配置、部分回退、全部回退、空白值、Ark fail-fast 和 Mock。
- Provider：确认三次请求分别携带正确模型，重试不换模型，FUSION 不发模型请求。
- 指标：覆盖 usage 完整、缺失、字段错误、重试次数和并发图片调用，不泄露请求内容。
- 兼容：仅配置 `ARK_MODEL` 时保持现有行为；现有 RabbitMQ、任务快照、WorkingArtifact 和归档语义不变。
- 工程：执行 Worker 全量测试、mypy、Compose 配置检查和 Worker 镜像构建。
- 真实模型：仅在显式 `RUN_ARK_INTEGRATION=1` 且本机提供真实凭据时执行；自动测试不发起付费请求。

## 6. 实际执行结果

2026-08-24 已完成以下实现：

- Worker 配置增加三个可选模型变量并完成空白归一化与 `ARK_MODEL` 回退。
- Ark Provider 按 DOCUMENT、IMAGE、NORMALIZATION 请求级选择模型；运行期重试保持同一模型。
- Provider 使用显式 `AiCallResult` 返回业务结果与独立指标，避免并发图片调用通过共享状态串写。
- 文档、图片和标准化 Branch metadata 已写入 `aiCall`；普通节点详情安全投影测试确认不会返回模型标识和 Token 指标。
- Prompt loader 会读取并验证各提示词文件中的 `PROMPT_VERSION`。
- `.env.example`、Compose、Worker README 和既有 AI 信息提炼实施文档已同步，示例配置不包含真实凭据。

实际验证结果：

| 验证项               | 结果                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| Worker 定向测试      | 21 项通过                                                                        |
| Worker 全量测试      | 29 项通过，3 项真实集成门控跳过                                                  |
| Worker mypy          | 27 个源文件无错误                                                                |
| API 节点详情安全投影 | 6 项通过                                                                         |
| Compose 配置         | `docker compose --profile effect-extraction config --quiet` 通过                 |
| Worker 镜像          | `ai-marketing-platform-effect-extraction-worker:latest` 构建成功                 |
| 真实 Ark 分模型冒烟  | DOCUMENT Lite、IMAGE Turbo、NORMALIZATION Mini 严格 Schema 调用通过              |
| 全仓检查             | `pnpm check` 通过；Contracts 9、API 129、Web 96 项测试通过，API/Web 生产构建通过 |

首次 Worker 全量测试使用 Windows 默认 pytest 临时目录时遇到目录权限错误，测试代码当时已有 28 项通过；改用独立 `--basetemp` 后全量 29 项通过。该错误不属于业务实现失败。

用户确认账号可使用全部模型后，已通过显式 `RUN_ARK_INTEGRATION=1` 执行一次最小真实冒烟：DOCUMENT 使用 `doubao-seed-2-0-lite-260428`，IMAGE 使用 `doubao-seed-2-1-turbo-260628`，NORMALIZATION 使用 `doubao-seed-2-0-mini-260428`，三阶段均通过当前 Responses API、图片输入、严格 JSON Schema 与 Pydantic 契约。该测试产生少量模型用量；真实 API Key 未输出或写入文档。
