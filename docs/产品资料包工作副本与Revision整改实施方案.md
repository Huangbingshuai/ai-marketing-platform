# 产品资料包工作副本与 Revision 整改实施方案

> 状态：已完成“完成校验后提交工作副本”代码整改与自动化验收，待真实业务数据全链路验收
>
> 权威业务口径：`docs/项目、工作流草稿与资产管理通俗说明.md`
>
> 实施范围：效果类资料导入、产品有效视频配置、AI 信息提炼与当前项目工作区
>
> 最后更新：2026-08-24

## 1. 目标与边界

本次整改将效果类工作流的工作态统一为以下结构：

```text
每个产品
├─ source-package:{productId}          一条产品资料包 WorkingArtifact
│  └─ 多条 FileObject                  图片、Word、PDF、视频等文件
├─ effective-video-config:{productId}   一条产品有效视频配置 WorkingArtifact
└─ marketing-insight:{productId}        一条 AI 信息提炼 WorkingArtifact
```

目标是让节点草稿、可供下游使用的工作副本和正式资产各自承担明确职责：

- 页面输入和恢复状态只进入 `WorkflowNodeState`。
- 单文件上传成功后只创建 `FileObject`；上传会话自动 complete 只建立 Material/FileObject 关系，配置保存、生成成功和人工编辑也只更新领域草稿或结果表。
- 只有当前产品点击“完成校验”且校验通过后，才批量提交该产品对应的 `WorkingArtifact` 最新工作副本。
- 同一逻辑产物保留同一个 WorkingArtifact ID，只有有效内容变化才增加 revision。
- 普通退出、刷新和切换项目不创建 `ProjectAsset`。
- 当前项目工作区展示真实工作副本，不再伪装成正式资产或正式版本。

本次不实现：

- “完成工作流并归档”。
- WorkingArtifact 物化为 ProjectAsset。
- ProjectAsset 正式版本链。
- GlobalAsset 发布。
- 跨项目复制正式资产。
- 定制类、裂变类工作流的具体节点接入。

## 2. 当前实现差异矩阵

实施前必须以实际代码和数据库再次确认下表中的“当前实现”，迁移完成后在“执行结果”中记录真实数据。

| 主题                     | 权威设计                               | 当前已知实现                                                     | 风险                                                           | 整改目标                                                         |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| 导入产物粒度             | 每个产品一条聚合资料包 WorkingArtifact | 每个 READY 文件通常对应 `material:{materialId}` 工作副本         | 多张图片被展示成多张资产卡，无法表达资料包整体变化             | 聚合为 `source-package:{productId}`，文件改由 FileObject 管理    |
| 文件模型                 | 每个文件一条独立 FileObject            | 文件信息主要分散在 EffectImportMaterial 和文件型 WorkingArtifact | 无法稳定复用文件引用、计算资料包哈希和延迟清理                 | 新增 FileObject 与 WorkingArtifactFile                           |
| WorkingArtifact revision | 每个逻辑工作副本拥有独立 revision      | WorkingArtifact 缺少独立 revision；界面曾使用 NodeState revision | 同节点所有素材显示相同 revision，例如三张图片均显示 revision 8 | WorkingArtifact 增加独立 revision，资料包卡只显示资料包 revision |
| 内容哈希                 | 规范化业务内容 SHA-256，无变化不写入   | WorkingArtifact upsert 缺少完整的 hash no-op 语义                | 重试、重复上传或无效编辑可能产生伪变化                         | 增加 contentHash，并在事务内比较                                 |
| 视频配置                 | 每个产品一条有效配置工作副本           | 已使用易误解的 `global-video-config:{productId}`                 | 容易被误认为 WorkflowRun 唯一全局配置                          | 迁移为 `effective-video-config:{productId}`                      |
| 下游依赖                 | 保存来源逻辑产物及生成时 revision      | 主要通过时间戳或领域表关系间接判断                               | 不能可靠判断提炼结果是否过期                                   | 新增依赖快照及 CURRENT/STALE                                     |
| AI 提炼输入              | 读取资料包、配置和节点参数的固定快照   | 仍可能直接依赖导入草稿、产品和素材领域表                         | 任务期间上游变化后，迟到结果可能覆盖新状态                     | 任务固定依赖 revision，并以 CAS 写回                             |
| 自动保存                 | 1 秒防抖、失焦和导航前刷新、无变化不写 | 部分路径已实现，仍存在取消旧请求或基线强制递增的风险             | 产生 409 冲突或无意义 NodeState revision                       | 同节点串行合并，前后端 hash no-op                                |
| 文件删除                 | 先解除引用，再延迟清理无引用对象       | 可能在数据库提交后立即删除工作对象                               | 保存失败、任务引用或误删除时难以恢复                           | ORPHANED + 24 小时宽限期 + 持久清理任务                          |
| 当前项目展示             | 区分草稿、工作副本和正式资产           | WorkingArtifact 可能被适配为带 `currentVersion=1` 的假资产       | 用户误认为已经归档或产生正式版本                               | 使用工作副本专用卡片和详情                                       |
| 项目离开                 | 保存草稿、保留工作副本、暂停或保持活动 | 工作流位置可能通过最后保存节点推断                               | 重启或恢复时可能定位不准确                                     | WorkflowRun 保存 currentNodeId、lastActiveAt 与 PAUSED           |

## 3. 四层生命周期与三种 revision

### 3.1 四层生命周期

| 层级              | 保存内容                             | 产生时机                       | 当前项目可见              | 跨项目可选     | 本次是否创建 |
| ----------------- | ------------------------------------ | ------------------------------ | ------------------------- | -------------- | ------------ |
| WorkflowNodeState | 表单、选择、页面恢复状态、未归档编辑 | 首次访问或编辑后自动保存       | 是，显示草稿摘要          | 否             | 是           |
| WorkingArtifact   | 可供下游读取的最新已校验业务结果     | 当前产品完成校验并提交成功     | 是，显示“工作中/尚未归档” | 否             | 是           |
| ProjectAsset      | 完成工作流后归档的正式项目资产       | 未来明确执行“完成工作流并归档” | 是，显示正式版本          | 可作为复制来源 | 否           |
| GlobalAsset       | 用户明确发布的全局复用资产           | 未来从正式 ProjectAsset 发布   | 是                        | 是             | 否           |

### 3.2 三种 revision

| Revision                     | 用途                             | 并发字段                            | 何时增加                                   | 不应被谁代用                              |
| ---------------------------- | -------------------------------- | ----------------------------------- | ------------------------------------------ | ----------------------------------------- |
| `EffectImportDraft.revision` | 效果类导入领域数据的事务并发控制 | 导入接口的 `expectedRevision`       | 产品、素材槽位、配置等导入领域快照提交成功 | 不能显示为工作副本 revision               |
| `WorkflowNodeState.revision` | 节点页面恢复状态的并发控制       | NodeState PUT 的 `expectedRevision` | 规范化节点状态真正变化并保存成功           | 不能显示为资料包、配置或提炼结果 revision |
| `WorkingArtifact.revision`   | 下游可读取业务工作副本的修订号   | 工作副本内部 CAS                    | 该逻辑产物的有效业务内容真正变化           | 不能当作正式 ProjectAsset version         |

三种 revision 可以在同一次用户操作中分别变化，也可以只变化其中一种。例如：

- 只修改分页或展开状态：只可能增加 NodeState revision。
- 删除一张产品图片但尚未校验：Draft revision、NodeState revision 可以变化，资料包 revision 保持不变。
- 删除图片后完成校验：只有资料包 `contentHash` 真正变化时，资料包 revision 才增加一次。
- 修改视频画幅并通过校验：配置工作副本 revision 增加，资料包 revision 不变。
- 上游资料包变化：营销洞察只变为 STALE，洞察 revision 暂不增加。

## 4. 目标数据模型

### 4.1 FileObject

`FileObject` 是对象存储文件的权威记录，至少包含：

- `id`
- `projectId`
- `workflowRunId`
- `sourceNodeId`
- `originalName`
- `mimeType`
- `sizeBytes`
- `storageKey`
- `sha256`
- `status: AVAILABLE | ORPHANED`
- `orphanedAt`
- 创建、更新时间

约束与规则：

- `projectId + storageKey` 唯一。
- 所有查询、读取和删除必须同时校验 projectId。
- SHA-256 来自实际文件字节，不使用 storageKey、文件 ID 或上传时间代替。
- MinIO 凭据只来自环境变量，文档、源码、测试和日志不记录真实值。

### 4.2 WorkingArtifactFile

`WorkingArtifactFile` 连接资料包与 FileObject，至少包含：

- `projectId`
- `workingArtifactId`
- `fileObjectId`
- `role`
- `materialType`
- `sortOrder`

同一个 FileObject 可以在引用规则允许时被多个工作副本引用。移除一条关系不等于物理删除对象。

### 4.3 EffectImportMaterial 兼容关系

保留 `EffectImportMaterial` 作为导入节点的上传槽位、状态和错误信息记录，并增加可空 `fileObjectId`：

- READY 素材必须关联一个 AVAILABLE FileObject。
- FAILED、MISSING 或上传中的素材允许没有 FileObject。
- 文件名、MIME、大小、storageKey 和哈希以 FileObject 为权威来源。
- 兼容期内继续双写旧文件字段，使旧接口和回滚路径仍可用。
- 现有 Material HTTP DTO 暂时从 FileObject 投影原字段，不强迫前端一次性改完全部上传展示。
- 旧字段的物理删除不属于本次迁移，应单独评审。

### 4.4 WorkingArtifact

在现有逻辑唯一键不变的基础上增加：

- `revision: Int`，新建时为 1。
- `contentHash: String`，规范化内容的 SHA-256。
- `freshness: CURRENT | STALE`。
- 资料包完整性可放入 payload，并以 `COMPLETE | INCOMPLETE` 明确表示。

逻辑唯一键：

```text
projectId + workflowRunId + nodeId + artifactKey
```

### 4.5 WorkingArtifactDependency

依赖快照至少保存：

- 下游 WorkingArtifact ID。
- `sourceType: WORKING_ARTIFACT | EXECUTION_INPUT`；`NODE_STATE` 仅作历史兼容读取，新依赖禁止写入完整 NodeState revision。
- 上游 nodeId 或 artifactKey。
- 可空上游实体 ID。
- 生成时使用的上游 revision。
- projectId、workflowRunId。

来源实体删除后，依赖记录仍保留逻辑键和 revision 快照，用于说明旧结果为何待更新。

### 4.6 UploadSession 与 UploadSessionItem

`UploadSession` 保存一次用户批量上传操作及其幂等完成结果；`UploadSessionItem` 保存每个 `clientFileId` 的状态、文件信息、错误和 FileObject 引用。

状态至少区分：

- 会话：`OPEN | READY_TO_COMPLETE | COMPLETED | FAILED | CANCELLED`
- 项目：`PENDING | UPLOADING | READY | FAILED | REMOVED`

同一个会话完成后，重复 complete 必须返回原结果，不得再次增加 Draft revision。complete 不创建、不更新 WorkingArtifact，因此无论首次还是重放都不能改变 WorkingArtifact revision。

### 4.7 WorkflowRun

补充：

- `currentNodeId`
- `lastActiveAt`
- `PAUSED` 状态

ACTIVE 和 PAUSED 都允许后台任务、自动保存和工作副本更新。第一阶段一个项目、工作流和空间最多存在一个 ACTIVE 或 PAUSED 的运行，普通退出不创建新 workflowRunId。

## 5. artifactKey、内容哈希与 revision 规则

### 5.1 artifactKey

效果类当前使用：

```text
source-package:{productId}
effective-video-config:{productId}
marketing-insight:{productId}
```

artifactKey 使用稳定业务 ID，不使用产品名称。用户改名后卡片名称可以改变，但 WorkingArtifact ID 和 artifactKey 不变。

### 5.2 资料包 payload 与哈希

资料包 payload 保存：

- 产品 ID、产品名称、品类、SKU、电商链接。
- 影响下游的业务标签和产品归属。
- 有序文件角色及 FileObject 引用。
- 完整性状态。

资料包 `contentHash` 对以下规范化内容计算 SHA-256：

- 规范化后的产品业务字段。
- 每个文件的 SHA-256、角色、MIME、原始文件名和业务顺序。
- 排序、去重后的业务标签。
- 影响下游的素材关联。

以下字段不得纳入哈希：

- FileObject ID。
- 随机 MinIO storageKey。
- 上传进度。
- 保存中、失败等瞬时状态。
- 搜索、分页、展开等 UI 状态。

### 5.3 视频配置 payload 与哈希

每个产品的配置工作副本保存 `draft.globalConfig + product.configOverride` 合并后的有效配置：

- 视频时长。
- 画幅比例。
- 风格基调。
- 投放渠道。
- 禁用元素。
- 未来正式纳入的其他产品级覆盖项。

配置校验失败时只保存 WorkflowNodeState，不覆盖最后一份 CURRENT 配置工作副本。

### 5.4 revision CAS

所有 WorkingArtifact upsert 必须在事务内比较旧 contentHash：

- 不存在：创建 revision 1。
- 哈希相同：返回 `unchanged=true`，不更新 revision、`updatedAt` 和依赖。
- 哈希不同且 expectedRevision 匹配：保留 ID，revision 原子加 1。
- expectedRevision 过期：拒绝覆盖，返回并发冲突。

状态变化本身不增加 revision：

- CURRENT 变为 STALE 不增加。
- 上传进度或任务状态变化不增加。
- 重新生成失败不增加。

内容变化规则：

- 同一批次上传多个文件，一个产品的资料包只增加一次 revision。
- 不同时间的独立上传可以分别增加 revision。
- 文件新增、删除、替换或影响下游的排序变化增加资料包 revision。
- 修改有效视频配置只增加配置 revision。
- 人工修改提炼结果或重新生成出不同结果增加洞察 revision。
- 已提交后再恢复为某个历史内容，仍属于一次新的有效变化；只和当前快照比较。

删除产品的最后一个文件时不删除资料包，改为空资料包并标记 INCOMPLETE，资料包 revision 增加一次。删除整个产品时先标记 `REMOVED`，资料包与配置进入 `PENDING_DELETE`，下游结果保留为 `SOURCE_REMOVED/STALE`；24 小时内可恢复，宽限期后且无引用时才物理删除。

## 6. 批量上传协议

### 6.1 会话流程

```text
创建 UploadSession
    ↓
按 clientFileId 上传每个文件
    ↓
写入 MinIO、基础校验、计算 SHA-256
    ↓
创建或复用 FileObject
    ↓
所有未移除项目均 READY
    ↓
前端自动 complete(idempotencyKey)
    ↓
一个事务中建立 Material、文件关系并更新各产品资料包
```

约束：

- `clientFileId` 在一个会话中稳定且唯一，单项上传可以幂等重试。
- 页面刷新后可通过查询 UploadSession 恢复每项进度和错误。
- FAILED 项必须重试或由用户明确移除，不能静默提交部分资料包。
- complete 之前不更新最终资料包 revision。
- complete 是上传批次提交，不是节点完成，也不是用户手动保存资产；页面不得增加“完成上传”按钮。
- complete 的同一幂等键重试返回原回执。
- 事务失败时资料包保持原状态，本次无引用新文件进入即时补偿清理。

### 6.2 Revision 合并

同一批次跨多个产品时：

- EffectImportDraft 只提交一次，revision 最多增加一次。
- 每个产品独立计算自己的资料包哈希。
- 同一产品包含多个文件，也只进行一次资料包 upsert。
- 哈希没变化的产品返回 unchanged，不增加 revision。
- 清单导入 commit 使用同样的按产品聚合逻辑，不能只创建 READY Material 而遗漏资料包。

## 7. 产品有效视频配置扇出

全局配置改变后，按产品计算有效配置：

```text
effectiveConfig(product) = globalConfig + product.configOverride
```

扇出规则：

- 修改全局配置时遍历当前运行的全部有效产品。
- 每个产品分别计算规范化哈希。
- 只有有效值真正改变的产品，其配置 revision 才增加。
- 被产品 override 遮蔽而有效值未变的产品保持 unchanged。
- 修改一个产品的 override 只更新该产品配置工作副本。
- 新产品第一次形成有效配置时创建 revision 1。
- 某产品配置无效时保留其最后一份 CURRENT 配置，NodeState 可显示未保存为工作副本的校验错误。

全局配置扇出和资料包 upsert 必须使用同一套项目、workflowRun 和产品隔离检查。

## 8. 依赖、STALE 传播与迟到任务

### 8.1 依赖快照

启动 AI 信息提炼时固定读取：

- `source-package:{productId}` 当前 revision。
- `effective-video-config:{productId}` 当前 revision。
- 资料包关联 FileObject 快照。
- 提炼节点真正参与 AI 的业务参数哈希 `executionInputHash`。

`WorkflowNodeState.revision` 只用于页面草稿 expectedRevision，搜索、分页、展开、预览和结果编辑草稿变化都不能让洞察待更新。任务只保存资料包 revision、产品有效配置 revision 和 `executionInputHash`，不在 Worker 完成时重新解释整个 NodeState。

### 8.2 STALE 传播

上游有效内容变化或删除时：

- 直接依赖它的下游 WorkingArtifact 标记为 STALE。
- 继续递归标记间接下游。
- 只改变 freshness，不增加下游 revision。
- STALE 内容可以查看，但不能用于正式下游生成或未来归档。
- 重新生成成功并保存新依赖快照后恢复 CURRENT。

### 8.3 迟到任务保护

任务完成写入必须携带：

- 任务 token。
- 启动时目标 WorkingArtifact 的 expectedRevision。
- 全部来源依赖 revision。

提交时必须校验：

- 项目、workflowRun、节点和产品一致。
- 来源 revision 仍与任务快照一致。
- 没有更新任务已经提交到同一逻辑产物。

上游在任务运行期间变化时：

- 迟到结果不得写成 CURRENT。
- 迟到结果不得覆盖基于较新依赖产生的结果。
- 如业务需要保留迟到结果，只能作为 STALE 结果或任务诊断记录，不能替换当前最新工作副本。

下游 contentHash 包含结果内容和依赖 revision 快照。因此重新生成正文相同但依赖已经更新时，仍会形成一次新的有效洞察 revision，并恢复 CURRENT。

## 9. AI 信息提炼接入

提炼任务不再把效果类草稿表和素材表作为唯一权威输入，而是从资料包、配置、FileObject 与提炼节点状态组成固定输入快照。

以下操作都更新同一逻辑产物：

```text
marketing-insight:{productId}
```

- 首次生成成功。
- 重新生成成功。
- 人工编辑保存。

人工编辑保存时必须保持 EffectExtractionResult 和 WorkingArtifact 一致：

- 无变化时两者均不产生伪 revision。
- 成功写入后 WorkingArtifact revision 按哈希规则递增。
- NodeState revision 仅表示页面恢复状态，不能代替洞察 revision。

## 10. WorkflowNodeState 自动保存

统一行为：

- 停止输入 1 秒后防抖保存。
- 输入框失焦立即刷新。
- 切产品、切节点、退出和切项目前等待当前保存完成。
- 同一节点的请求串行合并，不通过取消旧请求制造 expectedRevision 冲突。
- 前端用规范化哈希避免无变化请求。
- 后端再次计算规范化哈希，命中相同内容时返回 unchanged。
- `replaceNodeStateBaseline` 同样必须支持 unchanged。
- 保存失败阻止本次导航并显示可重试错误。
- 真正的跨页面或跨客户端并发仍返回 409。

轻量提示只使用：

- 正在保存。
- 已自动保存。
- 工作副本已更新。
- 尚未归档。
- 上游已变化，待更新。

## 11. MinIO 两阶段交换与延迟清理

### 11.1 新文件提交

1. 上传到 `01-working` 工作目录。
2. 校验格式、大小和实际字节数。
3. 流式计算 SHA-256。
4. 创建 FileObject。
5. 在数据库事务中关联 Material 和资料包。
6. 事务提交后文件才成为正式工作引用。

### 11.2 替换和删除

1. 先创建并校验新 FileObject。
2. 数据库事务替换 WorkingArtifactFile 和 Material 引用。
3. 提交后旧 FileObject 无引用时标记为 ORPHANED。
4. 默认等待 24 小时。
5. 清理任务再次执行完整引用检查。
6. 确认无引用后删除 MinIO 对象，再删除或终结 FileObject。
7. 删除失败写入持久清理任务并重试。

新增非敏感环境配置：

```text
WORKING_FILE_CLEANUP_GRACE_HOURS=24
```

引用检查至少覆盖：

- EffectImportMaterial.fileObjectId。
- WorkingArtifactFile。
- UploadSessionItem。
- 运行任务和文件 hold。
- 其他 FileObject 引用。
- ProjectAsset、AssetVersion 和兼容旧表中的 storageKey。

本次事务失败产生、从未被数据库引用的新对象可以立即删除，不需要等待宽限期。真实 MinIO endpoint、账号和密码不得写入本文件、源码、测试、迁移报告或日志。

## 12. API 与兼容策略

### 12.1 批量上传 API

提供项目隔离的能力：

- 创建 UploadSession。
- 按 clientFileId 上传或重试单项。
- 查询会话及项目状态。
- 明确移除失败项。
- 使用幂等键 complete 会话。

现有单文件上传接口在兼容期内可内部桥接到单项 UploadSession；新页面统一使用批量协议。

### 12.2 WorkingArtifact API

工作副本响应增加：

- `revision`
- `freshness`
- `dependencies`
- `files`
- `fileCount`
- `completeness`
- `primaryPreviewUrl`

`contentHash` 和内部 CAS token 默认不向普通 UI 暴露。

### 12.3 FileObject 内容 API

FileObject 项返回：

- ID、角色和排序。
- 原始文件名、MIME 和大小。
- previewUrl 和 downloadUrl。

内容接口必须：

- 校验 projectId。
- 正确返回 Content-Type。
- 使用安全的原始文件名生成 Content-Disposition。
- 支持视频 Range 请求。
- 图片可内联预览。
- Word、PDF 等下载后保持原始字节，不发生编码转换。
- 跨项目访问统一返回 404，避免泄露对象是否存在。

资料包不再通过 WorkingArtifact 的单文件 content 接口访问；它的每个文件通过 FileObject content 接口读取。原 WorkingArtifact content 接口只保留给真正的单文件工作副本。

## 13. 当前项目 UI

前端参考：

- `references/prototypes/effect/effect-workflow.html` 的资料导入、产品资料包和全局视频配置区域。
- `references/prototypes/integrated/system-integrated-demo.html` 的项目中心容器和详情布局。

允许偏离原型的部分：原型中的节点级手动入库、正式版本和共享发布交互已被权威说明废弃，不能恢复。

当前项目工作区展示规则：

- 每个产品显示一张资料包 WorkingArtifact 卡片。
- 卡片显示产品名、资料包 revision、文件数量、完整性和缩略图组。
- 点击资料包后列出全部 FileObject 及其文件状态。
- 每个产品的有效视频配置显示为独立卡片，详情展示实际时长、画幅、风格、渠道和禁用元素。
- AI 提炼结果显示自身 revision 和依赖状态。
- 顶部“工作区产物”数量按 WorkingArtifact 数量统计，不按 FileObject 数量统计。
- WorkingArtifact 卡片直接使用其 revision，草稿摘要才显示 NodeState revision。
- freshness 由后端依赖判断返回，不再通过 `savedAt > updatedAt` 等时间戳推断。
- 不再把 WorkingArtifact 转换为带 `currentVersion=1`、Pending Review 的假 ProjectAsset。
- 工作副本不显示正式版本时间线、归档按钮或跨项目引用按钮。

项目资产库和跨项目选择器继续只查询 ProjectAsset，不得混入 WorkingArtifact 或 FileObject。

## 14. 数据迁移、兼容与回滚

### 14.1 迁移原则

- 不修改历史迁移文件。
- 新迁移必须可重复执行或安全检测已完成步骤。
- 先扩展、回填和兼容读取，再切换写路径，最后收紧约束。
- 不删除有效 MinIO 对象。
- 不修改现有 ProjectAsset、AssetVersion 和正式对象。
- 人工编辑后的 EffectExtractionResult 不能丢失。

### 14.2 回填步骤

1. 添加可空新字段、FileObject、关联表、UploadSession、依赖与 freshness。
2. 按 `projectId + storageKey` 幂等创建 FileObject。
3. 流式读取现有 MinIO 工作对象计算 SHA-256。
4. 无法读取的对象进入迁移报告，并阻止最终非空约束收紧。
5. 将 READY EffectImportMaterial 关联到 FileObject。
6. 按产品聚合旧 `material:{materialId}` WorkingArtifact：
   - 已有 `source-package:{productId}` 时合并进现有记录。
   - 否则按 `createdAt + id` 选择最早旧记录保留 ID，并改为资料包 artifactKey。
   - 其他旧文件型工作副本记录审计映射后删除。
7. 根据当前完整业务快照初始化每个资料包 revision 1；不得继承错误的 NodeState revision 8。
8. 为每个产品创建或原位迁移 `effective-video-config:{productId}`；内容未变时保留 ID、revision 和 `updatedAt`。
9. 将旧提炼逻辑键统一迁移为 `marketing-insight:{productId}`。
10. 洞察 payload 以最新 EffectExtractionResult.draftResult 为准，保留人工编辑。
11. 能验证 inputSnapshot 的结果重建依赖；无法验证的结果初始化为 STALE。
12. 校验数量、哈希、项目隔离和内容可读性后，打开资料包模型读取开关。
13. 稳定运行并完成回滚窗口后再收紧新字段非空约束。

### 14.3 兼容窗口

兼容期内：

- EffectImportMaterial 继续双写旧文件字段和 fileObjectId。
- Material DTO 保持旧 HTTP 字段，数据从 FileObject 投影。
- 旧单文件上传可以桥接新 UploadSession。
- 新旧工作副本读取由特性开关控制，但只能有一个权威写路径。
- 每次写入不得同时产生旧 `material:*` 与新 `source-package:*` 两套可见工作副本。

### 14.4 回滚条件与方法

发生以下任一情况时停止切换并回滚读取开关：

- READY Material 无法全部关联 FileObject。
- 文件哈希、大小或内容读取校验失败。
- 同产品产生重复 source-package。
- 正式 ProjectAsset 数量或正式 MinIO 对象发生非预期变化。
- 人工提炼结果丢失。
- 跨项目隔离检查失败。

回滚方法：

- 关闭资料包新模型读取开关。
- 继续使用兼容期保留的 EffectImportMaterial 旧字段。
- 不回滚或删除已经创建的 FileObject；它们作为可重试回填基础。
- 不物理删除任何迁移前有效对象。
- 修复数据后从迁移审计游标继续执行，而不是从头重复创建。

旧字段和迁移审计的最终删除必须另立任务，不包含在本次整改中。

## 15. 部署顺序

1. 完成本实施文档评审。
2. 增加兼容 schema、共享契约和双写代码。
3. 执行迁移 dry-run，生成对象、产品和工作副本统计报告。
4. 执行正式回填和 MinIO 流式哈希校验。
5. 验证 READY Material、FileObject、资料包、配置及洞察依赖。
6. 部署 API、Worker 和 Web 兼容版本。
7. 打开资料包模型特性开关。
8. 进行真实项目验收和跨项目隔离验证。
9. 稳定运行后收紧非空约束。
10. 将实际结果补回本文件。

## 16. 测试与验收

### 16.1 模型与 revision

- 同批上传十张图片：十个 FileObject、一条资料包、资料包 revision 1，Draft 最多增加一次。
- 同一 complete 幂等重试不改变记录数、ID、revision 和 `updatedAt`。
- 第二批上传三张：资料包 ID 不变，revision 只增加 1。
- 清单导入多个产品：每产品一条资料包，各自最多增加一次。
- 修改产品名或业务标签只更新对应资料包。
- 修改画幅或渠道只更新对应配置，不更新资料包。
- 修改全局配置只更新有效值真正变化的产品。
- 无变化保存返回 unchanged。
- 删除最后文件后保留 INCOMPLETE 空资料包。
- 删除产品后标记 `REMOVED`，上游副本进入 `PENDING_DELETE`，下游保留为 `SOURCE_REMOVED/STALE`；24 小时内恢复不删 MinIO。

### 16.2 依赖与并发任务

- 资料包或配置变化后，下游递归变为 STALE，自身 revision 不变。
- STALE 结果不能进入正式下游执行或未来归档。
- 任务运行期间上游变化时，迟到结果不能覆盖新结果或写成 CURRENT。
- 重新提炼成功后洞察 ID 不变、revision 按规则增加、依赖快照更新。
- 人工编辑保持同一洞察 ID；无变化编辑不增加 revision。

### 16.3 自动保存与离开

- 验证 1 秒防抖。
- 验证失焦立即保存。
- 验证切产品、切节点、退出和切项目前刷新。
- 验证无变化时前端不请求、后端不写入。
- 验证同节点请求串行合并。
- 验证保存失败阻止导航。
- 验证真实并发冲突返回 409。
- 普通退出后 WorkflowRun 为 PAUSED 或保持活动，ProjectAsset 数量不变，后台任务仍可按 CAS 写回。

### 16.4 文件与 MinIO

- 图片缩略图正常显示。
- Word、PDF 下载后字节与上传文件一致，不乱码。
- 视频 Range 请求正确。
- 跨项目 FileObject 内容访问返回 404。
- 替换或删除后，宽限期内旧对象仍存在。
- 存在任一有效引用时清理任务不删除对象。
- 宽限期结束且无引用后成功删除对象和记录。
- MinIO 删除失败时持久清理任务可重试。
- 上传或数据库事务失败时，新对象被补偿清理，旧资料包保持可读。

### 16.5 UI 与隔离

- 当前三张图片展示为一张产品资料包卡片和三项文件明细。
- 资料包卡片使用自身 revision 1，不再显示来自 NodeState 的 revision 8。
- 视频配置以单独卡片显示实际配置字段。
- 工作区数量按 WorkingArtifact 统计。
- NodeState revision 仅在草稿摘要中显示。
- freshness 使用后端依赖结果，不使用时间戳推断。
- 页面不出现 `v1`、Pending Review、保存到项目资产库或跨项目引用按钮。
- WorkingArtifact 和 FileObject 不进入项目资产库和跨项目选择器。
- 不同项目不能读取彼此的 NodeState、WorkingArtifact、FileObject 或上传会话。

### 16.6 迁移与全仓验证

- 所有 READY Material 均关联 FileObject。
- FileObject 数量与有效唯一 storageKey 数量一致。
- 每个有效产品最多一条 source-package 和一条 effective-video-config。
- 迁移后的资料包均从 revision 1 开始，不继承 NodeState revision。
- 旧人工提炼内容完整保留。
- 无法重建依赖的旧结果正确标记为 STALE。
- ProjectAsset、AssetVersion 和正式 MinIO 对象数量不变。
- 执行 Prisma 迁移验证。
- 执行 API、Web、Worker 单元与集成测试。
- 执行类型检查、生产构建和全仓 `pnpm check`。

## 17. 实际执行结果

> 本节在实施过程中逐项补充。不得用计划值代替实际结果。

### 17.1 代码与迁移

- 历史基线提交：`cc79dce`。该基线的测试数据仅表示上一轮实施结果，不作为本轮语义纠偏的最终验收结论。
- Prisma 迁移名称：
  - `20260824130000_working_artifact_packages_revision`
  - `20260824143000_normalize_migrated_working_packages`
  - `20260824144500_backfill_legacy_product_names`
  - `20260824160000_working_semantics_expand`
  - `20260824161000_execution_input_dependency_backfill`
- 特性开关：未新增运行时开关；通过“先兼容字段和回填、再启用聚合读写”的迁移顺序直接切换，旧 Material 文件字段继续双写保留回滚能力。
- 实际变更模块：Prisma 模型与迁移、WorkflowWorking 公共服务、效果类资料导入、AI 信息提炼、当前项目工作区、共享契约、MinIO 文件读取与延迟清理。
- 兼容期开始时间：`2026-08-24`。

### 17.2 数据回填

| 指标                       |   Dry-run | 正式执行 | 校验结果                                           |
| -------------------------- | --------: | -------: | -------------------------------------------------- |
| 扫描项目数                 |         7 |        7 | 7 个效果类工作区可读取                             |
| 扫描 WorkflowRun 数        |         7 |        7 | ACTIVE/PAUSED 均按同一运行恢复                     |
| READY Material 数          |        16 |       16 | 缺少 FileObject 的 READY 数为 0                    |
| 新建/复用 FileObject 数    |        16 |       16 | 16/16 可读取并完成 SHA-256 回填                    |
| source-package 数          |        16 |       16 | 每产品最多一条，迁移后均从 revision 1 开始         |
| effective-video-config 数  |        16 |       16 | 旧 key 原位迁移，没有遗留 global key               |
| marketing-insight 数       |         0 |        0 | 当前库没有可迁移的已完成旧洞察                     |
| 初始化为 STALE 的旧结果数  |         0 |        0 | 当前库没有无法验证的旧洞察                         |
| 文件读取或哈希失败数       |         0 |        0 | 报告中 failures 为空                               |
| 正式 ProjectAsset 数量变化 | 0（预期） |        0 | 校验时 Asset 14、AssetVersion 15；迁移未修改正式表 |

回填报告：`docs/working-file-backfill-dry-run.json` 与 `docs/working-file-backfill-report.json`。真实批量上传验收结束后额外产生 1 个 ORPHANED FileObject，它不属于上述迁移回填数量，已进入 24 小时延迟清理流程。

### 17.3 MinIO 验证

- MinIO 健康状态：Docker Compose `minio` 为 healthy，`GET /minio/health/live` 返回 200；9000/9001 均已映射。
- 工作对象读取成功率：迁移对象 16/16 可读取。
- 文件大小校验：迁移对象 16/16 通过。
- SHA-256 校验：16/16 已回填；失败数 0。
- 图片预览：夏季投放资料包主缩略图返回 `200 image/png`，实测 2,732,061 字节。
- Word/PDF 下载字节一致性：Word 实测 14,597 字节，文件头 `504B0304`，SHA-256 为 `12553580d0cb427e2a44b111ad05b339e8d4a13d6c68ac73db0c1200ff379435`，Content-Type 与 UTF-8 下载文件名正确；当前数据没有 PDF 样本。
- 视频 Range：当前数据没有视频 FileObject 样本；MinIO 与 LocalStorage Adapter 的严格 Range 单元回归通过。
- 延迟清理任务：真实删除联调产品后产生 1 个 ORPHANED FileObject 和 1 条清理任务，`nextAttemptAt` 为删除时间后 24 小时。
- 跨项目访问：使用另一项目读取同一 FileObject 返回 404。

### 17.4 测试与构建

| 命令或测试集      | 结果 | 备注                                                         |
| ----------------- | ---- | ------------------------------------------------------------ |
| Prisma 迁移验证   | 通过 | 本地 PostgreSQL 共识别 15 个迁移，本轮 2 个纠偏迁移已 deploy |
| API 单元/集成测试 | 通过 | 24 个测试文件、118 项测试全部通过                            |
| Worker 测试       | 通过 | 14 项通过，3 项需要外部 Ark 环境的集成测试按条件跳过         |
| Web 测试          | 通过 | 18 个测试文件、88 项测试全部通过                             |
| 类型检查          | 通过 | Contracts、UI、API、Web 全部通过                             |
| API 生产构建      | 通过 | NestJS build 成功                                            |
| Web 生产构建      | 通过 | Vue typecheck 与 Vite production build 成功                  |
| `pnpm check`      | 通过 | lint、format、typecheck、test、build 全链路成功              |

### 17.5 真实验收

- 验收项目：夏季投放（`443dec1d-a3b5-4035-b070-ccdd75feab5e`）。
- 三张素材聚合为一个资料包：通过；`source-package:a8c019ac-a7ca-4f69-b368-4e128991694c` 一张资料包卡、3 个 FileObject 明细、主缩略图可读。
- 资料包 revision 独立且正确：通过；迁移后为 revision 1，不再显示 NodeState revision 8。
- 视频配置 revision 独立且详情正确：通过；`effective-video-config:a8c019ac-a7ca-4f69-b368-4e128991694c` 保留 revision 1，数据含义为全局草稿与产品 override 合并后的产品有效配置。
- 上游变化触发 STALE：递归传播单元测试通过，更新只修改 freshness，不增加下游 revision；当前验收库没有已完成洞察可做破坏性实测。
- 普通退出不创建 ProjectAsset：退出改为暂停 WorkflowRun；迁移与联调期间正式 Asset/AssetVersion 数量保持 14/15。
- 项目隔离和跨项目 404：通过。
- 批量上传协议：真实完成创建会话、上传、complete 和相同幂等键重放；首次完成 Draft 从 revision 9 增至 10，重放返回 `unchanged=true`，资料包保持同一 ID 与 revision 1。
- 遗留问题：当前样本库没有 PDF、视频 FileObject 和历史完成态营销洞察，因此这三项仅完成接口/单元回归，未做真实文件或旧洞察迁移验收；最终归档、ProjectAsset 新版本与 GlobalAsset 发布仍明确不在本次范围。

### 17.6 2026-08-24 语义纠偏执行结果

- NodeState 与执行输入已解耦：`WorkflowNodeState.revision` 只用于草稿 CAS，新增后端计算的 `executionInputHash` 与 schema version。当前效果类提炼节点只使用版本化默认输入，全部 UI 状态和结果编辑草稿均被排除。
- AI 任务快照已收敛为资料包 revision、产品有效配置 revision 和 `executionInputHash`。`sourceFingerprint` 不再包含 Draft/NodeState revision、时间戳和随机 storageKey。旧任务或旧依赖的迟到结果不能覆盖较新 WorkingArtifact。
- 上传语义已固定：单文件上传只产生 FileObject，前端保留稳定 `completionKey` 并自动 complete；complete 只提交 Material/FileObject 草稿关系，不再更新资料包 WorkingArtifact。
- 配置 key 迁移已完成：迁移前冲突数 0，16 条 `global-video-config` 原位更名为 `effective-video-config`；迁移后旧 key 0、新 key 16。
- 软删除已接通：产品进入 `REMOVED`，上游副本进入 `PENDING_DELETE`，下游进入 `SOURCE_REMOVED/STALE`；提供最近删除、单项/批量恢复和 API 启动后周期清理。测试确认删除时不直接删 MinIO，存在 hold/业务引用时周期清理不执行对象删除。
- 数据库同轮次防线已启用：迁移 dry-run 的跨 workflowRun 错误关联数为 0；7 类核心组合外键已建立。在事务中故意使用错误 workflowRunId 写入 WorkingArtifactFile 时，PostgreSQL 返回外键拒绝，事务已回滚。
- 运行验收：API `/api/health` 返回 `ok`，MinIO live health 返回 200；项目工作副本接口返回 effective key 且旧 key 为 0。Word FileObject 返回 200、DOCX 正确 MIME、14,597 字节、`504B0304` 文件头和上传时相同 SHA-256；跨项目读取返回 404。
- 为保护真实业务数据，本轮没有对已有用户产品执行不可见的“等待 24 小时后物理删除”破坏性实测；到期、hold 阻断和无引用删除语义由仓储/周期处理器测试验收。

### 17.7 2026-08-24 完成校验后提交整改

- WorkflowWorking 公共写入边界已收敛为批量校验提交；资料上传、重传、删除、清单 complete、配置编辑、AI 生成和人工编辑路径不再直接 upsert WorkingArtifact。
- 资料导入新增产品级完成校验，同一事务提交 `source-package:{productId}` 和 `effective-video-config:{productId}`；多产品可逐项校验，全部 ACTIVE 产品候选 hash 与已提交基线一致后才允许下一步。
- AI 生成只写 `EffectExtractionResult` 并刷新 NodeState 基线；人工编辑只保存结果表和 NodeState。显式校验会重新核对资料包 revision、有效视频配置 revision 和 executionInputHash，然后才提交 `marketing-insight:{productId}`。
- 相同规范化 contentHash 的重复校验直接返回 `unchanged=true`，不写入记录、不增加 revision、不改变 updatedAt、不传播 STALE；只有 hash 变化才原位更新并递归标记下游。
- 未校验的素材重传或删除不会立即破坏旧工作副本引用；校验提交切换文件关系后，仅将无 Material、WorkingArtifactFile 和 UploadSessionItem 引用的旧 FileObject 标记为 ORPHANED，由 24 小时延迟清理处理。
- 本轮验收：`pnpm check` 全链路通过；Contracts 9 项、API 118 项、Web 89 项全部通过，API/Web 生产构建通过。Worker pytest 为 14 项通过、3 项外部环境集成测试按条件跳过，mypy 通过。`docker compose config --quiet` 通过，MinIO 容器 healthy 且 live health 返回 200。

## 18. 实施默认值

- 更新后的 `docs/项目、工作流草稿与资产管理通俗说明.md` 是本次业务语义的唯一权威来源。
- 产品资料包是聚合 WorkingArtifact，实际文件由 FileObject 独立管理。
- 工作流全局配置仍保存在 Draft；WorkingArtifact 按产品维护合并后的最终生效配置。
- 文件延迟清理宽限期默认为 24 小时，可通过非敏感环境变量调整。
- 普通退出将工作轮次暂停或保留为活动状态，但绝不归档。
- 现有正式资产和正式 MinIO 对象不在本次修改范围。
- 实施时必须保留工作区中与本任务无关的未提交修改。
