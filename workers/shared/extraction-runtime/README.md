# 提炼共享运行时

效果类和定制类通过本地 editable package `extraction-runtime` 使用同一份 Docling 解析、模型初始化、文本分片、通用表格读取、结构化 Responses 请求和内部 API HTTP 工具。Python 3.12，Docling 固定 2.117.0。

这里不包含业务 DTO、字段映射、图片识别、电商抓取、融合规则或工作流图，不导入任何 Worker。模型请求通过调用方提供的 Pydantic Schema、stage 与文案配置适配。请求日志只记录阶段、模型、哈希版本、耗时及用量；不记录资料正文、凭证和响应原文。

依赖及集成回归分别在 `workers/effect-extraction` 和 `workers/customized-extraction` 执行 pytest / mypy。更新该包须验证两类 Worker，保持效果类三路解析拓扑及业务语义。
