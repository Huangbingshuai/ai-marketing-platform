# 项目与资产 V4 API 契约

所有路由统一位于 `/api` 下，除文件内容流外均由全局拦截器包装为
`ApiResponse<T>`。共享字段、枚举和响应类型以 `packages/contracts/src/asset.ts`
为唯一来源。

## 项目

| 方法   | 路径                   | 请求                              | 响应数据                  |
| ------ | ---------------------- | --------------------------------- | ------------------------- |
| `GET`  | `/projects`            | `keyword?`、`workflow?`、`space?` | `Project[]`，更新时间倒序 |
| `POST` | `/projects`            | `CreateProjectRequest`            | `Project`                 |
| `GET`  | `/projects/:projectId` | -                                 | `Project`                 |

项目列表的 `workflowSpaces` 和 `assetCounts` 由当前未归档资产计算。

## 资产查询与维护

| 方法    | 路径                                           | 请求                                                                                              | 响应数据           |
| ------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------ |
| `GET`   | `/projects/:projectId/assets`                  | `keyword?`、`directory?`、`type?`、`tag?`、`workflow?`、`space?`、`status?`、`page?`、`pageSize?` | `AssetListData`    |
| `GET`   | `/projects/:projectId/assets/:assetId`         | -                                                                                                 | `Asset`            |
| `PATCH` | `/projects/:projectId/assets/:assetId`         | `UpdateAssetRequest`                                                                              | `Asset`            |
| `POST`  | `/projects/:projectId/assets/:assetId/archive` | -                                                                                                 | `ArchiveAssetData` |
| `GET`   | `/projects/:projectId/assets/:assetId/content` | `download?`，可带 Range                                                                           | 原文件流           |

列表按 `updatedAt DESC, id DESC` 稳定排序。传入分页字段时返回分页元数据；
`pageSize` 最大 96。facets 基于当前项目、当前工作流和当前二级空间的全部未归档
资产计算，不受关键词、目录、类型、标签和状态筛选影响。

## 上传、版本与跨项目快照

| 方法   | 路径                                                  | 请求                                                             | 响应数据         |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------- | ---------------- |
| `POST` | `/projects/:projectId/assets`                         | Multipart：`file`、`name`、`directory`、`type`、`tags`、`notes?` | `Asset`          |
| `POST` | `/projects/:projectId/assets/imports`                 | Multipart：`files`、`workflow`、`space`、`type`                  | `Asset[]`        |
| `GET`  | `/projects/:projectId/assets/:assetId/versions`       | -                                                                | `AssetVersion[]` |
| `POST` | `/projects/:projectId/assets/:assetId/versions`       | `CreateAssetVersionRequest`                                      | `Asset`          |
| `POST` | `/projects/:targetProjectId/assets/import-snapshot`   | `ImportAssetSnapshotRequest`                                     | `Asset`          |
| `POST` | `/projects/:projectId/assets/:assetId/upgrade-source` | -                                                                | 更新后的 `Asset` |

多文件上传的服务端幂等键固定为
`workflow|space|type|safeOriginalFileName|sizeBytes`，唯一约束额外包含
`projectId + workflow + space`。相同键再次上传时创建新版本，不创建重复资产。

跨项目复用只创建复制快照：目标项目获得新资产 ID，保存
`sourceProjectId/sourceAssetId/sourceVersion/importedAt`。来源升级后，响应中的
`sourceCurrentVersion` 和 `outdated` 用于提示显式升级；不会自动替换目标快照。

## 批量与工作流正式入库

| 方法   | 路径                                          | 请求                        | 响应数据             |
| ------ | --------------------------------------------- | --------------------------- | -------------------- |
| `POST` | `/projects/:projectId/assets/batch-tags`      | `BatchTagAssetsRequest`     | `BatchAssetResult`   |
| `POST` | `/projects/:projectId/assets/batch-archive`   | `BatchArchiveAssetsRequest` | `BatchAssetResult`   |
| `POST` | `/projects/:projectId/assets/store-artifacts` | `StoreArtifactsRequest`     | `StoreArtifactsData` |

工作流产物只有调用 `store-artifacts` 后才成为正式资产。幂等键在
`projectId + workflow + space` 内唯一；相同产物再次入库会创建资产新版本。

## 隔离与存储

- Repository 的所有资产方法第一个参数都是 `projectId`。
- 详情、版本、编辑、归档、批量操作和内容流均同时约束 `projectId` 与资产 ID。
- 已归档、跨项目和不存在统一表现为 `404 ASSET_NOT_FOUND`。
- 跨项目快照读取来源时必须显式携带 `sourceProjectId`，禁止仅按资产 ID 查询。
- 数据库仅保存 `storageKey`，文件内容由 `StoragePort` 保存；本地开发适配器目录为
  `.local-storage/assets`。
