# 效果类 Prompt V11：分片滑动并发与阶段屏障设计方案

## 1. 文档状态

- 状态：待实施
- 最后更新时间：2026-08-28
- 所属工作流：效果类
- 所属业务节点：第 3 节点“Prompt 生成”
- 目标图版本：`V11_COHERENT_CREATIVE_GENERATION`

本文只设计 Prompt V11 的分片调度、阶段屏障、断点恢复和安全进度展示，不修改 Prompt V6 结果结构，不执行真实 Ark 或 Seedance 任务。

## 2. 现状与问题

当前 V11 在一个 LangGraph 处理函数内依次执行以下步骤：

```text
规划全部创意分片
→ asyncio.gather(全部创意分片)
→ 规划全部评估分片
→ asyncio.gather(全部评估分片)
→ 择优与必要补充
```

以用户设置 50 条 Prompt 为例：

- 首轮候选数为 `ceil(50 × 120%) = 60` 条。
- 创意生成每个分片最多 4 条，因此共有 15 个创意分片。
- 每个创意分片只调用一次模型，并要求该次调用精确返回该分片中的全部候选。
- 现有实现会同时创建 15 个 Ark 请求，没有显式的分片并发上限。
- `PROMPT_MAX_CONCURRENCY` 当前作为 LangGraph 配置传入，只能约束由 LangGraph 调度的图分支，不能限制处理函数内部手写的 `asyncio.gather`。
- 创意生成、评估分类和精确择优在实际执行图中仍被包装在同一个处理函数里，与公开 V11 七阶段拓扑不完全一致。

直接全并发会在同一个 API Key、同一个模型服务和同一个网络出口上形成瞬时峰值。即使没有收到 429，也可能因为服务端排队、连接复用压力或响应体读取时间过长出现 `ReadTimeout`。把 15 个分片机械分成“前 10 个全部结束后再发后 5 个”又会浪费先完成请求释放出的容量。

## 3. 固定业务与生命周期边界

### 3.1 上游输入

Prompt 节点只消费当前项目、当前效果类工作流 Run 下已经提交且为 CURRENT 的营销洞察工作副本：

```text
marketing-insight:{productId}
```

运行快照继续记录上游 `artifactId + revision + contentHash`、Prompt 设置、批次共用提示词、保留的人工条目和运行操作类型。分片调度不得在运行中重新读取页面草稿或其他项目的数据。

### 3.2 草稿与提交边界

- 分片生成、评估、择优、人工编辑和单条重新评估只更新 Prompt 领域草稿与 `WorkflowNodeState`。
- 只有用户点击“完成校验”，且数量精确、所有条目均已验证时，才提交：

```text
prompt-batch:{productId}
```

- 失败、短批次或 `NEEDS_REVIEW` 不得覆盖上一份有效 WorkingArtifact。

### 3.3 下游影响

第 4 节点“视频渲染”继续只消费已提交的 `prompt-batch:{productId}` 及其具体 revision。只有完成校验产生了真实内容变化并提交新 revision，已经消费旧 revision 的渲染节点才标记待更新。分片调度状态本身不传播到下游。

## 4. 目标执行拓扑

V11 用户可见的七个内部阶段保持不变，不新增效果类第七个业务节点：

```text
输入快照
→ 提炼事实准备
→ 共用提示词编译
→ 连贯六维创意生成
→ 创意质量评估与多用途分类
→ 精确数量择优与补充
→ 结果保存
```

真实 LangGraph 执行应拆成与上述拓扑一致的处理函数，不再由“连贯六维创意生成”一个函数包办生成、评估和择优。

首轮与补充轮都遵守同一调度规则：

```text
创意生成分片：节点内滑动并发
→ 等待本轮全部创意分片成功
→ 评估分类分片：节点内滑动并发
→ 等待本轮全部评估分片成功
→ 精确数量择优
→ 若不足且尚未补充：进入一次补充轮
→ 否则保存结果
```

补充轮不增加新的用户可见节点。页面在“精确数量择优与补充”详情中显示当前为首轮或补充轮；实际 Worker 使用 `round=0|1` 区分检查点。

## 5. 节点内滑动并发

### 5.1 定义

每个需要调用模型的阶段使用独立的有界工作池。工作池始终满足：

```text
0 <= 当前运行分片数 <= 当前阶段并发上限
```

任意分片完成后立即释放一个槽位；只要当前阶段仍有待处理分片，就立刻启动下一个，不等待同一批次中其他较慢的分片。

以创意生成并发设置为 10、共有 15 个分片为例：

```text
开始：G01～G10 同时执行，G11～G15 等待
G04 完成：立即启动 G11
G02 完成：立即启动 G12
G09 完成：立即启动 G13
……
直到 G15 也完成
```

这里不存在固定的“第一波十个”和“第二波五个”。先完成的前十个分片不需要等待其他创意分片才能释放并发槽位；但它们的结果只作为已持久化检查点保存，不能越过阶段屏障提前进入评估节点。

### 5.2 推荐配置

新增 V11 专用配置，避免与历史 V8～V10 的 LangGraph 分支并发混淆：

```text
PROMPT_V11_CREATIVE_MAX_CONCURRENCY=8
PROMPT_V11_CLASSIFICATION_MAX_CONCURRENCY=4
PROMPT_V11_CREATIVE_SHARD_SIZE=4
PROMPT_V11_CLASSIFICATION_SHARD_SIZE=5
```

约束与兼容规则：

- 创意并发允许 `1..10`，默认 8；确认当前 Key、模型服务和网络出口稳定后可以配置为 10。
- 评估并发允许 `1..6`，默认 4。评估返回字段多、单次响应更长，不与创意阶段共用并发值。
- 创意分片默认 4 条，保持当前 V11 实际上限。
- 评估分片由当前 10 条调整为默认 5 条，降低 3072 输出 Token 上限下结构化结果被截断的风险。分片大小和并发数是两个独立参数，不能通过提高并发解决单次输出过长。
- 现有 `PROMPT_MAX_CONCURRENCY` 保留给历史图的 LangGraph 分支调度，不再被误认为 V11 手写模型请求的并发上限。
- RabbitMQ 当前单 Worker 进程 `prefetch_count=1`，同一进程一次只处理一个 Run。后续如果增加多 Run 并发，必须再增加进程级总 Ark 请求上限，不能简单把每个 Run 的上限相加。

### 5.3 调度器伪代码

Worker 增加可复用但只服务当前工作流内部的有界阶段调度器：

```python
async def run_stage_sliding(plans, concurrency, execute, on_progress):
    queue = asyncio.Queue()
    for plan in plans:
        queue.put_nowait(plan)

    async def worker():
        while True:
            plan = await queue.get()
            try:
                await execute(plan)
                await on_progress(plan, "SUCCEEDED")
            except RetryableShardError as exc:
                await on_progress(plan, "FAILED", exc)
            except NonRetryableShardError as exc:
                await on_progress(plan, "FAILED", exc)
                stop_dispatch.set()
            finally:
                queue.task_done()

    workers = [create_task(worker()) for _ in range(min(concurrency, len(plans)))]
    await queue.join()
    await close_workers(workers)
    assert_stage_barrier()
```

实现时可以使用 `asyncio.Queue` 工作池或等价的受控任务集合，但不能再次使用不带 Semaphore 的全量 `asyncio.gather`。调度器只负责并发、收口和进度，不包含 Prompt 业务规则。

## 6. 节点间全部完成屏障

### 6.1 屏障条件

创意生成进入评估分类前，必须同时满足：

- 本轮计划分片数已经冻结；
- 本轮所有计划分片均存在持久化记录；
- 所有分片状态均为 `SUCCEEDED`；
- 每个分片的返回条目与计划 `slotId` 精确一致；
- 汇总候选数与本轮计划数量一致；
- 不存在仍在运行、待处理、失败或计划哈希不匹配的分片。

评估分类进入精确择优前必须满足同样的全部完成条件，并额外要求每个候选恰好存在一份通过 Worker 确定性校验的评估结果。

### 6.2 为什么不让单个创意分片直接流入评估

本方案明确不采用跨节点流水线，原因如下：

- 评估分片需要基于完整候选集合稳定切片；提前评估会使分片边界随请求完成顺序变化，断点恢复难以复用。
- 后续差异化择优需要整批语义、视觉和六维签名，提前评估不会直接缩短最终择优屏障。
- 同时运行创意模型与评估模型会让同一个 Key 的总并发变成两个阶段并发之和，重新形成不可控峰值。
- 节点状态更容易解释：生成完成后才开始评估，不会出现页面显示生成中但评估已部分运行的混合状态。

因此，创意分片完成后会立即持久化并释放槽位，但必须等待全部 15 个创意分片成功后，才开始第一个评估分片。

## 7. 分片规划与稳定检查点

### 7.1 稳定分片标识

沿用现有唯一维度：

```text
projectId + runId + phase + round + shardIndex
```

阶段继续使用：

```text
CREATIVE
CLASSIFICATION
```

每个分片计划必须使用稳定排序生成，并在现有 JSON 计划数据中携带或可确定性计算：

- `stagePlanHash`
- `sourceFingerprint`
- Prompt 模板版本或内容哈希
- 本分片的有序 `slotId` 列表
- `round` 与 `shardIndex`

本次不新增 Prisma 表或列。API 继续把创意计划或分类计划保存到 `EffectPromptShardOutput.combinationPlan`，Worker 恢复时根据完整计划重新计算哈希。只有 Run 输入指纹、阶段计划、模板版本和有序条目完全一致时才复用成功检查点。

### 7.2 即时持久化

每个分片开始前写入 `RUNNING`；成功后立即写入验证后的结构化结果和 `SUCCEEDED`，不等待同阶段其他分片。失败时立即写入安全错误码和 `FAILED`，不保存模型原始响应。

已成功的分片：

- 不再占用并发槽位；
- 当前尝试失败时仍作为检查点保留；
- 后续任务级重试不得再次调用模型生成；
- 旧 attempt token 的迟到回写继续由 API 租约校验拒绝。

## 8. 失败与重试收口

### 8.1 可重试分片错误

网络中断、`ReadTimeout`、429 和 5xx 等可重试错误采用以下行为：

1. 失败分片立即记录为 `FAILED`。
2. 已经在执行的同阶段分片允许正常结束并保存检查点。
3. 调度器继续完成当前阶段其余已经规划的分片，最大化可复用结果。
4. 本阶段全部请求收口后，阶段屏障判定失败，不进入下一节点。
5. Worker 通过现有 `/fail` 上报任务级可重试失败；API/Outbox 负责下一次尝试。
6. 新 attempt 只重新执行失败、缺失或计划不匹配的分片。

一次 `ReadTimeout` 只消耗一次任务尝试，不由 Provider、RabbitMQ 和任务层重复放大。

### 8.2 不可重试或系统性错误

鉴权失败、非法事实、严格 Schema 不兼容、输出明确截断、阶段计划损坏等不可重试错误出现后：

- 立即停止派发尚未开始的新分片；
- 已在执行的请求允许短时间收口并保存成功结果，必要时按 Provider 能力取消；
- 当前阶段和 Run 进入明确失败终态；
- 后续阶段保持未执行或跳过，不显示为永久“执行中”；
- 不自动重新排队。

### 8.3 Worker 失联

租约过期后，API 按现有 Prompt 租约恢复规则生成新 attempt token。恢复时：

- 上一次 attempt 留下的 `RUNNING` 分片视为未完成，重新进入待执行队列；
- `SUCCEEDED` 且计划哈希一致的分片继续复用；
- 旧 Worker 后续写回因 attempt token 失效被拒绝；
- 不允许旧分片覆盖新尝试的阶段进度或最终结果。

## 9. 进度与页面安全展示

每个并发阶段维护以下安全统计：

```ts
{
  round: 0 | 1;
  plannedShardCount: number;
  succeededShardCount: number;
  activeShardCount: number;
  pendingShardCount: number;
  failedShardCount: number;
  plannedItemCount: number;
  completedItemCount: number;
  concurrencyLimit: number;
}
```

这些统计写入现有 `EffectPromptStageOutput.metadata`，不新增公开 HTTP 路径。并发 Worker 内使用 Run 级锁顺序更新计数，避免多个分片完成时用旧计数互相覆盖；任务重试时从 PostgreSQL 分片记录重新聚合，而不是相信进程内计数。

页面详情示例：

```text
连贯六维创意生成
首轮 · 已完成 7/15 个分片 · 执行中 8 个 · 等待 0 个

创意质量评估与多用途分类
等待创意生成全部完成
```

阶段状态规则：

- 有待处理或运行分片：`RUNNING`
- 全部分片成功：`SUCCEEDED`
- 部分成功且仍可重试：Run 重新排队，节点显示安全重试提示
- 不可重试失败或达到最大次数：`FAILED`
- 因兄弟阶段失败未执行：`SKIPPED`

公开详情不展示模型名称、Key、Prompt 模板、事实原文、原始响应、Token 明细或内部 JSON。

## 10. 50 条任务的预期执行示例

按推荐默认值执行：

```text
目标结果：50 条
首轮候选：60 条
创意分片：15 个，每片 4 条，并发上限 8
评估分片：12 个，每片 5 条，并发上限 4
```

执行顺序：

```text
G01～G08 启动
→ 任意 G 完成即补入 G09～G15
→ G01～G15 全部成功
→ E01～E04 启动
→ 任意 E 完成即补入 E05～E12
→ E01～E12 全部成功
→ 从 60 条评估结果中精确选择 50 条
→ 不足时仅执行一次同规则补充轮
→ 保存领域草稿
```

如果创意并发被配置为 10，则只有第一行变为 G01～G10 同时启动，后续仍是“完成一个补一个”，而不是等待前十个全部结束。

## 11. 分层实施清单

### 11.1 Worker

- 将当前单个 `coherent_creative_generation` 处理函数拆为真实的生成、评估和择优处理函数。
- 实现通用的阶段内滑动并发调度器，替换 V11 的无界 `asyncio.gather`。
- 为创意和评估增加独立并发及分片大小配置。
- 在每个分片状态变化后即时持久化并更新安全进度聚合。
- 在阶段边界执行全部完成断言，任何失败不得进入下一节点。
- 首轮与一次补充轮复用同一调度器、屏障和检查点规则。

### 11.2 Contracts 与 API

- 复用现有 V11 节点 ID、`CREATIVE|CLASSIFICATION` 分片阶段和公开路径。
- 如现有阶段 metadata 类型不足，只增加向后兼容的可选安全统计字段。
- 保持 `EffectPromptShardOutput` 的现有 JSON 持久化，不新增 Prisma 表或迁移。
- 校验分片计划与返回结果、attempt token、租约和项目隔离。
- 终态失败时同步收口当前阶段和未完成后续阶段，防止页面假运行。

### 11.3 Web

- 继续以 Run 返回的阶段和 metadata 为权威，不在浏览器本地模拟并发进度。
- 展示完成、执行中、等待和失败分片数，以及首轮或补充轮。
- 刷新、产品切换和项目切换后均从后端恢复。
- 不展示或允许用户修改 Worker 并发配置；并发属于部署级能力，不是批次业务设置。

## 12. 测试与验收

### 12.1 调度器测试

- 并发上限为 10 时，任意时刻活跃创意请求不超过 10。
- G01～G10 中任意一个完成后，G11 在其他慢请求结束前启动，证明不是固定波次。
- 队列尾部不足并发数时正常收口，不生成空任务。
- 并发设置为 1 时退化为严格串行，结果语义不变。

### 12.2 阶段屏障测试

- 最早的评估调用时间必须晚于最后一个创意分片成功持久化时间。
- 任一创意分片失败时，评估调用次数必须为 0。
- 任一评估分片失败时，精确择优不得执行。
- 补充轮创意全部完成后才开始补充轮评估。

### 12.3 检查点与重试测试

- 15 个创意分片中 14 个成功、1 个 `ReadTimeout` 时，成功 14 个立即持久化。
- 新任务尝试只调用失败的 1 个创意分片；该分片成功后才开始评估。
- 计划哈希、输入指纹或模板版本变化时，旧检查点不得复用。
- 旧 attempt token 无法覆盖新 attempt 的分片、阶段或最终结果。
- Worker 退出后租约恢复能重跑旧 `RUNNING` 分片并复用 `SUCCEEDED` 分片。

### 12.4 回归测试

- 目标 50 条时最终仍精确选择 50 条，不恢复六类配额。
- V6 Prompt、六维连贯性、多用途分类、共用提示词和一次补充语义保持不变。
- V5 历史结果与 V8～V10 历史 Run 只读兼容。
- 人工编辑后的 `ITEM_EVALUATE` 继续只评估一条正文，并发上限自然收敛为 1。
- WorkingArtifact 只在完成校验时提交；失败和 `NEEDS_REVIEW` 不覆盖旧结果。

### 12.5 验证命令与真实调用边界

实施后至少执行 Prompt Worker pytest、mypy、Ruff，Contracts/API/Web 相关测试与类型检查、生产构建和 `git diff --check`。默认测试仅使用 Mock Provider；滑动并发的时序测试使用可控延迟的 Mock，不需要付费 Ark 调用。只有用户再次明确授权真实验收时，才使用真实 Ark 检查并发 8 与并发 10 的超时率和吞吐差异。

## 13. 非目标

- 不实现创意生成完成一个分片就立即跨节点评估的流式流水线。
- 不修改生成 Prompt 的业务模板、六维定义、评分权重或差异化算法。
- 不新增用户可见业务节点、公开 HTTP 路径、Prisma 表或生产依赖。
- 不调整第 4～6 节点，不实现 Seedance 视频渲染。
- 不把部署级并发上限暴露为用户批次设置。
