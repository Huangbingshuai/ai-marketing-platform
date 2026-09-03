# 效果类 Prompt：移除次级标签实施方案

状态：已实施。

## 范围

- 当前节点：效果类工作流的 Prompt 生成节点。
- 直接上游：已确认的营销洞察工作副本与全局视频配置 revision。
- 当前草稿与提交边界：人工编辑继续写入 Prompt 批次草稿；用户点击“完成校验”后提交 `prompt-batch:{productId}` WorkingArtifact。
- 直接下游：视频渲染继续消费 Prompt 正文、推荐用途、兼容用途、时长和渲染配置。

## 改造

1. 从 Prompt 条目契约、严格 JSON Schema、Worker Pydantic 模型和 API 写入 DTO 中删除 `materialTags`。
2. Worker 不再生成次级标签，人工新增与修改弹窗不再接收该字段。
3. 结果卡、单条重生成、工作流详情、搜索与批量导出不再展示或使用次级标签。
4. 视频渲染 Mock 工作区不再复制、检索或展示次级标签。
5. 推荐用途和兼容用途保持不变，继续作为下游片段分类依据。
6. 历史结果读取时仅丢弃旧 `materialTags` 字段，再按当前严格结构校验；不会因此增加 WorkingArtifact revision，也不会把旧标签重新暴露到公共响应。

## 验收

- 新生成、人工新增和人工修改的 Prompt 数据中不存在 `materialTags`。
- 页面、弹窗、搜索、CSV 导出、工作流详情和视频渲染页面均不再出现次级标签。
- 历史含 `materialTags` 的结果仍可读取，但公共结果中该字段被移除。
- 推荐用途、兼容用途、异步评估、数量校验、语义重复度和下游渲染请求保持正常。
- Contracts、API、Web、Worker 相关测试、类型检查、构建与 `git diff --check` 通过。

## 实施结果

- 已从 TypeScript 契约、严格 JSON Schema、Pydantic 模型、Worker 结果、API 人工编辑、页面、CSV、搜索和视频渲染 Mock 中移除次级标签。
- API 读取旧结果时会剥离遗留 `materialTags`，再按当前结构严格校验；公开响应和后续保存不再携带旧标签。
- 推荐用途、兼容用途和用途筛选保持原有职责。
- Contracts 9 项测试、API 79 项测试、Web 33 项测试、Worker 62 项相关测试及 163 项完整测试通过（另有 1 项付费测试按环境跳过）；Contracts/API/Web 类型检查与 API/Web 生产构建通过。
- 浏览器验证 10 条可见 Prompt 卡片均无次级标签，兼容用途仍正常显示；390px 窄屏无横向溢出，控制台无错误。
- Worker 虚拟环境未安装 Ruff，因此本次无法执行 Ruff；Mypy 严格检查通过。
