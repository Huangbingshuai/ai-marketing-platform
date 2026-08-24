# 效果类导入素材：MinIO 存储与本地部署方案

## 1. 目标与范围

本方案将效果类工作流第 01 步导入的商品图片和产品文档持久化到本地 MinIO。结构化产品字段、电商链接、草稿配置、文件元数据和 `storageKey` 仍由 PostgreSQL 管理。

本次保持现有调用链路：

```text
Vue 浏览器端
  -> NestJS multipart API
  -> Multer 临时文件与服务端文件签名校验
  -> StoragePort
  -> MinioStorageAdapter
  -> MinIO Bucket
```

浏览器不持有 MinIO 凭据，也不直接访问 Bucket。素材预览和下载继续经过带 `projectId` 校验的 NestJS content API。Multer 临时文件只用于签名校验和清单解析，请求结束后删除，不作为长期业务存储。

以下内容不在本次范围：浏览器预签名直传、生产 MinIO 集群、生产 TOS Adapter、用户权限体系、Prisma 模型调整、前端页面调整及其他工作流节点。

## 2. 原型与工程边界

已检查冻结原型：

- `D:\1Code\ai-marketing-platform\references\prototypes\effect\effect-workflow.html`
  - 参考 Step 01 上传产品资料区域、资料卡和上传状态反馈。
- `D:\1Code\ai-marketing-platform\references\prototypes\integrated\system-integrated-demo.html`
  - 参考系统外壳和项目上下文。

本次不改变原型对应的页面结构和交互。效果类业务仍只依赖 `apps/api/src/platform/file` 暴露的 `StoragePort`，不直接依赖 MinIO SDK。

## 3. MinIO 版本与许可边界

本地环境固定使用 MinIO 社区版安全修复标签：

```text
RELEASE.2025-10-15T17-29-55Z
```

社区版已转为源码分发，因此由项目 Dockerfile 使用 Go 1.24.8 构建二进制，再放入本地运行镜像。MinIO 社区版采用 AGPLv3，本方案只用于本地开发；投入公司生产环境前必须完成许可证评估，或切换到商业 AIStor/TOS。

## 4. 本地服务与配置

Docker Compose 提供：

| 项目     | 值                      |
| -------- | ----------------------- |
| S3 API   | `http://localhost:9000` |
| Console  | `http://localhost:9001` |
| Bucket   | `ai-marketing-assets`   |
| 持久卷   | `minio-data`            |
| 健康检查 | `/minio/health/live`    |

根目录 `.env` 使用以下配置；真实密码不得提交到 Git、测试、Mock 或日志：

```dotenv
STORAGE_DRIVER=minio
LOCAL_STORAGE_ROOT=
MAX_UPLOAD_BYTES=536870912

MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_BUCKET=ai-marketing-assets
MINIO_ACCESS_KEY=<local-only-access-key>
MINIO_SECRET_KEY=<local-only-secret-key>
```

`STORAGE_DRIVER=local` 可回退到原 `LocalStorageAdapter`。只有选择 `minio` 时，MinIO 配置才是必填项。

## 5. 存储行为

### 上传

1. Controller 接收 multipart 文件并落入临时目录。
2. Effect Service 校验扩展名、大小和文件签名。
3. `StoragePort.put` 接收 `projectId`、流、大小、内容类型和用于生成可读键的 `keyContext`。
4. MinIO 对象键使用第 9 节定义的“项目 / 工作流 / 生命周期 / 产品 / 资料类型 / 原文件名”层级。
5. `putObject` 完成后通过 `statObject` 校验实际大小。
6. 大小不一致时删除新对象并返回失败；数据库事务失败时沿用现有补偿删除或持久化清理任务。

### 读取和 Range

- 完整读取使用 `statObject` 和 `getObject`。
- 视频 Range 请求先校验范围，再使用 `getPartialObject(offset, length)`。
- content API 仍从数据库读取可信的 MIME 和原始文件名，不暴露内部 Bucket 地址。

### 删除

`removeObject` 保持幂等语义。对象正在被资产入库快照持有或删除失败时，继续使用现有 `StorageCleanupTask` 延迟清理机制。

### 效果类资料的无版本对象生命周期

- 每条 `EffectImportMaterial` 同一时间只保留一个当前 staging 对象。用户重传时先写入并校验新对象，数据库切换成功后立即删除旧 staging 对象；切换失败则删除新对象并继续使用旧对象。
- 每个效果类 `SOURCE_IMPORT` 文件资产同一时间只保留一个当前正式对象，但每次新的主动保存都必须重新执行 `putObject`，不得复用上一批正式 `storageKey`。
- 新正式对象写入完成后，在数据库事务中物理删除旧资产及兼容快照并创建新资产；数据库成功后删除旧正式对象，失败时删除新对象并保留旧资产和旧对象。即时删除失败写入持久清理任务重试。
- 本链路不使用 MinIO 对象版本功能，也不通过新 UUID 保留业务历史副本。共享数据库模型为兼容其他工作流可保留单条 `version=1` 当前快照，但效果类导入资产不生成、不展示版本时间线。
- 删除旧正式对象前必须确认数据库已经切换到新资产，且旧键不被当前资产、当前草稿、发布快照或文件 hold 引用；任何不确定引用都不得删除。staging 对象不因“保存到项目资产库”删除，仅在用户重传、删除草稿资料或过期清理时删除。

## 6. 旧本地对象迁移与回滚

首次 MinIO 接入迁移只处理 `.local-storage/assets/**` 中仍被数据库引用的对象；可读目录升级还会处理 MinIO 中仍被数据库引用的旧纯 UUID 键。不迁移：

- `.local-storage/tmp/**`
- QA 截图和 Playwright 产物
- 已清理项目的暂存对象

迁移步骤：

1. 启动并确认 MinIO 健康。
2. 确认 `ai-marketing-assets` Bucket 已创建。
3. 先执行 `pnpm --filter @ai-marketing/api storage:migrate-readable` 预览映射，不修改数据。
4. 执行 `pnpm --filter @ai-marketing/api storage:migrate-readable -- --apply`：同 Bucket 复制旧 MinIO 对象；仅存在于 `.local-storage` 的历史对象直接流式上传到新键。
5. 对每个新对象执行 `statObject` 并核对大小；全部成功后在数据库事务中更新 Asset、AssetVersion、Material、Manifest、Hold、CleanupTask 和发布快照引用。
6. 数据库提交后删除旧 MinIO 键；仅由非当前 AssetVersion 引用的旧版本对象同时删除对应历史行和对象。
7. 再次执行预览命令，必须显示待迁移引用为 0、旧目录对象为 0，并完成全部引用对象大小验证。

迁移不会删除 `.local-storage` 原文件。执行前失败会删除本次新复制对象且不切换数据库；数据库提交后若旧键删除失败，新键和业务读取仍有效，可按输出清理旧键。由于数据库已切换为新可读键，回退到 local 前需把保留的本地对象复制到相同新键目录。

### 已有重复正式对象清理

对本功能上线前因反复保存产生的历史副本，按项目和稳定产物幂等键逐项清理：

1. 锁定当前资产记录，并核对当前 `storageKey` 可读且大小正确。
2. 将效果类 `SOURCE_IMPORT` 的历史 `AssetVersion` 折叠为单条 `version=1` 兼容快照，`Asset.currentVersion` 同步重置为 1。
3. 查询数据库、发布快照和文件 hold，确认旧正式键已无引用。
4. 只删除经确认的旧正式对象；保留当前正式对象和当前 staging 对象。
5. 重新统计 Bucket 对象数和字节数，并通过 content API 校验当前对象。

清理只作用于效果类导入节点，不删除其他工作流的版本记录或对象。若数据库折叠失败则不执行对象删除；若对象删除失败则记录到 `StorageCleanupTask` 继续重试。

## 7. 启动、验证与排障

```powershell
docker compose build minio
docker compose up -d minio
docker compose ps minio
pnpm --filter @ai-marketing/api storage:migrate-readable
pnpm --filter @ai-marketing/api storage:migrate-readable -- --apply
pnpm dev:api
```

验证顺序：

1. MinIO 健康检查返回 200。
2. Console 可登录并看到 Bucket。
3. API 启动时完成 Bucket 检查。
4. 从现有效果类导入节点上传图片和产品文档。
5. 数据库产生 `storageKey`，MinIO 中存在同名对象。
6. 页面刷新后仍可预览和下载。
7. 使用其他 `projectId` 读取相同素材时返回未找到。

常见故障：

- API 启动失败：检查 MinIO 健康状态、endpoint、端口和凭据。
- `AccessDenied`：检查 API 与 Compose 使用的 access/secret 是否一致。
- Bucket 不存在：确认当前凭据具有创建 Bucket 权限；本地环境由 Adapter 自动创建。
- 旧素材无法读取：确认对象已按原 `storageKey` 迁移，而不是使用 Windows 反斜杠对象名。
- Word 下载后显示乱码或被识别为无类型文件：先比较源文件、MinIO 下载文件的大小和 SHA-256。若字节一致，检查 content API 是否返回 Word 原始 MIME，并确认 `Content-Disposition` 同时包含带 `.docx` 扩展名的 ASCII `filename` 回退和 UTF-8 `filename*`；禁止只返回无扩展名的 `asset`/`download` 回退名。
- 端口占用：停止占用 9000/9001 的进程后重新启动 Compose；不自动改用其他端口，避免 API 配置与实际端口不一致。

## 8. 验收记录

验收日期：2026-08-21。

- MinIO：使用 Go 1.24.8 从 `RELEASE.2025-10-15T17-29-55Z` 构建成功；Go 解析到的固定源码版本为 `v0.0.0-20251015172955-9e49d5e7a648`。
- 容器：`ai-marketing-platform-minio-1` 已启动，Docker 健康状态为 `healthy`；9000 API 和 9001 Console 均已监听。
- Bucket：API 使用 MinIO 驱动启动成功，并确认 `ai-marketing-assets` 可用。
- 迁移：从 `.local-storage/assets/**` 迁移 1 个有效对象，共 68 bytes；原文件未删除。
- 旧对象读取：原 content API 返回 200 和 68 bytes；使用另一项目 ID 读取返回 404。
- 新上传：通过效果类 multipart API 上传 2,732,061 bytes PNG，数据库生成的对象键符合 `projects/{projectId}/assets/{前缀}/{UUID}`，MinIO `statObject` 返回相同大小，content API 返回 200。
- 清理：端到端测试对象均通过正式删除接口清理，没有遗留额外资料；测试使用的 SINGLE 草稿 revision 从 8 增加到 12。
- 隔离：跨项目读取验证通过，MinIO 凭据未输出，旧本地对象保留用于回滚。
- 质量检查：`pnpm check` 全部通过，包括 ESLint、Prettier、所有工作区类型检查、Contracts 6 项测试、API 67 项测试、Web 63 项测试以及 API/Web 生产构建。
- 进程：原有 3100 端口 API 进程未被终止；验收使用的 3199 临时 API 已关闭，MinIO 容器保持运行。

### 2026-08-21 重复对象专项清理

- “夏季投放”项目清理前共 13 个对象、30,430,849 bytes，其中三张图片各有一份当前 staging、两份历史正式副本和一份当前正式对象。
- 数据库先将效果类 `SOURCE_IMPORT` 资产折叠为单条 `version=1` 兼容快照，并确认 6 个历史键除待删除版本记录外没有 Asset、Material、Manifest 或 Hold 引用。
- 数据库提交后通过 `StorageCleanupTask` 删除 6 个历史正式对象，任务全部成功且队列已清空。
- 清理后共 7 个对象、15,222,723 bytes；三张当前正式图片和对应 staging 图片均保留，另保留一份当前 staging 文档。
- 当前三张正式图片 content API 均返回 `200 image/png`，资产列表保持“全部 4 / 原始资料 3 / 视频配置 1”。

### 2026-08-21 整批重建专项验收

- 连续两次使用不同主动保存幂等键发布同一份 SINGLE 草稿；第二次保存后第一次生成的三个正式对象全部不存在。
- 每次保存都生成三个新的 MinIO 正式键，没有复用相同内容的上一批键。
- 最终项目 MinIO 前缀共 6 个对象、15,208,126 bytes：三张当前 staging 图片和三张最新正式图片。

### 2026-08-21 Word 下载响应修复验收

- 使用已入库的 `广式腊肠资料包.docx` 复现并确认 MinIO 对象本身没有损坏：源文件、暂存 content API 和正式资产 content API 下载结果均为 14,597 bytes，SHA-256 均为 `12553580D0CB427E2A44B111AD05B339E8D4A13D6C68AC73DB0C1200FF379435`。
- 根因是下载响应的 ASCII 文件名回退为无扩展名 `asset`/`download`，正式文档又被统一返回为 `application/octet-stream`；忽略 RFC 5987 `filename*` 的客户端会把文件保存成无扩展名二进制，直接打开时表现为乱码。
- 修复后正式资产下载返回 Word 原始 MIME `application/vnd.openxmlformats-officedocument.wordprocessingml.document`，`Content-Disposition` 为 `attachment; filename="download.docx"; filename*=UTF-8''...`；中文原文件名继续通过 UTF-8 参数保留。
- 下载后的文件与源文件哈希一致，并可作为 ZIP 结构正常读取 11 个 DOCX 条目；API health 为 `ok`，MinIO live 返回 200。

## 9. 可读对象目录规范

MinIO Console 需要同时满足人工查询和系统隔离。新对象键不再采用纯 UUID 目录 `projects/{projectId}/assets/{前缀}/{UUID}`，统一改为：

```text
projects/
  {项目名称}__{projectId前8位}/
    {workflow}/
      01-staging/
        {产品名称}__{productId前8位}/
          {资料类型}/
            {原文件名}__{对象UUID}.{扩展名}
      02-assets/
        {产品名称}__{productId前8位}/
          {资产类型}/
            {原文件名}__{对象UUID}.{扩展名}
      03-manifest/
        未归属产品/
          清单文件/
            {原文件名}__{对象UUID}.{扩展名}
```

示例：

```text
projects/夏季投放__443dec1d/effect/01-staging/广式腊肠__a8c019ac/商品图片/广式腊肠_主图__UUID.png
projects/夏季投放__443dec1d/effect/02-assets/广式腊肠__a8c019ac/原始资料/广式腊肠_主图__UUID.png
```

规则如下：

- 名称用于 Console 可读查询，短 ID 用于同名项目和同名产品消歧；数据库和 API 的权威隔离仍使用完整 `projectId`、`productId` 和 `storageKey`。
- 路径段执行 Unicode NFKC、控制字符和 `/\\:*?"<>|` 清理，并限制单段长度；原文件扩展名始终保留。
- 项目或产品改名不影响旧对象读取；新上传使用新名称。当前本地数据通过一次性迁移统一到现有名称目录，迁移以后不依赖 MinIO 目录推断业务身份。
- 所有写入方必须显式提供项目名称、工作流、生命周期、产品归属、资料类型和原文件名；缺少产品归属时进入 `未归属产品`，不得重新退化为纯 UUID 目录。
- 迁移先同 Bucket copy 到新键并 `statObject` 校验大小，再事务更新所有数据库 `storageKey` 引用，最后删除旧键。任何阶段失败均保留旧对象和旧数据库引用，可安全重试。
- 上一批 Asset、AssetVersion 和 AssetOperationReceipt 已在事务内物理删除；当前四项资产均为新 ID，并各自只有一条 `version=1` 内部兼容快照。
- 持久清理队列为空，最新三张图片 content API 均返回 `200 image/png`。

### 2026-08-21 可读目录迁移验收

- 新写入已统一使用 `StoragePutInput.keyContext` 和同一个对象键生成器；MinIO 与 Local 回退驱动不会产生两套目录结构。
- 24 个仍被数据库引用的对象已迁移到可读目录；其中 1 个只存在于 `.local-storage` 的 68-byte 历史对象已补传到新键。
- 迁移同步更新当前资产、内部兼容快照、工作流素材、清单文件、发布 hold、清理任务和发布快照中的存储引用。
- 3 个仅由非当前 AssetVersion 引用的旧正式对象及对应历史行已删除，符合效果类当前无版本对象生命周期。
- 复核结果：待迁移数据库引用 0、MinIO 旧纯 UUID 目录对象 0、24 个现存数据库引用对象全部通过 `statObject` 大小校验。
- API 回归 16 个测试文件、78 项测试全部通过；API 类型检查和生产构建通过，API health 与 MinIO live 均返回 200。
- 真实 content API 验证：DOCX 返回 14,597 bytes、Word MIME 和带 `.docx` 的下载文件名，SHA-256 保持 `12553580D0CB427E2A44B111AD05B339E8D4A13D6C68AC73DB0C1200FF379435`；PNG 返回 2,357,395 bytes 和 `image/png`；跨项目读取返回 404。
- 全仓 `pnpm check` 的 lint 和格式检查通过，但随后被工作区中独立的“效果类 AI 信息提炼节点”未完成改动阻断：Web 类型检查报告其 Mock 导出与契约字段不一致。本次 MinIO 改动没有修改或覆盖该功能逻辑。
