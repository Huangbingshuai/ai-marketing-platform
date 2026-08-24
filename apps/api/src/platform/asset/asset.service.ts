import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';

import {
  ASSET_DIRECTORIES,
  ASSET_DIRECTORY_LABELS,
  ASSET_DIRECTORY_TYPES,
  ASSET_TYPES,
  ASSET_TYPE_LABELS,
  ASSET_STATUSES,
  ASSET_STATUS_LABELS,
  type ArchiveAssetData,
  type Asset,
  type AssetDirectory,
  type AssetListData,
  type AssetListFacets,
  type AssetListQuery,
  type AssetPreviewKind,
  type AssetType,
  type AssetStatus,
  type AssetVersion,
  type AssetWorkflow,
  type AssetWorkflowSpace,
  type BatchAssetResult,
  type CreateAssetVersionRequest,
  type CreateAssetMetadata,
  type ImportAssetSnapshotRequest,
  type StoreArtifactsData,
  type StoreArtifactsRequest,
  type StoreArtifactInput,
  type UpdateAssetRequest,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Asset as AssetRecord } from '../../generated/prisma/client';

import { ApiHttpException } from '../../common/api-http-exception';
import { normalizeMultipartFileName, safeOriginalFileName } from '../file/file-name';
import type { StoragePort, StorageRange, StoredStream } from '../file/storage.port';
import { STORAGE_PORT } from '../file/storage.port';
import { ProjectService } from '../project/project.service';
import { AssetRepository } from './asset.repository';

export type UploadedAssetFile = {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
};

export type AssetContent = StoredStream & {
  mimeType: string;
  originalFileName: string;
  previewKind: AssetPreviewKind;
  partial: boolean;
};

/** Internal platform boundary for promoting a staged workflow file into an Asset. */
export type StoreWorkflowFileInput = {
  name: string;
  directory: AssetDirectory;
  type: AssetType;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  sourceStorageKey: string;
  workflow: AssetWorkflow;
  space: AssetWorkflowSpace;
  idempotencyKey: string;
  tags?: string[];
  notes?: string | null;
  businessData?: unknown;
  sourceArtifactId?: string | null;
  sourceNode?: string | null;
  operationKey?: string;
};

export type StoredWorkflowAsset = {
  asset: Asset;
  assetVersionId: string;
  version: number;
  replacedStorageKey?: string;
};

type StoredWorkflowFileResult = {
  asset: Asset;
  replacedStorageKey?: string;
};

export class AssetRangeNotSatisfiableError extends ApiHttpException {
  constructor(readonly sizeBytes: number) {
    super('请求的文件范围无效', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE, 'VALIDATION_ERROR');
  }
}

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);
const AUDIO_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/aac',
  'audio/flac',
]);
const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
]);

export const previewKindForMimeType = (mimeType: string): AssetPreviewKind => {
  const normalized = mimeType.toLowerCase();
  if (IMAGE_MIME_TYPES.has(normalized)) return 'IMAGE';
  if (AUDIO_MIME_TYPES.has(normalized)) return 'AUDIO';
  if (VIDEO_MIME_TYPES.has(normalized)) return 'VIDEO';
  return 'DOWNLOAD';
};

const assetNotFound = (): ApiHttpException =>
  new ApiHttpException('资产不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');

const validationError = (message: string): ApiHttpException =>
  new ApiHttpException(message, HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');

const normalizeTags = (tags: unknown): string[] => {
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw validationError('标签必须是字符串数组');
  }
  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  if (normalized.length > 20) throw validationError('标签不能超过 20 个');
  if (normalized.some((tag) => tag.length > 40)) throw validationError('每个标签最多 40 个字符');
  return normalized;
};

const assertDirectoryType = (directory: AssetDirectory, type: AssetType): void => {
  const allowed = ASSET_DIRECTORY_TYPES[directory] as readonly AssetType[] | undefined;
  if (!allowed?.includes(type)) throw validationError('资产目录与类型不匹配');
};

const workflowForSpace = (space: AssetWorkflowSpace): AssetWorkflow =>
  space === 'EFFECT' ? 'EFFECT' : space.startsWith('CUSTOMIZED_') ? 'CUSTOMIZED' : 'FISSION';

const assertWorkflowSpace = (workflow: AssetWorkflow, space: AssetWorkflowSpace): void => {
  if (workflowForSpace(space) !== workflow) throw validationError('资产工作流与空间不匹配');
};

const normalizeName = (name: string): string => {
  const normalized = name.trim();
  if (normalized.length < 1 || normalized.length > 120) {
    throw validationError('资产名称长度必须为 1 到 120 个字符');
  }
  return normalized;
};

const normalizeNotes = (notes: string | null | undefined): string | null => {
  if (notes === null || notes === undefined) return null;
  const normalized = notes.trim();
  if (normalized.length > 2000) throw validationError('备注最多 2000 个字符');
  return normalized === '' ? null : normalized;
};

const storageProductContext = (value: unknown): { productId?: string; productName?: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const data = value as Record<string, unknown>;
  return {
    ...(typeof data.productId === 'string' && data.productId.trim()
      ? { productId: data.productId }
      : {}),
    ...(typeof data.productName === 'string' && data.productName.trim()
      ? { productName: data.productName }
      : {}),
  };
};

const safeMimeType = (mimeType: string): string => {
  const normalized = mimeType.toLowerCase().trim();
  return (
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
      ? normalized
      : 'application/octet-stream'
  ).slice(0, 120);
};

const toAsset = (record: AssetRecord, sourceCurrentVersion: number | null = null): Asset => {
  const contentPath = `/api/projects/${encodeURIComponent(record.projectId)}/assets/${encodeURIComponent(record.id)}/content`;
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.hasFile ? normalizeMultipartFileName(record.name) : record.name,
    directory: record.directory,
    type: record.type,
    tags: record.tags,
    notes: record.notes,
    originalFileName: safeOriginalFileName(record.originalFileName),
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    hasFile: record.hasFile,
    previewKind: previewKindForMimeType(record.mimeType),
    contentUrl: contentPath,
    downloadUrl: `${contentPath}?download=true`,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    storageWorkflow: record.storageWorkflow,
    workflowSpace: record.workflowSpace,
    status: record.status,
    qualityStatus: record.qualityStatus,
    currentVersion: record.currentVersion,
    assetClass: record.assetClass,
    businessType: record.businessType,
    contentKind: record.contentKind,
    content: record.content,
    businessData: record.businessData,
    views: record.views,
    sourceArtifactId: record.sourceArtifactId,
    sourceRunId: record.sourceRunId,
    sourceNode: record.sourceNode,
    sourceShot: record.sourceShot,
    sourceProjectId: record.sourceProjectId,
    sourceAssetId: record.sourceAssetId,
    sourceVersion: record.sourceVersion,
    importedAt: record.importedAt?.toISOString() ?? null,
    dependencies: Array.isArray(record.dependencies)
      ? (record.dependencies as NonNullable<Asset['dependencies']>)
      : [],
    isSnapshot: record.sourceAssetId !== null,
    readOnly: record.sourceAssetId !== null,
    sourceCurrentVersion,
    outdated: sourceCurrentVersion !== null && (record.sourceVersion ?? 0) < sourceCurrentVersion,
  };
};

const buildFacets = (
  records: Pick<AssetRecord, 'directory' | 'type' | 'status' | 'tags' | 'businessData'>[],
): AssetListFacets => {
  const directoryCounts = new Map<AssetDirectory, number>();
  const typeCounts = new Map<AssetType, number>();
  const tagCounts = new Map<string, number>();
  const statusCounts = new Map<AssetStatus, number>();
  const productCounts = new Map<string, { label: string; count: number }>();
  for (const record of records) {
    directoryCounts.set(record.directory, (directoryCounts.get(record.directory) ?? 0) + 1);
    typeCounts.set(record.type, (typeCounts.get(record.type) ?? 0) + 1);
    statusCounts.set(record.status, (statusCounts.get(record.status) ?? 0) + 1);
    for (const tag of record.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    if (
      record.businessData &&
      typeof record.businessData === 'object' &&
      !Array.isArray(record.businessData)
    ) {
      const productId = Reflect.get(record.businessData, 'productId');
      const productName = Reflect.get(record.businessData, 'productName');
      if (
        typeof productId === 'string' &&
        productId.trim() &&
        typeof productName === 'string' &&
        productName.trim()
      ) {
        const current = productCounts.get(productId);
        productCounts.set(productId, {
          label: productName.trim(),
          count: (current?.count ?? 0) + 1,
        });
      }
    }
  }
  return {
    directories: ASSET_DIRECTORIES.filter((value) => directoryCounts.has(value)).map((value) => ({
      value,
      label: ASSET_DIRECTORY_LABELS[value],
      count: directoryCounts.get(value) ?? 0,
    })),
    types: ASSET_TYPES.filter((value) => typeCounts.has(value)).map((value) => ({
      value,
      label: ASSET_TYPE_LABELS[value],
      count: typeCounts.get(value) ?? 0,
    })),
    statuses: ASSET_STATUSES.filter((value) => statusCounts.has(value)).map((value) => ({
      value,
      label: ASSET_STATUS_LABELS[value],
      count: statusCounts.get(value) ?? 0,
    })),
    tags: [...tagCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
      .map(([value, count]) => ({ value, count })),
    products: [...productCounts.entries()]
      .sort(([, left], [, right]) => left.label.localeCompare(right.label, 'zh-CN'))
      .map(([value, product]) => ({ value, label: product.label, count: product.count })),
  };
};

export const parseRangeHeader = (
  header: string | undefined,
  sizeBytes: number,
): StorageRange | undefined => {
  if (!header) return undefined;
  if (!header.startsWith('bytes=') || header.includes(',')) {
    throw new AssetRangeNotSatisfiableError(sizeBytes);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) throw new AssetRangeNotSatisfiableError(sizeBytes);
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') throw new AssetRangeNotSatisfiableError(sizeBytes);

  let start: number;
  let end: number;
  if (startText === '') {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
      throw new AssetRangeNotSatisfiableError(sizeBytes);
    }
    start = Math.max(0, sizeBytes - suffixLength);
    end = sizeBytes - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? sizeBytes - 1 : Math.min(Number(endText), sizeBytes - 1);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= sizeBytes ||
    end < start
  ) {
    throw new AssetRangeNotSatisfiableError(sizeBytes);
  }
  return { start, end };
};

@Injectable()
export class AssetService {
  private readonly maxUploadBytes: number;

  constructor(
    @Inject(AssetRepository) private readonly repository: AssetRepository,
    @Inject(ProjectService) private readonly projectService: ProjectService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.maxUploadBytes = config.getOrThrow<number>('MAX_UPLOAD_BYTES');
  }

  private async assertProject(projectId: string): Promise<void> {
    if (!(await this.projectService.exists(projectId))) {
      throw new ApiHttpException('项目不存在', HttpStatus.NOT_FOUND, 'PROJECT_NOT_FOUND');
    }
  }

  private async present(record: AssetRecord): Promise<Asset> {
    if (!record.sourceProjectId || !record.sourceAssetId) return toAsset(record);
    const source = await this.repository.find(record.sourceProjectId, record.sourceAssetId);
    return toAsset(record, source?.currentVersion ?? null);
  }

  async list(projectId: string, filters: AssetListQuery): Promise<AssetListData> {
    await this.assertProject(projectId);
    const paged = filters.page !== undefined || filters.pageSize !== undefined;
    const facetScope = {
      ...(filters.workflow ? { workflow: filters.workflow } : {}),
      ...(filters.space ? { space: filters.space } : {}),
    };
    const [items, facetRecords, total] = await Promise.all([
      this.repository.list(projectId, filters),
      this.repository.listForFacets(projectId, facetScope),
      paged ? this.repository.count(projectId, filters) : Promise.resolve(-1),
    ]);
    const resolvedTotal = paged ? total : items.length;
    const page = Math.max(1, filters.page ?? 1),
      pageSize = Math.min(96, Math.max(1, filters.pageSize ?? 24));
    return {
      items: await Promise.all(items.map((item) => this.present(item))),
      total: resolvedTotal,
      facets: buildFacets(facetRecords),
      ...(paged
        ? {
            pagination: {
              page,
              pageSize,
              pageCount: Math.max(1, Math.ceil(resolvedTotal / pageSize)),
            },
          }
        : {}),
    };
  }

  async import(
    projectId: string,
    metadata: Omit<CreateAssetMetadata, 'tags'> & { tags: unknown },
    file: UploadedAssetFile | undefined,
  ): Promise<Asset> {
    if (!file)
      throw new ApiHttpException('请选择要导入的文件', HttpStatus.BAD_REQUEST, 'FILE_REQUIRED');
    try {
      if (file.size < 1)
        throw new ApiHttpException('文件不能为空', HttpStatus.BAD_REQUEST, 'FILE_REQUIRED');
      if (file.size > this.maxUploadBytes) {
        throw new ApiHttpException(
          '文件大小超过上传限制',
          HttpStatus.PAYLOAD_TOO_LARGE,
          'FILE_TOO_LARGE',
        );
      }
      const project = await this.projectService.get(projectId);
      assertWorkflowSpace(metadata.storageWorkflow ?? 'EFFECT', metadata.workflowSpace ?? 'EFFECT');
      assertDirectoryType(metadata.directory, metadata.type);
      const normalized = {
        name: normalizeName(metadata.name),
        directory: metadata.directory,
        type: metadata.type,
        tags: normalizeTags(metadata.tags),
        notes: normalizeNotes(metadata.notes),
        originalFileName: safeOriginalFileName(file.originalname),
        mimeType: safeMimeType(file.mimetype),
        sizeBytes: file.size,
      };

      let stored;
      try {
        stored = await this.storage.put({
          projectId,
          stream: createReadStream(file.path),
          sizeBytes: file.size,
          contentType: normalized.mimeType,
          keyContext: {
            projectName: project.name,
            workflow: metadata.storageWorkflow ?? 'EFFECT',
            lifecycle: 'assets',
            category: ASSET_TYPE_LABELS[metadata.type],
            originalFileName: normalized.originalFileName,
          },
        });
      } catch {
        throw new ApiHttpException(
          '文件保存失败',
          HttpStatus.INTERNAL_SERVER_ERROR,
          'STORAGE_WRITE_FAILED',
        );
      }

      try {
        return this.present(
          await this.repository.create(projectId, {
            ...normalized,
            storageKey: stored.key,
            storageWorkflow: metadata.storageWorkflow ?? 'EFFECT',
            workflowSpace: metadata.workflowSpace ?? 'EFFECT',
          }),
        );
      } catch (error) {
        await this.storage.delete(stored.key).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  async get(projectId: string, assetId: string): Promise<Asset> {
    const record = await this.repository.find(projectId, assetId);
    if (!record) throw assetNotFound();
    return this.present(record);
  }

  async update(projectId: string, assetId: string, input: UpdateAssetRequest): Promise<Asset> {
    if (Object.keys(input).length === 0) throw validationError('至少提供一个要修改的字段');
    const current = await this.repository.find(projectId, assetId);
    if (!current) throw assetNotFound();
    const directory = input.directory ?? current.directory;
    const type = input.type ?? current.type;
    assertDirectoryType(directory, type);
    const record = await this.repository.update(projectId, assetId, {
      name: input.name === undefined ? current.name : normalizeName(input.name),
      directory,
      type,
      tags: input.tags === undefined ? current.tags : normalizeTags(input.tags),
      notes: input.notes === undefined ? current.notes : normalizeNotes(input.notes),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.qualityStatus === undefined ? {} : { qualityStatus: input.qualityStatus }),
    });
    if (!record) throw assetNotFound();
    return this.present(record);
  }

  async archive(projectId: string, assetId: string): Promise<ArchiveAssetData> {
    const archivedAt = await this.repository.archive(projectId, assetId);
    if (!archivedAt) throw assetNotFound();
    return { id: assetId, archivedAt: archivedAt.toISOString() };
  }

  async content(projectId: string, assetId: string, rangeHeader?: string): Promise<AssetContent> {
    const record = await this.repository.find(projectId, assetId);
    if (!record) throw assetNotFound();
    if (!record.hasFile) throw assetNotFound();
    const previewKind = previewKindForMimeType(record.mimeType);
    const supportsRange = previewKind === 'AUDIO' || previewKind === 'VIDEO';
    const range = supportsRange ? parseRangeHeader(rangeHeader, record.sizeBytes) : undefined;
    const stored = await this.storage.open(record.storageKey, range);
    return {
      ...stored,
      mimeType: record.mimeType,
      originalFileName: safeOriginalFileName(record.originalFileName),
      previewKind,
      partial: range !== undefined,
    };
  }

  async importMany(
    projectId: string,
    metadata: { workflow: AssetWorkflow; space: AssetWorkflowSpace; type: AssetType },
    files: UploadedAssetFile[],
  ): Promise<Asset[]> {
    if (!files.length)
      throw new ApiHttpException('请选择要导入的文件', HttpStatus.BAD_REQUEST, 'FILE_REQUIRED');
    const project = await this.projectService.get(projectId);
    assertWorkflowSpace(metadata.workflow, metadata.space);
    const directory = ASSET_DIRECTORIES.find((value) =>
      (ASSET_DIRECTORY_TYPES[value] as readonly AssetType[]).includes(metadata.type),
    );
    if (!directory) throw validationError('无法确定资产类型对应目录');
    const results: Asset[] = [];
    for (const file of files) {
      try {
        if (file.size < 1)
          throw new ApiHttpException('文件不能为空', HttpStatus.BAD_REQUEST, 'FILE_REQUIRED');
        if (file.size > this.maxUploadBytes)
          throw new ApiHttpException(
            '文件大小超过上传限制',
            HttpStatus.PAYLOAD_TOO_LARGE,
            'FILE_TOO_LARGE',
          );
        const originalFileName = safeOriginalFileName(file.originalname),
          mimeType = safeMimeType(file.mimetype);
        const idempotencyKey = [
          metadata.workflow,
          metadata.space,
          metadata.type,
          originalFileName,
          file.size,
        ].join('|');
        const existing = await this.repository.findByIdempotency(
          projectId,
          metadata.workflow,
          metadata.space,
          idempotencyKey,
        );
        let stored;
        try {
          stored = await this.storage.put({
            projectId,
            stream: createReadStream(file.path),
            sizeBytes: file.size,
            contentType: mimeType,
            keyContext: {
              projectName: project.name,
              workflow: metadata.workflow,
              lifecycle: 'assets',
              category: ASSET_TYPE_LABELS[metadata.type],
              originalFileName,
            },
          });
        } catch {
          throw new ApiHttpException(
            '文件保存失败',
            HttpStatus.INTERNAL_SERVER_ERROR,
            'STORAGE_WRITE_FAILED',
          );
        }
        try {
          const record = existing
            ? await this.repository.createFileVersion(projectId, existing.id, {
                originalFileName,
                mimeType,
                sizeBytes: file.size,
                storageKey: stored.key,
              })
            : await this.repository.create(
                projectId,
                {
                  name: originalFileName,
                  directory,
                  type: metadata.type,
                  tags: [ASSET_TYPE_LABELS[metadata.type]],
                  notes: null,
                  originalFileName,
                  mimeType,
                  sizeBytes: file.size,
                  storageKey: stored.key,
                  storageWorkflow: metadata.workflow,
                  workflowSpace: metadata.space,
                  status: 'PENDING_REVIEW',
                  qualityStatus: 'PENDING_REVIEW',
                  idempotencyKey,
                },
                `上传 ${originalFileName}`,
              );
          if (!record) throw assetNotFound();
          results.push(await this.present(record));
        } catch (error) {
          await this.storage.delete(stored.key).catch(() => undefined);
          throw error;
        }
      } finally {
        await rm(file.path, { force: true }).catch(() => undefined);
      }
    }
    return results;
  }

  async listVersions(projectId: string, assetId: string): Promise<AssetVersion[]> {
    if (!(await this.repository.find(projectId, assetId))) throw assetNotFound();
    return (await this.repository.listVersions(projectId, assetId)).map((version) => ({
      id: version.id,
      projectId: version.projectId,
      assetId: version.assetId,
      version: version.version,
      changeNote: version.changeNote,
      status: version.status,
      qualityStatus: version.qualityStatus,
      content: version.content,
      businessData: version.businessData,
      originalFileName: safeOriginalFileName(version.originalFileName),
      mimeType: version.mimeType,
      sizeBytes: version.sizeBytes,
      createdAt: version.createdAt.toISOString(),
    }));
  }

  async createVersion(
    projectId: string,
    assetId: string,
    input: CreateAssetVersionRequest,
  ): Promise<Asset> {
    const note = input.changeNote?.trim();
    if (!note || note.length > 2000)
      throw validationError('版本修改说明长度必须为 1 到 2000 个字符');
    const record = await this.repository.createVersion(projectId, assetId, {
      ...input,
      changeNote: note,
    });
    if (!record) throw assetNotFound();
    return this.present(record);
  }

  async importSnapshot(projectId: string, input: ImportAssetSnapshotRequest): Promise<Asset> {
    await this.assertProject(projectId);
    assertWorkflowSpace(input.targetWorkflow, input.targetSpace);
    if (projectId === input.sourceProjectId) throw validationError('同一项目资产无需复制快照');
    const source = await this.repository.find(input.sourceProjectId, input.sourceAssetId);
    if (!source)
      throw new ApiHttpException('来源资产不存在', HttpStatus.NOT_FOUND, 'SOURCE_ASSET_NOT_FOUND');
    const sourceVersion = input.sourceVersion ?? source.currentVersion;
    const version = await this.repository.findVersion(
      input.sourceProjectId,
      source.id,
      sourceVersion,
    );
    if (!version)
      throw new ApiHttpException(
        '来源资产版本不存在',
        HttpStatus.NOT_FOUND,
        'ASSET_VERSION_NOT_FOUND',
      );
    const copied = await this.repository.create(
      projectId,
      {
        name: source.name,
        directory: source.directory,
        type: source.type,
        tags: [...source.tags],
        notes: source.notes,
        originalFileName: version.originalFileName,
        mimeType: version.mimeType,
        sizeBytes: version.sizeBytes,
        storageKey: version.storageKey,
        hasFile: source.hasFile,
        storageWorkflow: input.targetWorkflow,
        workflowSpace: input.targetSpace,
        status: version.status,
        qualityStatus: version.qualityStatus,
        assetClass: source.assetClass,
        businessType: source.businessType,
        contentKind: source.contentKind,
        content: version.content as never,
        businessData: version.businessData as never,
        views: [...source.views],
        sourceProjectId: input.sourceProjectId,
        sourceAssetId: source.id,
        sourceVersion,
        importedAt: new Date(),
        dependencies: source.dependencies as never,
        sourceNode: input.usageNode ?? source.sourceNode,
      },
      `从 ${input.sourceProjectId}/${source.id} v${sourceVersion} 复制快照`,
    );
    return this.present(copied);
  }

  async upgradeSource(projectId: string, assetId: string): Promise<Asset> {
    const target = await this.repository.find(projectId, assetId);
    if (!target) throw assetNotFound();
    if (!target.sourceProjectId || !target.sourceAssetId)
      throw validationError('该资产不是跨项目快照');
    const source = await this.repository.find(target.sourceProjectId, target.sourceAssetId);
    if (!source)
      throw new ApiHttpException('来源资产不存在', HttpStatus.NOT_FOUND, 'SOURCE_ASSET_NOT_FOUND');
    const updated = await this.repository.upgradeSnapshot(projectId, assetId, source);
    if (!updated) throw assetNotFound();
    return this.present(updated);
  }

  async batchTags(projectId: string, assetIds: string[], tags: unknown): Promise<BatchAssetResult> {
    if (!Array.isArray(assetIds) || !assetIds.length) throw validationError('请选择资产');
    const normalized = normalizeTags(tags);
    const ids = await this.repository.addTags(projectId, [...new Set(assetIds)], normalized);
    return { affected: ids.length, assetIds: ids };
  }

  async batchArchive(projectId: string, assetIds: string[]): Promise<BatchAssetResult> {
    if (!Array.isArray(assetIds) || !assetIds.length) throw validationError('请选择资产');
    const ids = await this.repository.archiveMany(projectId, [...new Set(assetIds)]);
    return { affected: ids.length, assetIds: ids };
  }

  async storeArtifacts(
    projectId: string,
    input: StoreArtifactsRequest,
  ): Promise<StoreArtifactsData> {
    await this.assertProject(projectId);
    assertWorkflowSpace(input.workflow, input.space);
    if (!Array.isArray(input.assets) || !input.assets.length || input.assets.length > 100)
      throw validationError('正式入库资产数量必须为 1 到 100');
    const items: Asset[] = [];
    let created = 0,
      versioned = 0;
    for (const artifact of input.assets) {
      assertDirectoryType(artifact.directory, artifact.type);
      artifact.name = normalizeName(artifact.name);
      artifact.tags = normalizeTags(artifact.tags ?? []);
      const key = artifact.idempotencyKey?.trim();
      if (!key || key.length > 500) throw validationError('幂等键长度必须为 1 到 500 个字符');
      const existing = await this.repository.findByIdempotency(
        projectId,
        input.workflow,
        input.space,
        key,
      );
      const record = existing
        ? await this.repository.createVersion(projectId, existing.id, {
            changeNote: artifact.notes?.trim() || '工作流产物再次入库',
            status: 'PENDING_REVIEW',
            content: artifact.content,
            businessData: artifact.businessData,
          })
        : await this.repository.create(
            projectId,
            this.repository.toArtifactRecord(artifact, input.workflow, input.space),
            artifact.notes?.trim() || '工作流产物正式入库',
          );
      if (!record) throw assetNotFound();
      if (existing) versioned += 1;
      else created += 1;
      items.push(await this.present(record));
    }
    return { items, created, versioned };
  }

  async storeWorkflowFile(
    projectId: string,
    input: StoreWorkflowFileInput,
  ): Promise<StoredWorkflowFileResult> {
    const project = await this.projectService.get(projectId);
    assertWorkflowSpace(input.workflow, input.space);
    assertDirectoryType(input.directory, input.type);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 500) {
      throw validationError('幂等键长度必须为 1 到 500 个字符');
    }
    if (input.operationKey) {
      const completed = await this.repository.findOperation(projectId, input.operationKey);
      if (completed) return { asset: await this.present(completed.asset) };
    }
    const originalFileName = safeOriginalFileName(input.originalFileName);
    const mimeType = safeMimeType(input.mimeType);
    const productContext = storageProductContext(input.businessData);
    const existing = await this.repository.findByIdempotency(
      projectId,
      input.workflow,
      input.space,
      idempotencyKey,
    );
    let source: StoredStream;
    try {
      source = await this.storage.open(input.sourceStorageKey);
    } catch {
      throw new ApiHttpException(
        '工作流暂存文件不存在',
        HttpStatus.CONFLICT,
        'STORAGE_WRITE_FAILED',
      );
    }
    if (source.sizeBytes !== input.sizeBytes) {
      throw new ApiHttpException('工作流暂存文件大小校验失败', HttpStatus.CONFLICT, 'CONFLICT');
    }
    let stored;
    try {
      stored = await this.storage.put({
        projectId,
        stream: source.stream,
        sizeBytes: source.sizeBytes,
        contentType: mimeType,
        keyContext: {
          projectName: project.name,
          workflow: input.workflow,
          lifecycle: 'assets',
          ...productContext,
          category: ASSET_TYPE_LABELS[input.type],
          originalFileName,
        },
      });
    } catch {
      throw new ApiHttpException(
        '工作流文件正式入库失败',
        HttpStatus.INTERNAL_SERVER_ERROR,
        'STORAGE_WRITE_FAILED',
      );
    }
    const recordData = {
      name: normalizeName(input.name),
      directory: input.directory,
      type: input.type,
      tags: normalizeTags(input.tags ?? []),
      notes: normalizeNotes(input.notes),
      originalFileName,
      mimeType,
      sizeBytes: stored.sizeBytes,
      storageKey: stored.key,
      hasFile: true,
      storageWorkflow: input.workflow,
      workflowSpace: input.space,
      status: 'PENDING_REVIEW' as const,
      qualityStatus: 'PENDING_REVIEW' as const,
      idempotencyKey,
      sourceArtifactId: input.sourceArtifactId ?? null,
      sourceNode: input.sourceNode ?? null,
      ...(input.businessData === undefined ? {} : { businessData: input.businessData as never }),
    };
    try {
      const record = existing
        ? await this.repository.createFileVersion(
            projectId,
            existing.id,
            {
              originalFileName,
              mimeType,
              sizeBytes: stored.sizeBytes,
              storageKey: stored.key,
            },
            input.operationKey,
          )
        : await this.repository.create(
            projectId,
            recordData,
            input.notes?.trim() || '工作流文件正式入库',
            input.operationKey,
          );
      if (!record) throw assetNotFound();
      return {
        asset: await this.present(record),
        ...(existing && existing.storageKey !== stored.key
          ? { replacedStorageKey: existing.storageKey }
          : {}),
      };
    } catch (error) {
      await this.storage.delete(stored.key).catch(() => undefined);
      throw error;
    }
  }

  async storeWorkflowFileOperation(
    projectId: string,
    input: StoreWorkflowFileInput & { operationKey: string },
  ): Promise<StoredWorkflowAsset> {
    const stored = await this.storeWorkflowFile(projectId, input);
    const receipt = await this.repository.findOperation(projectId, input.operationKey);
    if (!receipt)
      throw new ApiHttpException(
        '文件入库回执缺失',
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
      );
    return {
      asset: stored.asset,
      assetVersionId: receipt.assetVersionId,
      version: receipt.version,
      ...(stored.replacedStorageKey ? { replacedStorageKey: stored.replacedStorageKey } : {}),
    };
  }

  async storeWorkflowArtifact(
    projectId: string,
    workflow: AssetWorkflow,
    space: AssetWorkflowSpace,
    artifact: StoreArtifactInput,
    operationKey: string,
  ): Promise<StoredWorkflowAsset> {
    await this.assertProject(projectId);
    assertWorkflowSpace(workflow, space);
    assertDirectoryType(artifact.directory, artifact.type);
    const completed = await this.repository.findOperation(projectId, operationKey);
    if (completed) {
      return {
        asset: await this.present(completed.asset),
        assetVersionId: completed.assetVersionId,
        version: completed.version,
      };
    }
    artifact.name = normalizeName(artifact.name);
    artifact.tags = normalizeTags(artifact.tags ?? []);
    const key = artifact.idempotencyKey?.trim();
    if (!key || key.length > 500) throw validationError('幂等键长度必须为 1 到 500 个字符');
    const existing = await this.repository.findByIdempotency(projectId, workflow, space, key);
    const record = existing
      ? await this.repository.createVersion(
          projectId,
          existing.id,
          {
            changeNote: artifact.notes?.trim() || '工作流产物再次入库',
            status: 'PENDING_REVIEW',
            content: artifact.content,
            businessData: artifact.businessData,
          },
          operationKey,
        )
      : await this.repository.create(
          projectId,
          this.repository.toArtifactRecord(artifact, workflow, space),
          artifact.notes?.trim() || '工作流产物正式入库',
          operationKey,
        );
    if (!record) throw assetNotFound();
    const receipt = await this.repository.findOperation(projectId, operationKey);
    if (!receipt)
      throw new ApiHttpException(
        '产物入库回执缺失',
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
      );
    return {
      asset: await this.present(record),
      assetVersionId: receipt.assetVersionId,
      version: receipt.version,
    };
  }
}
