# 效果类模板混剪 Worker 规则

适用于 `workers/effect-template-mix/**`，继承根目录和 `workers/AGENTS.md`，具体业务边界见 `docs/workflows/effect/agent-guide.md`。

- Worker 只消费 API/Outbox 创建的混剪 Run；从受保护的内部接口领取快照、续租、持久化检查点并写回终态，不直连数据库或对象存储。
- 原始 Prompt 和六槽位定义交给 AI 分类；不读取 Prompt 推荐用途作为槽位答案，也不用 Worker 的关键词、正则或字符相似度代替语义判断。
- Worker 可机械检查素材 ID、槽位枚举、评分范围、六素材唯一性、模板权威时长、截取边界、revision 和内容哈希。结构异常只做有界恢复或明确失败，不虚构分类、视频帧或成功状态。
- 已完成分类和截取分片仅可在同 Run、同快照、有效 attempt 下恢复；旧 attempt token 不得更新进度、结果或失败状态。
- AI 任务只产出节点草稿，不提交工作副本，不编码成片。人工已选定且仍合法的槽位由 API 保留，不能由重新填充覆盖。
- 不记录完整 Prompt、原始视频、Base64、模型原始响应、存储键、签名 URL 或密钥；Mock 不得伪装成真实 Ark 验收。
- 修改契约或生命周期时同步验证 API、Web、Contracts 和本 Worker 的测试、类型检查及差异检查。
