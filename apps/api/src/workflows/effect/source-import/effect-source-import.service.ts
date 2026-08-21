import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_EFFECT_VIDEO_CONFIG,
  EFFECT_IMPORT_LIMITS,
  EFFECT_MANIFEST_COLUMNS,
  mergeEffectVideoConfig,
  normalizeEffectImportSku,
  type AdvanceEffectImportDraftData,
  type BatchDeleteEffectImportProductsData,
  type BatchRetryEffectImportProductsData,
  type CommitEffectManifestData,
  type EffectImportDeleteData,
  type EffectImportDraft,
  type EffectImportDraftSummary,
  type EffectImportMaterial,
  type EffectImportMaterialMutationData,
  type EffectImportMaterialType,
  type EffectImportMode,
  type EffectImportProduct,
  type EffectImportProductListData,
  type EffectImportProductMutationData,
  type EffectImportPublishedAsset,
  type EffectImportValidationIssue,
  type EffectManifestPreviewRow,
  type GetEffectImportWorkspaceData,
  type PreviewEffectManifestData,
  type PublishEffectImportDraftData,
  type SwitchEffectImportModeData,
  type UpdateEffectImportDraftData,
  type ValidateEffectImportDraftData,
  type ValidateEffectImportLinkData,
  type EffectVideoConfig,
  type EffectVideoConfigOverride,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Prisma } from '../../../generated/prisma/client';

import { ApiHttpException } from '../../../common/api-http-exception';
import { AssetService } from '../../../platform/asset/asset.service';
import type { StoredStream, StoragePort } from '../../../platform/file/storage.port';
import { STORAGE_PORT } from '../../../platform/file/storage.port';
import { ProjectService } from '../../../platform/project/project.service';
import {
  EffectSourceImportRepository,
  type EffectDraftRecord,
  type EffectProductRecord,
  type EffectWorkspaceRecord,
  type ManifestRecord,
  type PublishDraftSnapshot,
} from './effect-source-import.repository';
import { normalizeManifestFileName, parseEffectManifest } from './effect-manifest.parser';

export type UploadedEffectFile = {
  fieldname?: string;
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
};
export type EffectMaterialContent = StoredStream & {
  mimeType: string;
  originalFileName: string;
  partial: boolean;
};

const badRequest = (
  message: string,
  code: 'VALIDATION_ERROR' | 'FILE_REQUIRED' | 'FILE_TOO_LARGE' = 'VALIDATION_ERROR',
) =>
  new ApiHttpException(
    message,
    code === 'FILE_TOO_LARGE' ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST,
    code,
  );
const notFound = () =>
  new ApiHttpException('资料包实体不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
const conflict = () =>
  new ApiHttpException('草稿已被其他操作更新，请刷新后重试', HttpStatus.CONFLICT, 'CONFLICT');
const safeFileName = (value: string): string =>
  (
    [...(value.split(/[\\/]/).at(-1) ?? 'file')]
      .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      })
      .join('')
      .trim() || 'file'
  ).slice(0, 255);
const safeMime = (value: string): string =>
  (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : 'application/octet-stream'
  ).slice(0, 120);
const assetSafeName = (value: string): string => (value.trim() || '未命名资料').slice(0, 120);
const assetSafeTags = (...values: string[]): string[] =>
  [...new Set(values.map((value) => value.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
const createSystemSku = (): string =>
  `SYS-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
const MANIFEST_COMPANION_COUNT_LIMIT = 20;
export const EFFECT_MANIFEST_UPLOAD_TOTAL_BYTES =
  EFFECT_IMPORT_LIMITS.maxReferenceVideoBytes + EFFECT_IMPORT_LIMITS.maxManifestBytes;

const validationIssue = (
  code: EffectImportValidationIssue['code'],
  message: string,
  scope: EffectImportValidationIssue['scope'],
  options: Partial<
    Pick<
      EffectImportValidationIssue,
      'field' | 'productId' | 'materialId' | 'manifestRowNumber' | 'fileName'
    >
  > = {},
): EffectImportValidationIssue => ({
  code,
  severity: 'ERROR',
  scope,
  message,
  field: options.field ?? null,
  productId: options.productId ?? null,
  materialId: options.materialId ?? null,
  manifestRowNumber: options.manifestRowNumber ?? null,
  fileName: options.fileName ?? null,
});

const parseJson = <T>(value: Prisma.JsonValue): T => value as T;

const isValidConfig = (value: unknown): value is EffectVideoConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  const stringFields = [
    'aspectRatio',
    'resolution',
    'subtitleStrategy',
    'voiceoverStrategy',
    'bgmStrategy',
    'styleTone',
    'deliveryChannel',
  ];
  return (
    stringFields.every(
      (field) => typeof config[field] === 'string' && (config[field] as string).trim().length > 0,
    ) &&
    typeof config.durationSeconds === 'number' &&
    Number.isInteger(config.durationSeconds) &&
    config.durationSeconds >= EFFECT_IMPORT_LIMITS.minDurationSeconds &&
    config.durationSeconds <= EFFECT_IMPORT_LIMITS.maxDurationSeconds &&
    typeof config.frameRate === 'number' &&
    Number.isFinite(config.frameRate) &&
    config.frameRate >= EFFECT_IMPORT_LIMITS.minFrameRate &&
    config.frameRate <= EFFECT_IMPORT_LIMITS.maxFrameRate &&
    Array.isArray(config.disabledElements) &&
    config.disabledElements.length <= EFFECT_IMPORT_LIMITS.maxDisabledElements &&
    config.disabledElements.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
};

const normalizedCommerceUrl = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname
    )
      return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

const materialContentUrl = (
  material: { projectId: string; productId: string; id: string },
  mode: EffectImportMode,
): string =>
  `/api/projects/${encodeURIComponent(material.projectId)}/workflows/effect/source-import/drafts/${mode}/products/${encodeURIComponent(material.productId)}/materials/${encodeURIComponent(material.id)}/content`;

@Injectable()
export class EffectSourceImportService {
  constructor(
    @Inject(EffectSourceImportRepository) private readonly repository: EffectSourceImportRepository,
    @Inject(ProjectService) private readonly projectService: ProjectService,
    @Inject(AssetService) private readonly assetService: AssetService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  private async assertProject(projectId: string): Promise<void> {
    if (!(await this.projectService.exists(projectId)))
      throw new ApiHttpException('项目不存在', HttpStatus.NOT_FOUND, 'PROJECT_NOT_FOUND');
  }

  private async deleteOrQueue(
    projectId: string,
    storageKey: string,
    reason: string,
  ): Promise<void> {
    if (await this.repository.isStorageHeld(projectId, storageKey)) {
      await this.repository.enqueueStorageCleanup(projectId, storageKey, reason);
      return;
    }
    try {
      await this.storage.delete(storageKey);
    } catch {
      await this.repository.enqueueStorageCleanup(projectId, storageKey, reason);
    }
  }

  private async drainStorageCleanup(projectId: string): Promise<void> {
    const tasks = await this.repository.storageCleanupTasks(projectId);
    for (const task of tasks) {
      if (await this.repository.isStorageHeld(projectId, task.storageKey)) continue;
      try {
        await this.storage.delete(task.storageKey);
        await this.repository.deleteStorageCleanup(projectId, task.id);
      } catch (error) {
        await this.repository.failStorageCleanup(
          projectId,
          task.id,
          error instanceof Error ? error.message : '存储清理失败',
        );
      }
    }
  }

  private assertMode(value: string): asserts value is EffectImportMode {
    if (value !== 'SINGLE' && value !== 'BATCH') throw badRequest('导入模式无效');
  }

  private material(
    record: EffectProductRecord['materials'][number],
    mode: EffectImportMode,
  ): EffectImportMaterial {
    return {
      id: record.id,
      projectId: record.projectId,
      productId: record.productId,
      type: record.type,
      status: record.status,
      expectedFileName: record.expectedFileName,
      originalFileName: record.originalFileName,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      contentUrl: record.status === 'READY' ? materialContentUrl(record, mode) : null,
      failureDisposition: record.failureDisposition,
      errorCode: record.errorCode,
      errorMessage: record.errorMessage,
      retryCount: record.retryCount,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private product(
    record: EffectProductRecord,
    globalConfig: EffectVideoConfig,
    mode: EffectImportMode,
  ): EffectImportProduct {
    const configOverride = parseJson<EffectVideoConfigOverride>(record.configOverride);
    return {
      id: record.id,
      projectId: record.projectId,
      draftId: record.draftId,
      name: record.name,
      category: record.category,
      sku: record.sku,
      normalizedSku: record.normalizedSku,
      commerceUrl: record.commerceUrl,
      configOverride,
      effectiveConfig: mergeEffectVideoConfig(globalConfig, configOverride),
      sortOrder: record.sortOrder,
      sourceManifestImportId: record.sourceManifestImportId,
      sourceManifestRowNumber: record.sourceManifestRowNumber,
      materials: record.materials.map((item) => this.material(item, mode)),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private summary(record: EffectWorkspaceRecord['drafts'][number]): EffectImportDraftSummary {
    const issues = parseJson<EffectImportValidationIssue[]>(record.validationIssues);
    return {
      id: record.id,
      projectId: record.projectId,
      mode: record.mode,
      status: record.status,
      revision: record.revision,
      validatedRevision: record.validatedRevision,
      productCount: record._count.products,
      issueCount: issues.length,
      completedAt: record.completedAt?.toISOString() ?? null,
      lastPublish: record.lastPublish ? parseJson(record.lastPublish) : null,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private draftValue(record: EffectDraftRecord): EffectImportDraft {
    const globalConfig = parseJson<EffectVideoConfig>(record.globalConfig);
    const issues = parseJson<EffectImportValidationIssue[]>(record.validationIssues);
    return {
      id: record.id,
      projectId: record.projectId,
      mode: record.mode,
      status: record.status,
      revision: record.revision,
      validatedRevision: record.validatedRevision,
      productCount: record.products.length,
      issueCount: issues.length,
      completedAt: record.completedAt?.toISOString() ?? null,
      lastPublish: record.lastPublish ? parseJson(record.lastPublish) : null,
      updatedAt: record.updatedAt.toISOString(),
      globalConfig,
      validationIssues: issues,
      products: record.products.map((item) => this.product(item, globalConfig, record.mode)),
      createdAt: record.createdAt.toISOString(),
    };
  }

  private workspaceValue(record: EffectWorkspaceRecord): GetEffectImportWorkspaceData['workspace'] {
    const single = record.drafts.find((draft) => draft.mode === 'SINGLE');
    const batch = record.drafts.find((draft) => draft.mode === 'BATCH');
    if (!single || !batch)
      throw new ApiHttpException(
        '资料包草稿初始化失败',
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
      );
    const current = record.currentMode === 'SINGLE' ? single : batch;
    const completed = current.status === 'COMPLETED';
    return {
      id: record.id,
      projectId: record.projectId,
      currentMode: record.currentMode,
      revision: record.revision,
      drafts: { SINGLE: this.summary(single), BATCH: this.summary(batch) },
      currentNode: completed ? 'AI_INFO_EXTRACTION' : 'SOURCE_IMPORT',
      nodeStatuses: {
        SOURCE_IMPORT: completed ? 'COMPLETED' : 'CURRENT',
        AI_INFO_EXTRACTION: completed ? 'AVAILABLE' : 'LOCKED',
      },
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private async initialized(projectId: string): Promise<EffectWorkspaceRecord> {
    await this.assertProject(projectId);
    const workspace = await this.repository.initialize(projectId, DEFAULT_EFFECT_VIDEO_CONFIG);
    const expired = await this.repository.expireManifestPreviews(projectId);
    await Promise.all(
      expired.map((file) => this.deleteOrQueue(projectId, file.storageKey, 'MANIFEST_EXPIRED')),
    );
    await this.repository.releaseExpiredPublishHolds(
      projectId,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    await this.drainStorageCleanup(projectId);
    return workspace;
  }

  async getWorkspace(projectId: string): Promise<GetEffectImportWorkspaceData> {
    const record = await this.initialized(projectId);
    return { workspace: this.workspaceValue(record), defaultConfig: DEFAULT_EFFECT_VIDEO_CONFIG };
  }

  async switchMode(
    projectId: string,
    modeValue: string,
    expectedRevision: number,
  ): Promise<SwitchEffectImportModeData> {
    this.assertMode(modeValue);
    await this.assertProject(projectId);
    const record = await this.repository.switchMode(projectId, modeValue, expectedRevision);
    if (!record) throw conflict();
    const draft = await this.repository.draft(projectId, modeValue);
    if (!draft) throw notFound();
    return { workspace: this.workspaceValue(record), draft: this.draftValue(draft) };
  }

  async getDraft(projectId: string, modeValue: string): Promise<EffectImportDraft> {
    this.assertMode(modeValue);
    await this.initialized(projectId);
    const record = await this.repository.draft(projectId, modeValue);
    if (!record) throw notFound();
    return this.draftValue(record);
  }

  async updateDraft(
    projectId: string,
    modeValue: string,
    config: EffectVideoConfig,
    expectedRevision: number,
  ): Promise<UpdateEffectImportDraftData> {
    this.assertMode(modeValue);
    await this.initialized(projectId);
    if (!isValidConfig(config)) throw badRequest('全局视频配置无效');
    const record = await this.repository.updateConfig(
      projectId,
      modeValue,
      expectedRevision,
      config,
    );
    if (!record) throw conflict();
    return { draft: this.draftValue(record) };
  }

  async listProducts(
    projectId: string,
    modeValue: string,
    query: { keyword?: string; category?: string; page?: number; pageSize?: number },
  ): Promise<EffectImportProductListData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    const page = Math.max(1, query.page ?? 1),
      pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const result = await this.repository.listProducts(projectId, draft.id, {
      ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
      ...(query.category === undefined ? {} : { category: query.category }),
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      projectId,
      draftId: draft.id,
      mode: modeValue,
      revision: draft.revision,
      items: result.items.map((item) => this.product(item, draft.globalConfig, modeValue)),
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
      },
      categoryOptions: result.categories,
    };
  }

  async createProduct(
    projectId: string,
    modeValue: string,
    input: {
      name: string;
      category: string;
      commerceUrl?: string | null;
      configOverride?: EffectVideoConfigOverride;
      expectedRevision: number;
    },
  ): Promise<EffectImportProductMutationData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    if (
      (modeValue === 'SINGLE' && draft.productCount >= 1) ||
      (modeValue === 'BATCH' && draft.productCount >= EFFECT_IMPORT_LIMITS.maxBatchProducts)
    )
      throw badRequest('当前模式的产品数量已达上限');
    const configOverride = input.configOverride ?? {};
    if (!isValidConfig(mergeEffectVideoConfig(draft.globalConfig, configOverride)))
      throw badRequest('单品视频配置无效');
    const sku = createSystemSku();
    const product = await this.repository.createProduct(
      projectId,
      draft.id,
      input.expectedRevision,
      {
        name: input.name.trim(),
        category: input.category.trim(),
        sku,
        normalizedSku: normalizeEffectImportSku(sku),
        commerceUrl: input.commerceUrl?.trim() || null,
        configOverride: configOverride as Prisma.InputJsonValue,
      },
    );
    if (!product) throw conflict();
    return {
      product: this.product(product, draft.globalConfig, modeValue),
      revision: input.expectedRevision + 1,
    };
  }

  async updateProduct(
    projectId: string,
    modeValue: string,
    productId: string,
    input: {
      name?: string;
      category?: string;
      commerceUrl?: string | null;
      configOverride?: EffectVideoConfigOverride;
      expectedRevision: number;
    },
  ): Promise<EffectImportProductMutationData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    const current = await this.repository.product(projectId, draft.id, productId);
    if (!current) throw notFound();
    const override =
      input.configOverride ?? parseJson<EffectVideoConfigOverride>(current.configOverride);
    if (!isValidConfig(mergeEffectVideoConfig(draft.globalConfig, override)))
      throw badRequest('单品视频配置无效');
    const data: Prisma.EffectImportProductUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.category !== undefined) data.category = input.category.trim();
    if (input.commerceUrl !== undefined) data.commerceUrl = input.commerceUrl?.trim() || null;
    if (input.configOverride !== undefined)
      data.configOverride = input.configOverride as Prisma.InputJsonValue;
    const product = await this.repository.updateProduct(
      projectId,
      draft.id,
      productId,
      input.expectedRevision,
      data,
    );
    if (!product) throw conflict();
    return {
      product: this.product(product, draft.globalConfig, modeValue),
      revision: input.expectedRevision + 1,
    };
  }

  async deleteProducts(
    projectId: string,
    modeValue: string,
    productIds: string[],
    expectedRevision: number,
  ): Promise<BatchDeleteEffectImportProductsData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    const result = await this.repository.deleteProducts(
      projectId,
      draft.id,
      [...new Set(productIds)],
      expectedRevision,
    );
    if (!result) {
      if (draft.revision !== expectedRevision) throw conflict();
      throw notFound();
    }
    await Promise.all(
      result.storageKeys.map((key) => this.deleteOrQueue(projectId, key, 'PRODUCT_DELETED')),
    );
    return { deletedProductIds: result.deletedIds, revision: result.revision };
  }

  async deleteProduct(
    projectId: string,
    mode: string,
    productId: string,
    expectedRevision: number,
  ): Promise<EffectImportDeleteData> {
    const result = await this.deleteProducts(projectId, mode, [productId], expectedRevision);
    return { deleted: true, revision: result.revision };
  }

  validateLink(commerceUrl: string): ValidateEffectImportLinkData {
    const normalizedUrl = normalizedCommerceUrl(commerceUrl);
    return normalizedUrl
      ? { valid: true, normalizedUrl, issue: null }
      : {
          valid: false,
          normalizedUrl: null,
          issue: validationIssue(
            'INVALID_COMMERCE_URL',
            '电商链接必须是合法的 HTTP/HTTPS 地址',
            'PRODUCT',
            { field: 'commerceUrl' },
          ),
        };
  }

  async validateLinkScoped(
    projectId: string,
    modeValue: string,
    productId: string,
    commerceUrl: string,
  ): Promise<ValidateEffectImportLinkData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    if (!(await this.repository.product(projectId, draft.id, productId))) throw notFound();
    return this.validateLink(commerceUrl);
  }

  private async assertMaterialFile(
    file: UploadedEffectFile | undefined,
    type: EffectImportMaterialType,
  ): Promise<UploadedEffectFile> {
    if (!file || file.size < 1) throw badRequest('请选择非空文件', 'FILE_REQUIRED');
    const max =
      type === 'PRODUCT_IMAGE'
        ? EFFECT_IMPORT_LIMITS.maxImageBytes
        : type === 'REFERENCE_VIDEO'
          ? EFFECT_IMPORT_LIMITS.maxReferenceVideoBytes
          : EFFECT_IMPORT_LIMITS.maxDocumentBytes;
    if (file.size > max) throw badRequest('文件大小超过该资料类型限制', 'FILE_TOO_LARGE');
    const extension = file.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
    const allowed =
      type === 'PRODUCT_IMAGE'
        ? ['.jpg', '.jpeg', '.png', '.webp']
        : type === 'REFERENCE_VIDEO'
          ? ['.mp4', '.mov', '.webm', '.mkv']
          : ['.pdf', '.doc', '.docx', '.txt', '.md'];
    if (!allowed.includes(extension)) throw badRequest('文件扩展名与资料类型不匹配');
    const mimeType = safeMime(file.mimetype);
    const allowedMimeTypes =
      type === 'PRODUCT_IMAGE'
        ? ['image/jpeg', 'image/png', 'image/webp']
        : type === 'REFERENCE_VIDEO'
          ? ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']
          : [
              'application/pdf',
              'application/msword',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'text/plain',
              'text/markdown',
              'application/octet-stream',
            ];
    if (!allowedMimeTypes.includes(mimeType)) throw badRequest('文件 MIME 与资料类型不匹配');
    const handle = await open(file.path, 'r');
    const buffer = Buffer.alloc(16);
    try {
      await handle.read(buffer, 0, 16, 0);
    } finally {
      await handle.close();
    }
    const signature =
      type === 'PRODUCT_IMAGE'
        ? buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ||
          buffer
            .subarray(0, 8)
            .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
          (buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
            buffer.subarray(8, 12).toString('ascii') === 'WEBP')
        : type === 'REFERENCE_VIDEO'
          ? buffer.subarray(4, 8).toString('ascii') === 'ftyp' ||
            buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
          : extension === '.txt' ||
            extension === '.md' ||
            buffer.subarray(0, 4).toString('ascii') === '%PDF' ||
            buffer.subarray(0, 2).toString('ascii') === 'PK' ||
            buffer
              .subarray(0, 8)
              .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    if (!signature) throw badRequest('文件签名与资料类型不匹配');
    return file;
  }

  async uploadMaterial(
    projectId: string,
    modeValue: string,
    productId: string,
    input: { type: EffectImportMaterialType; expectedFileName?: string; expectedRevision: number },
    file: UploadedEffectFile | undefined,
  ): Promise<EffectImportMaterialMutationData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    if (!(await this.repository.product(projectId, draft.id, productId))) throw notFound();
    try {
      const validFile = await this.assertMaterialFile(file, input.type);
      let stored: { key: string; sizeBytes: number } | null = null;
      try {
        stored = await this.storage.put({
          stream: createReadStream(validFile.path),
          sizeBytes: validFile.size,
        });
      } catch {
        const failed = await this.repository.createMaterial(
          projectId,
          draft.id,
          productId,
          input.expectedRevision,
          {
            type: input.type,
            status: 'FAILED',
            expectedFileName: input.expectedFileName?.trim() || null,
            originalFileName: safeFileName(validFile.originalname),
            mimeType: safeMime(validFile.mimetype),
            sizeBytes: validFile.size,
            failureDisposition: 'REQUIRES_NEW_FILE',
            errorCode: 'STORAGE_WRITE_FAILED',
            errorMessage: '文件内容未能保存，请重新选择文件',
          },
        );
        if (!failed) throw conflict();
        return {
          material: this.material(failed, modeValue),
          revision: input.expectedRevision + 1,
        };
      }
      try {
        let processingReady = true;
        try {
          const opened = await this.storage.open(stored.key);
          opened.stream.destroy();
        } catch {
          processingReady = false;
        }
        const material = await this.repository.createMaterial(
          projectId,
          draft.id,
          productId,
          input.expectedRevision,
          {
            type: input.type,
            status: processingReady ? 'READY' : 'FAILED',
            expectedFileName: input.expectedFileName?.trim() || null,
            originalFileName: safeFileName(validFile.originalname),
            mimeType: safeMime(validFile.mimetype),
            sizeBytes: stored.sizeBytes,
            storageKey: stored.key,
            ...(processingReady
              ? {}
              : {
                  failureDisposition: 'RETRYABLE' as const,
                  errorCode: 'STORED_CONTENT_PROCESSING_FAILED',
                  errorMessage: '文件已保留，服务端处理失败，可直接重试',
                }),
          },
        );
        if (!material) throw conflict();
        return {
          material: this.material(material, modeValue),
          revision: input.expectedRevision + 1,
        };
      } catch (error) {
        await this.deleteOrQueue(projectId, stored.key, 'MATERIAL_CREATE_ROLLBACK');
        throw error;
      }
    } finally {
      if (file) await rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  async replaceMaterial(
    projectId: string,
    modeValue: string,
    productId: string,
    materialId: string,
    expectedRevision: number,
    file: UploadedEffectFile | undefined,
  ): Promise<EffectImportMaterialMutationData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    const current = await this.repository.material(projectId, productId, materialId);
    if (!current || !(await this.repository.product(projectId, draft.id, productId)))
      throw notFound();
    try {
      const validFile = await this.assertMaterialFile(file, current.type);
      let stored: { key: string; sizeBytes: number } | null = null;
      try {
        stored = await this.storage.put({
          stream: createReadStream(validFile.path),
          sizeBytes: validFile.size,
        });
      } catch {
        // Replacement is a two-phase swap: a failed write must leave the
        // currently READY material and its storage object untouched.
        throw new ApiHttpException(
          '新文件保存失败，原资料已保留，请重新上传',
          HttpStatus.INTERNAL_SERVER_ERROR,
          'STORAGE_WRITE_FAILED',
        );
      }
      try {
        let processingReady = true;
        try {
          const opened = await this.storage.open(stored.key);
          opened.stream.destroy();
        } catch {
          processingReady = false;
        }
        const material = await this.repository.replaceMaterial(
          projectId,
          draft.id,
          productId,
          materialId,
          expectedRevision,
          {
            status: processingReady ? 'READY' : 'FAILED',
            originalFileName: safeFileName(validFile.originalname),
            mimeType: safeMime(validFile.mimetype),
            sizeBytes: stored.sizeBytes,
            storageKey: stored.key,
            failureDisposition: processingReady ? null : 'RETRYABLE',
            errorCode: processingReady ? null : 'STORED_CONTENT_PROCESSING_FAILED',
            errorMessage: processingReady ? null : '文件已保留，服务端处理失败，可直接重试',
            retryCount: { increment: 1 },
          },
        );
        if (!material) throw conflict();
        if (current.storageKey && current.storageKey !== stored.key)
          await this.deleteOrQueue(projectId, current.storageKey, 'MATERIAL_REPLACED');
        return {
          material: this.material(material, modeValue),
          revision: expectedRevision + 1,
        };
      } catch (error) {
        await this.deleteOrQueue(projectId, stored.key, 'MATERIAL_REPLACE_ROLLBACK');
        throw error;
      }
    } finally {
      if (file) await rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  async deleteMaterial(
    projectId: string,
    modeValue: string,
    productId: string,
    materialId: string,
    expectedRevision: number,
  ): Promise<EffectImportDeleteData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    const result = await this.repository.deleteMaterial(
      projectId,
      draft.id,
      productId,
      materialId,
      expectedRevision,
    );
    if (!result) {
      if (draft.revision !== expectedRevision) throw conflict();
      throw notFound();
    }
    if (result.storageKey)
      await this.deleteOrQueue(projectId, result.storageKey, 'MATERIAL_DELETED');
    return { deleted: true, revision: result.revision };
  }

  async materialContent(
    projectId: string,
    modeValue: string,
    productId: string,
    materialId: string,
    rangeHeader?: string,
  ): Promise<EffectMaterialContent> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    if (!(await this.repository.product(projectId, draft.id, productId))) throw notFound();
    const material = await this.repository.material(projectId, productId, materialId);
    if (
      !material?.storageKey ||
      !material.originalFileName ||
      !material.mimeType ||
      !material.sizeBytes
    )
      throw notFound();
    let range: { start: number; end: number } | undefined;
    if (rangeHeader && material.type === 'REFERENCE_VIDEO') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (!match) throw badRequest('文件范围无效');
      const start = Number(match[1]),
        end = match[2]
          ? Math.min(Number(match[2]), material.sizeBytes - 1)
          : material.sizeBytes - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        start >= material.sizeBytes
      )
        throw badRequest('文件范围无效');
      range = { start, end };
    }
    return {
      ...(await this.storage.open(material.storageKey, range)),
      mimeType: material.mimeType,
      originalFileName: material.originalFileName,
      partial: range !== undefined,
    };
  }

  async batchRetry(
    projectId: string,
    modeValue: string,
    productIds: string[],
    expectedRevision: number,
  ): Promise<BatchRetryEffectImportProductsData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    const materials = await this.repository.retryMaterials(
      projectId,
      draft.id,
      [...new Set(productIds)],
      expectedRevision,
    );
    if (!materials) throw conflict();
    const results: BatchRetryEffectImportProductsData['results'] = [];
    for (const item of materials) {
      if (item.failureDisposition !== 'RETRYABLE' || !item.storageKey) {
        results.push({
          materialId: item.id,
          productId: item.productId,
          status:
            item.failureDisposition === 'REQUIRES_NEW_FILE' ? 'REQUIRES_NEW_FILE' : 'NOT_RETRYABLE',
        });
        continue;
      }
      let ready: boolean;
      try {
        const opened = await this.storage.open(item.storageKey);
        opened.stream.destroy();
        ready = true;
      } catch {
        ready = false;
      }
      await this.repository.finishMaterialRetry(projectId, draft.id, item.id, ready);
      results.push({
        materialId: item.id,
        productId: item.productId,
        // The content is still retained and retryable when processing fails again.
        status: 'RETRYING',
      });
    }
    return {
      results,
      revision: expectedRevision + 1,
    };
  }

  private manifestPreview(record: ManifestRecord): PreviewEffectManifestData {
    return {
      id: record.id,
      projectId: record.projectId,
      draftId: record.draftId,
      status: record.status,
      format: record.format,
      originalFileName: record.originalFileName,
      rowCount: record.rowCount,
      rows: parseJson(record.previewRows),
      stagedFiles: record.stagedFiles.map((file) => ({
        id: file.id,
        projectId: file.projectId,
        manifestImportId: file.manifestImportId,
        originalFileName: file.originalFileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        matchedRowNumbers: file.matchedRowNumbers,
        matchedMaterialType: file.matchedMaterialType,
        matchStatus: file.matchStatus,
      })),
      issues: parseJson(record.issues),
      expiresAt: record.expiresAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
    };
  }

  async previewManifest(
    projectId: string,
    expectedRevision: number,
    idempotencyKey: string | undefined,
    manifest: UploadedEffectFile | undefined,
    files: UploadedEffectFile[],
  ): Promise<PreviewEffectManifestData> {
    const draft = await this.getDraft(projectId, 'BATCH');
    if (draft.revision !== expectedRevision) throw conflict();
    if (!manifest || manifest.size < 1) throw badRequest('请选择清单文件', 'FILE_REQUIRED');
    if (manifest.size > EFFECT_IMPORT_LIMITS.maxManifestBytes)
      throw badRequest('清单文件超过 10 MiB', 'FILE_TOO_LARGE');
    if (files.length > MANIFEST_COMPANION_COUNT_LIMIT)
      throw badRequest(`配套文件最多 ${MANIFEST_COMPANION_COUNT_LIMIT} 个`);
    const totalUploadBytes = manifest.size + files.reduce((total, file) => total + file.size, 0);
    if (totalUploadBytes > EFFECT_MANIFEST_UPLOAD_TOTAL_BYTES)
      throw badRequest('清单与配套文件总大小超过 522 MiB', 'FILE_TOO_LARGE');
    const key = idempotencyKey?.trim();
    if (key) {
      const existing = await this.repository.manifestByIdempotency(projectId, draft.id, key);
      if (existing) return this.manifestPreview(existing);
    }
    const allTemp = [manifest, ...files];
    const stored: Array<{ file: UploadedEffectFile; key: string; id: string }> = [];
    try {
      const parsed = await parseEffectManifest(manifest.path, manifest.originalname);
      if (draft.productCount + parsed.rows.length > EFFECT_IMPORT_LIMITS.maxBatchProducts)
        parsed.issues.push(
          validationIssue(
            'PRODUCT_LIMIT_EXCEEDED',
            '清单确认后将超过批量产品上限',
            'MANIFEST_FILE',
          ),
        );
      for (const row of parsed.rows) {
        if (row.commerceUrl && !normalizedCommerceUrl(row.commerceUrl)) {
          row.issues.push(
            validationIssue(
              'INVALID_COMMERCE_URL',
              '电商链接必须是合法的 HTTP/HTTPS 地址',
              'MANIFEST_ROW',
              { field: 'commerceUrl', manifestRowNumber: row.rowNumber },
            ),
          );
          row.valid = false;
        }
      }
      for (const file of files) {
        if (file.size < 1) continue;
        const object = await this.storage.put({
          stream: createReadStream(file.path),
          sizeBytes: file.size,
        });
        stored.push({ file, key: object.key, id: randomUUID() });
      }
      const byName = new Map<string, typeof stored>();
      for (const item of stored) {
        const normalized = normalizeManifestFileName(item.file.originalname);
        byName.set(normalized, [...(byName.get(normalized) ?? []), item]);
      }
      const refsByStagedId = new Map<
        string,
        Array<{ row: EffectManifestPreviewRow; type: EffectImportMaterialType }>
      >();
      const ambiguousStagedIds = new Set<string>();
      for (const row of parsed.rows)
        for (const reference of row.materialReferences) {
          const matches = byName.get(normalizeManifestFileName(reference.expectedFileName)) ?? [];
          reference.stagedFileIds = matches.map((match) => match.id);
          reference.matchStatus =
            matches.length === 1 ? 'MATCHED' : matches.length === 0 ? 'MISSING' : 'AMBIGUOUS';
          if (matches.length !== 1)
            row.issues.push(
              validationIssue(
                matches.length === 0 ? 'FILE_MATCH_NOT_FOUND' : 'FILE_MATCH_AMBIGUOUS',
                matches.length === 0
                  ? `未找到文件：${reference.expectedFileName}`
                  : `存在多个同名文件：${reference.expectedFileName}`,
                'MANIFEST_ROW',
                { manifestRowNumber: row.rowNumber, fileName: reference.expectedFileName },
              ),
            );
          if (matches.length > 1) for (const match of matches) ambiguousStagedIds.add(match.id);
          for (const match of matches)
            refsByStagedId.set(match.id, [
              ...(refsByStagedId.get(match.id) ?? []),
              { row, type: reference.type },
            ]);
        }
      for (const [id, refs] of refsByStagedId)
        if (refs.length > 1) {
          for (const { row } of refs) {
            row.issues.push(
              validationIssue(
                'FILE_MATCH_AMBIGUOUS',
                '同一配套文件被多个资料项引用',
                'MANIFEST_ROW',
                { manifestRowNumber: row.rowNumber },
              ),
            );
            row.valid = false;
          }
          for (const row of parsed.rows)
            for (const ref of row.materialReferences)
              if (ref.stagedFileIds.includes(id)) ref.matchStatus = 'AMBIGUOUS';
        }
      const invalidStagedIds = new Set<string>();
      for (const [id, refs] of refsByStagedId) {
        if (refs.length !== 1) continue;
        const item = stored.find((candidate) => candidate.id === id);
        if (!item) continue;
        try {
          await this.assertMaterialFile(item.file, refs[0]!.type);
        } catch (error) {
          invalidStagedIds.add(id);
          const row = refs[0]!.row;
          const tooLarge =
            error instanceof ApiHttpException && error.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE;
          row.issues.push(
            validationIssue(
              tooLarge ? 'FILE_TOO_LARGE' : 'FILE_TYPE_UNSUPPORTED',
              tooLarge ? '配套文件超过资料类型大小限制' : '配套文件类型或签名无效',
              'MANIFEST_ROW',
              { manifestRowNumber: row.rowNumber, fileName: item.file.originalname },
            ),
          );
          for (const reference of row.materialReferences) {
            if (reference.stagedFileIds.includes(id)) reference.matchStatus = 'MISSING';
          }
        }
      }
      for (const row of parsed.rows) row.valid = row.issues.length === 0;
      const importId = randomUUID();
      const stagedFileRecords = stored.map((item) => {
        const refs = refsByStagedId.get(item.id) ?? [];
        return {
          id: item.id,
          projectId,
          manifestImportId: importId,
          originalFileName: safeFileName(item.file.originalname),
          mimeType: safeMime(item.file.mimetype),
          sizeBytes: item.file.size,
          storageKey: item.key,
          matchedRowNumbers: refs.map(({ row }) => row.rowNumber),
          matchedMaterialType: refs.length === 1 ? refs[0]!.type : null,
          matchStatus:
            refs.length === 1 && !ambiguousStagedIds.has(item.id) && !invalidStagedIds.has(item.id)
              ? ('MATCHED' as const)
              : refs.length === 0
                ? ('MISSING' as const)
                : ('AMBIGUOUS' as const),
        };
      });
      const record = await this.repository.createManifestWithFiles(
        projectId,
        draft.id,
        {
          id: importId,
          status: 'PREVIEW',
          format: parsed.format,
          originalFileName: safeFileName(manifest.originalname),
          rowCount: parsed.rows.length,
          previewRows: parsed.rows as unknown as Prisma.InputJsonValue,
          issues: parsed.issues as unknown as Prisma.InputJsonValue,
          idempotencyKey: key || null,
          expiresAt: new Date(
            Date.now() + EFFECT_IMPORT_LIMITS.manifestPreviewTtlHours * 60 * 60 * 1000,
          ),
        },
        stagedFileRecords,
      );
      return this.manifestPreview(record);
    } catch (error) {
      await Promise.all(
        stored.map((item) => this.deleteOrQueue(projectId, item.key, 'MANIFEST_PREVIEW_ROLLBACK')),
      );
      if (key) {
        const existing = await this.repository.manifestByIdempotency(projectId, draft.id, key);
        if (existing) return this.manifestPreview(existing);
      }
      throw error;
    } finally {
      await Promise.all(
        allTemp.map((file) => rm(file.path, { force: true }).catch(() => undefined)),
      );
    }
  }

  async commitManifest(
    projectId: string,
    importId: string,
    expectedRevision: number,
    commitIdempotencyKey: string,
  ): Promise<CommitEffectManifestData> {
    const draft = await this.getDraft(projectId, 'BATCH');
    const manifest = await this.repository.manifest(projectId, draft.id, importId);
    if (!manifest) throw notFound();
    if (manifest.status === 'COMMITTED') {
      if (manifest.commitIdempotencyKey !== commitIdempotencyKey) throw conflict();
      const ids = draft.products
        .filter((item) => item.sourceManifestImportId === importId)
        .map((item) => item.id);
      return {
        manifestImportId: importId,
        status: 'COMMITTED',
        productIds: ids,
        createdProductCount: ids.length,
        revision: draft.revision,
      };
    }
    if (manifest.status !== 'PREVIEW' || manifest.expiresAt <= new Date()) throw conflict();
    const rows = parseJson<EffectManifestPreviewRow[]>(manifest.previewRows);
    if (draft.productCount + rows.length > EFFECT_IMPORT_LIMITS.maxBatchProducts)
      throw badRequest('确认后将超过批量产品上限');
    const result = await this.repository.commitManifest(
      projectId,
      draft.id,
      importId,
      expectedRevision,
      commitIdempotencyKey,
      rows.map((row) => {
        const sku = createSystemSku();
        return {
          rowNumber: row.rowNumber,
          name: row.name,
          category: row.category,
          sku,
          normalizedSku: normalizeEffectImportSku(sku),
          commerceUrl: row.commerceUrl,
          materials: row.materialReferences.map((ref) => ({
            type: ref.type,
            expectedFileName: ref.expectedFileName,
            stagedFileId: ref.matchStatus === 'MATCHED' ? (ref.stagedFileIds[0] ?? null) : null,
          })),
        };
      }),
    );
    if (!result) {
      // A concurrent request with the same key may have won the PREVIEW ->
      // COMMITTED transition while this request was waiting on the row lock.
      const replayDraft = await this.getDraft(projectId, 'BATCH');
      const replayManifest = await this.repository.manifest(projectId, replayDraft.id, importId);
      if (
        replayManifest?.status === 'COMMITTED' &&
        replayManifest.commitIdempotencyKey === commitIdempotencyKey
      ) {
        const ids = replayDraft.products
          .filter((item) => item.sourceManifestImportId === importId)
          .map((item) => item.id);
        return {
          manifestImportId: importId,
          status: 'COMMITTED',
          productIds: ids,
          createdProductCount: ids.length,
          revision: replayDraft.revision,
        };
      }
      throw conflict();
    }
    await Promise.all(
      result.cleanupStorageKeys.map((key) =>
        this.deleteOrQueue(projectId, key, 'MANIFEST_COMMIT_UNMATCHED'),
      ),
    );
    return {
      manifestImportId: importId,
      status: 'COMMITTED',
      productIds: result.productIds,
      createdProductCount: result.productIds.length,
      revision: result.revision,
    };
  }

  async cancelManifest(
    projectId: string,
    importId: string,
    expectedRevision: number,
  ): Promise<{
    manifestImportId: string;
    status: 'CANCELLED';
    deletedStagedFileCount: number;
    revision: number;
  }> {
    const draft = await this.getDraft(projectId, 'BATCH');
    if (draft.revision !== expectedRevision) throw conflict();
    const manifest = await this.repository.cancelManifest(projectId, draft.id, importId);
    if (!manifest) throw notFound();
    const pending = manifest.stagedFiles.filter((file) => !file.transferredAt);
    await Promise.all(
      pending.map((file) => this.deleteOrQueue(projectId, file.storageKey, 'MANIFEST_CANCELLED')),
    );
    return {
      manifestImportId: importId,
      status: 'CANCELLED',
      deletedStagedFileCount: pending.length,
      revision: draft.revision,
    };
  }

  async template(
    format: 'csv' | 'xlsx',
  ): Promise<{ buffer: Buffer; fileName: string; contentType: string }> {
    if (format === 'csv') {
      const example = [
        '示例产品',
        '护肤',
        'https://example.com/item/1',
        'front.jpg|back.jpg',
        'manual.pdf',
        'brand.pdf',
        'reference.mp4',
      ];
      return {
        buffer: Buffer.from(
          `\uFEFF${EFFECT_MANIFEST_COLUMNS.join(',')}\r\n${example.join(',')}\r\n`,
          'utf8',
        ),
        fileName: 'effect-source-import-template.csv',
        contentType: 'text/csv; charset=utf-8',
      };
    }
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('资料包清单');
    sheet.addRow([...EFFECT_MANIFEST_COLUMNS]);
    sheet.addRow([
      '示例产品',
      '护肤',
      'https://example.com/item/1',
      'front.jpg|back.jpg',
      'manual.pdf',
      'brand.pdf',
      'reference.mp4',
    ]);
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column) => {
      column.width = 22;
    });
    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      fileName: 'effect-source-import-template.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  private collectValidation(draft: EffectImportDraft): EffectImportValidationIssue[] {
    const issues: EffectImportValidationIssue[] = [];
    if (draft.products.length === 0 || (draft.mode === 'SINGLE' && draft.products.length !== 1))
      issues.push(
        validationIssue(
          'REQUIRED_FIELD',
          draft.mode === 'SINGLE' ? '单产品模式必须且只能维护一个产品' : '至少添加一个产品',
          'DRAFT',
        ),
      );
    if (!isValidConfig(draft.globalConfig))
      issues.push(validationIssue('INVALID_VIDEO_CONFIG', '全局视频配置无效', 'DRAFT'));
    for (const product of draft.products) {
      for (const [field, value] of [
        ['name', product.name],
        ['category', product.category],
      ] as const)
        if (!value.trim())
          issues.push(
            validationIssue('REQUIRED_FIELD', `${field} 为必填字段`, 'PRODUCT', {
              productId: product.id,
              field,
            }),
          );
      if (product.commerceUrl && !normalizedCommerceUrl(product.commerceUrl))
        issues.push(
          validationIssue('INVALID_COMMERCE_URL', '电商链接格式无效', 'PRODUCT', {
            productId: product.id,
            field: 'commerceUrl',
          }),
        );
      if (!isValidConfig(product.effectiveConfig))
        issues.push(
          validationIssue('INVALID_VIDEO_CONFIG', '单品视频配置无效', 'PRODUCT', {
            productId: product.id,
            field: 'configOverride',
          }),
        );
      if (
        !product.materials.some(
          (material) => material.type === 'PRODUCT_IMAGE' && material.status === 'READY',
        )
      )
        issues.push(
          validationIssue(
            'PRODUCT_IMAGE_REQUIRED',
            '每个产品至少需要一张已就绪商品图片',
            'PRODUCT',
            { productId: product.id },
          ),
        );
      for (const material of product.materials)
        if (material.status !== 'READY')
          issues.push(
            validationIssue(
              material.status === 'MISSING'
                ? 'MATERIAL_MISSING'
                : material.status === 'UPLOADING'
                  ? 'MATERIAL_UPLOADING'
                  : 'MATERIAL_FAILED',
              material.status === 'MISSING'
                ? '资料文件未匹配'
                : material.status === 'UPLOADING'
                  ? '资料仍在上传'
                  : '资料处理失败',
              'MATERIAL',
              {
                productId: product.id,
                materialId: material.id,
                fileName: material.expectedFileName,
              },
            ),
          );
    }
    return issues;
  }

  async validate(
    projectId: string,
    modeValue: string,
    expectedRevision: number,
  ): Promise<ValidateEffectImportDraftData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    if (draft.revision !== expectedRevision) throw conflict();
    const issues = this.collectValidation(draft);
    const record = await this.repository.saveValidation(
      projectId,
      draft.id,
      expectedRevision,
      issues,
    );
    if (!record) throw conflict();
    const value = this.draftValue(record);
    const validatedAt = new Date().toISOString();
    return {
      draft: value,
      validation: {
        projectId,
        draftId: draft.id,
        mode: modeValue,
        revision: expectedRevision,
        validatedRevision: issues.length === 0 ? expectedRevision : null,
        valid: issues.length === 0,
        issues,
        validatedAt,
      },
    };
  }

  async publish(
    projectId: string,
    modeValue: string,
    expectedRevision: number,
    idempotencyKeyValue: string,
  ): Promise<PublishEffectImportDraftData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    const idempotencyKey = idempotencyKeyValue.trim();
    if (!idempotencyKey || idempotencyKey.length > 500)
      throw badRequest('发布幂等键长度必须为 1 到 500 个字符');
    const existingOperation = await this.repository.publishOperationByKey(
      projectId,
      idempotencyKey,
    );
    if (
      !existingOperation &&
      (draft.revision !== expectedRevision ||
        draft.validatedRevision !== draft.revision ||
        this.collectValidation(draft).length > 0)
    )
      throw conflict();
    const attemptToken = randomUUID();
    if (existingOperation && existingOperation.draftId !== draft.id) throw conflict();
    const claimRevision = existingOperation?.revision ?? expectedRevision;
    const claim = await this.repository.startPublishOperation(
      projectId,
      draft.id,
      claimRevision,
      idempotencyKey,
      attemptToken,
    );
    if (!claim || !claim.requestMatches) throw conflict();
    if (claim.operation.status === 'COMPLETED' && claim.operation.result) {
      return parseJson<PublishEffectImportDraftData>(claim.operation.result);
    }
    if (!claim.owner) throw conflict();
    const snapshot = parseJson<PublishDraftSnapshot>(claim.operation.snapshot);
    const globalConfig = snapshot.globalConfig as EffectVideoConfig;
    try {
      const publishedAssets: EffectImportPublishedAsset[] = [];
      for (const product of snapshot.products) {
        const baseName = product.name || product.sku || '未命名产品';
        const tags = assetSafeTags(product.category, product.sku);
        const metadata = await this.assetService.storeWorkflowArtifact(
          projectId,
          'EFFECT',
          'EFFECT',
          {
            idempotencyKey: `effect-import:${snapshot.id}:product:${product.id}:metadata`,
            name: assetSafeName(`${baseName} 产品资料`),
            directory: 'SOURCE_MATERIALS',
            type: 'SOURCE_MATERIAL',
            tags,
            notes: '效果类资料包产品元数据',
            sourceArtifactId: product.id,
            sourceNode: 'SOURCE_IMPORT',
            contentKind: 'EFFECT_IMPORT_PRODUCT',
            content: {
              name: product.name,
              category: product.category,
              sku: product.sku,
              commerceUrl: product.commerceUrl,
            },
          },
          `${claim.operation.id}:product:${product.id}:metadata`,
        );
        publishedAssets.push({
          assetId: metadata.asset.id,
          assetVersionId: metadata.assetVersionId,
          version: metadata.version,
          productId: product.id,
          materialId: null,
          kind: 'PRODUCT_METADATA',
        });
        const config = await this.assetService.storeWorkflowArtifact(
          projectId,
          'EFFECT',
          'EFFECT',
          {
            idempotencyKey: `effect-import:${snapshot.id}:product:${product.id}:config`,
            name: assetSafeName(`${baseName} 视频配置`),
            directory: 'SOURCE_MATERIALS',
            type: 'VIDEO_CONFIG',
            tags,
            notes: '效果类资料包视频配置',
            sourceArtifactId: product.id,
            sourceNode: 'SOURCE_IMPORT',
            contentKind: 'EFFECT_VIDEO_CONFIG',
            content: mergeEffectVideoConfig(
              globalConfig,
              product.configOverride as EffectVideoConfigOverride,
            ),
          },
          `${claim.operation.id}:product:${product.id}:config`,
        );
        publishedAssets.push({
          assetId: config.asset.id,
          assetVersionId: config.assetVersionId,
          version: config.version,
          productId: product.id,
          materialId: null,
          kind: 'VIDEO_CONFIG',
        });
        for (const material of product.materials.filter((item) => item.status === 'READY')) {
          const source = material;
          if (
            !source?.storageKey ||
            !source.originalFileName ||
            !source.mimeType ||
            !source.sizeBytes
          )
            throw conflict();
          const stored = await this.assetService.storeWorkflowFileOperation(projectId, {
            name: assetSafeName(`${baseName} · ${source.originalFileName}`),
            directory: 'SOURCE_MATERIALS',
            type: source.type === 'REFERENCE_VIDEO' ? 'REFERENCE_VIDEO' : 'SOURCE_MATERIAL',
            originalFileName: source.originalFileName,
            mimeType: source.mimeType,
            sizeBytes: source.sizeBytes,
            sourceStorageKey: source.storageKey,
            workflow: 'EFFECT',
            space: 'EFFECT',
            idempotencyKey: `effect-import:${snapshot.id}:material:${source.id}`,
            operationKey: `${claim.operation.id}:material:${source.id}`,
            tags,
            notes: '效果类资料包文件',
            businessData: {
              productId: product.id,
              materialId: source.id,
              materialType: source.type,
            },
            sourceArtifactId: source.id,
            sourceNode: 'SOURCE_IMPORT',
          });
          publishedAssets.push({
            assetId: stored.asset.id,
            assetVersionId: stored.assetVersionId,
            version: stored.version,
            productId: product.id,
            materialId: source.id,
            kind: 'MATERIAL',
          });
        }
      }
      const summary = {
        publishedAt: new Date().toISOString(),
        assetCount: new Set(publishedAssets.map((item) => item.assetId)).size,
        assetVersionCount: publishedAssets.length,
      };
      const result: PublishEffectImportDraftData = {
        projectId,
        draftId: snapshot.id,
        mode: snapshot.mode,
        revision: snapshot.revision,
        publishedAssets,
        summary,
      };
      if (
        !(await this.repository.completePublishOperation(
          projectId,
          claim.operation.id,
          attemptToken,
          result,
          summary,
        ))
      )
        throw conflict();
      await this.drainStorageCleanup(projectId);
      return result;
    } catch (error) {
      await this.repository.failPublishOperation(
        projectId,
        claim.operation.id,
        attemptToken,
        error instanceof Error ? error.message : '正式入库失败',
      );
      throw error;
    }
  }

  async advance(
    projectId: string,
    modeValue: string,
    expectedRevision: number,
  ): Promise<AdvanceEffectImportDraftData> {
    this.assertMode(modeValue);
    const draft = await this.getDraft(projectId, modeValue);
    if (
      draft.revision !== expectedRevision ||
      draft.validatedRevision !== draft.revision ||
      this.collectValidation(draft).length > 0
    )
      throw conflict();
    if (!(await this.repository.markCompleted(projectId, draft.id, expectedRevision)))
      throw conflict();
    return {
      projectId,
      draftId: draft.id,
      mode: modeValue,
      revision: expectedRevision,
      completedNode: 'SOURCE_IMPORT',
      nextNode: 'AI_INFO_EXTRACTION',
      nextNodeStatus: 'AVAILABLE',
    };
  }
}
