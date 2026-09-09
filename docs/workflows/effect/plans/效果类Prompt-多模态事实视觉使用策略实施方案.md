# 效果类 Prompt 多模态事实视觉使用策略实施方案

状态：已完成（2026-09-09）

## 目标

将 Prompt 生成工作流中的“事实视觉使用策略编译”从纯文本判断升级为图文多模态判断。模型同时读取已确认的营销事实与用户导入的商品主图、细节图，判断每条事实能否直接被画面表达、适合什么真实动作，以及不得从外观推导哪些配方、工艺或功效。

## 范围与非目标

- 保持当前八阶段 Prompt 执行图，不新增用户可见节点。
- 保持 `FactVisualStrategy` 输出结构、Prompt 批次结果、HTTP 公开路径和 Prisma Schema 不变。
- 不让图片成为新的业务事实源；图片只能证明外观、结构、可读文字与可拍动作，不得覆盖已确认营销事实。
- 不将图片复制到后续创意方向、候选 Prompt 和评估请求中；后续仍只消费已验证的视觉策略。
- 不新增 Docker 容器、数据库表、用户设置或人工标注流程。

## 数据与生命周期

1. Prompt API 从当前 `marketing-insight:{productId}` 的 `WORKING_ARTIFACT` 依赖中解析它实际消费的 `source-package:{productId}` revision。
2. 仅将该源资料包中 role 为 `PRODUCT_IMAGE` 且文件状态可用的图片写入 Prompt Run 快照。快照保存 `fileObjectId` 、文件名、MIME、大小和 SHA-256，不保存存储键、签名 URL 或文件正文。
3. 图片引用参与 Run `sourceFingerprint`，保证重试与检查点只适用于同一份不可变输入。
4. Worker 只能在有效 lease 与 attempt token 下，通过 Prompt 内部接口读取快照内列出的图片。API 同时校验 `projectId`、Run、文件 ID、可用状态和快照归属。
5. 历史 Run 没有图片引用时保持纯文本兼容；当前新 Run 有图片引用但全部无法解码时明确失败，不伪装成多模态成功。
6. 本次不改变 Prompt 草稿、完成校验、`prompt-batch:{productId}` 提交和下游待更新语义。

## Worker 实现

- 参考信息提炼图片分支的安全处理方式：校验图片、校正 EXIF 方向、转换 RGB、限制尺寸与输出字节，再编译为 JPEG data URI。
- Prompt Worker 拥有独立图片处理模块，不跨 Worker 导入信息提炼内部代码。
- `compile_fact_visual_strategy` 在同一次 Responses API 请求中传入事实文本和全部有效商品图。模型只获得无业务含义的图片顺序编号，不获得用户文件名或存储信息。
- 系统 Prompt 明确限制：图片只校正“怎么拍”和“不能证明什么”，不能增加价格、规格、配方、工艺、认证、功效或品牌声明。
- 策略模板哈希同时覆盖 system 与 user 模板；策略源指纹同时覆盖营销洞察哈希和图片 SHA-256。
- 检查点命中时不下载图片、不重复调用模型。

## 配置

- 新增可选的事实视觉策略模型路由，默认沿用当前 Prompt 候选模型。
- 新增图片输入安全上限、最大尺寸、压缩后上限和多模态 detail 配置。
- 使用现有 Prompt Worker 容器与队列，只增加 Pillow 运行依赖。

## 验收

- API 只快照与营销洞察依赖一致的产品图，不混入文档、视频或其他项目文件。
- 内部图片接口在项目、Run、lease、attempt token 或文件归属不匹配时拒绝读取。
- Ark 策略请求同时包含 `input_text` 和 `input_image`，图片不出现在日志和阶段元数据。
- 策略检查点命中时不再读取图片。
- 无图历史快照仍可解析和执行纯文本策略。
- Mock 队列、单条重生成、异步评估、Prompt 数量、WorkingArtifact 和下游渲染边界不回归。
- 执行 Contracts、API、Prompt Worker 聚焦测试，Python 类型与 lint，TypeScript 类型检查、相关构建和 `git diff --check`。

## 实施结果

- API 已按营销洞察记录的源资料包 artifact 与 revision 快照全部可用产品图，并提供仅限当前 Worker 租约读取的内部流式接口。
- Prompt Worker 已增加独立的安全图片处理模块；多张图片经格式校验、EXIF 校正、尺寸与字节压缩后，与事实文本进入同一次 Ark Responses 请求。
- 图片没有进入后续创意生成、评估或公开 Prompt 结果；阶段元数据只记录参考图数量和多模态/纯事实模式。
- 策略检查点已绑定“洞察内容＋图片引用”哈希；同一 Run 恢复时命中检查点不会下载图片或重复调用策略模型。
- 已验证：Contracts 25 项、API 297 项、Prompt Worker 317 项通过（另有 1 项需真实 Ark 环境的集成测试跳过）；API 与 Contracts 类型检查、API 生产构建、Python mypy、Ruff、ESLint 和 `git diff --check` 通过。
