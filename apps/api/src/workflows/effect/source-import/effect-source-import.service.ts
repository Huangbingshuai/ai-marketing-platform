import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_EFFECT_VIDEO_CONFIG,
  EFFECT_IMPORT_LIMITS,
  EFFECT_IMPORT_UPLOAD_MATERIAL_TYPES,
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
  type EffectImportValidationIssue,
  type EffectManifestPreviewRow,
  type GetEffectImportWorkspaceData,
  type PreviewEffectManifestData,
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
import type { StoredStream, StoragePort } from '../../../platform/file/storage.port';
import { STORAGE_PORT } from '../../../platform/file/storage.port';
import { safeOriginalFileName } from '../../../platform/file/file-name';
import { ProjectService } from '../../../platform/project/project.service';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import {
  EffectSourceImportRepository,
  type EffectDraftRecord,
  type EffectProductRecord,
  type EffectWorkspaceRecord,
  type ManifestRecord,
  type WorkingMaterialProjection,
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
  code:
    | 'VALIDATION_ERROR'
    | 'FILE_REQUIRED'
    | 'FILE_TOO_LARGE'
    | 'FILE_TYPE_UNSUPPORTED' = 'VALIDATION_ERROR',
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
export { normalizeMultipartFileName } from '../../../platform/file/file-name';
const safeFileName = safeOriginalFileName;
const safeMime = (value: string): string =>
  (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : 'application/octet-stream'
  ).slice(0, 120);
const assetSafeName = (value: string): string => (value.trim() || '未命名资料').slice(0, 120);
const assetSafeTags = (...values: string[]): string[] =>
  [...new Set(values.map((value) => value.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
const normalizeProductName = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const requiredProductName = (value: string, message = '产品名称不能为空'): string => {
  const name = normalizeProductName(value);
  if (!name) throw badRequest(message);
  return name;
};
const createSystemSku = (): string =>
  `SYS-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
const MANIFEST_COMPANION_COUNT_LIMIT = 20;
export const EFFECT_MANIFEST_UPLOAD_TOTAL_BYTES =
  512 * 1024 * 1024 + EFFECT_IMPORT_LIMITS.maxManifestBytes;

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
    @Inject(WorkflowWorkingService) private readonly workingService: WorkflowWorkingService,
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

  private workingMaterialProjection(
    workspace: EffectWorkspaceRecord,
    product: EffectProductRecord,
    material: {
      id: string;
      type: EffectImportMaterialType;
      originalFileName: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
    },
  ): WorkingMaterialProjection {
    const productName = normalizeProductName(product.name);
    if (!productName) throw badRequest('请先填写产品名称，再上传产品资料');
    const tags = assetSafeTags(productName, product.category, product.sku);
    const originalFileName = safeFileName(material.originalFileName);
    return {
      workflowRunId: workspace.workflowRunId,
      nodeId: 'SOURCE_IMPORT',
      artifactKey: `material:${material.id}`,
      input: {
        kind: 'FILE',
        name: assetSafeName(`${productName} · ${originalFileName}`),
        directory: 'SOURCE_MATERIALS',
        type: material.type === 'REFERENCE_VIDEO' ? 'REFERENCE_VIDEO' : 'SOURCE_MATERIAL',
        tags,
        originalFileName,
        mimeType: material.mimeType,
        sizeBytes: material.sizeBytes,
        storageKey: material.storageKey,
        metadata: {
          productId: product.id,
          productName,
          materialId: material.id,
          materialType: material.type,
        },
        sourceArtifactId: material.id,
      },
    };
  }

  private async removeCurrentMaterial(projectId: string, _draftId: string, materialId: string) {
    const workspace = await this.repository.workspace(projectId);
    if (!workspace) return false;
    return this.workingService.removeArtifact(
      projectId,
      workspace.workflowRunId,
      'SOURCE_IMPORT',
      `material:${materialId}`,
    );
  }

  private async removeCurrentProduct(
    projectId: string,
    draftId: string,
    product: Pick<EffectImportProduct, 'materials'>,
  ): Promise<void> {
    await Promise.all(
      product.materials.map((material) =>
        this.removeCurrentMaterial(projectId, draftId, material.id),
      ),
    );
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
      originalFileName: record.originalFileName ? safeFileName(record.originalFileName) : null,
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
      workflowRunId: record.workflowRunId,
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
      name?: string;
      category?: string;
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
    const name = input.name === undefined ? '' : requiredProductName(input.name);
    const product = await this.repository.createProduct(
      projectId,
      draft.id,
      input.expectedRevision,
      {
        name,
        category: input.category?.trim() ?? '',
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
    if (input.name !== undefined) data.name = requiredProductName(input.name);
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
    const deleting = draft.products.filter((product) => productIds.includes(product.id));
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
    await Promise.all(
      deleting.map((product) => this.removeCurrentProduct(projectId, draft.id, product)),
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
    if (!EFFECT_IMPORT_UPLOAD_MATERIAL_TYPES.some((candidate) => candidate === type))
      throw badRequest('当前只支持商品图片和产品文档', 'FILE_TYPE_UNSUPPORTED');
    if (!file || file.size < 1) throw badRequest('请选择非空文件', 'FILE_REQUIRED');
    const max =
      type === 'PRODUCT_IMAGE'
        ? EFFECT_IMPORT_LIMITS.maxImageBytes
        : EFFECT_IMPORT_LIMITS.maxDocumentBytes;
    if (file.size > max) throw badRequest('文件大小超过该资料类型限制', 'FILE_TOO_LARGE');
    const extension = file.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
    const allowed =
      type === 'PRODUCT_IMAGE'
        ? ['.jpg', '.jpeg', '.png', '.psd', '.webp']
        : ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.md'];
    if (!allowed.includes(extension)) throw badRequest('文件扩展名与资料类型不匹配');
    const mimeType = safeMime(file.mimetype);
    const allowedMimeTypes =
      type === 'PRODUCT_IMAGE'
        ? [
            'image/jpeg',
            'image/png',
            'image/vnd.adobe.photoshop',
            'image/webp',
            'application/octet-stream',
          ]
        : [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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
          buffer.subarray(0, 4).toString('ascii') === '8BPS' ||
          (buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
            buffer.subarray(8, 12).toString('ascii') === 'WEBP')
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
    const product = await this.repository.product(projectId, draft.id, productId);
    if (!product) throw notFound();
    const productName = requiredProductName(product.name, '请先填写产品名称，再上传产品资料');
    const project = await this.projectService.get(projectId);
    try {
      const validFile = await this.assertMaterialFile(file, input.type);
      let stored: { key: string; sizeBytes: number } | null = null;
      try {
        stored = await this.storage.put({
          projectId,
          stream: createReadStream(validFile.path),
          sizeBytes: validFile.size,
          contentType: safeMime(validFile.mimetype),
          keyContext: {
            projectName: project.name,
            workflow: 'EFFECT',
            lifecycle: 'staging',
            productId,
            productName,
            category: input.type === 'PRODUCT_IMAGE' ? '商品图片' : '产品文档',
            originalFileName: safeFileName(validFile.originalname),
          },
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
      let databaseCommitted = false;
      try {
        let processingReady = true;
        try {
          const opened = await this.storage.open(stored.key);
          opened.stream.destroy();
        } catch {
          processingReady = false;
        }
        const materialId = randomUUID();
        const materialData = {
          id: materialId,
          type: input.type,
          status: processingReady ? ('READY' as const) : ('FAILED' as const),
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
        };
        const workspace = await this.repository.workspace(projectId);
        if (!workspace) throw notFound();
        const result = processingReady
          ? await this.repository.createMaterialWithArtifact(
              projectId,
              draft.id,
              productId,
              input.expectedRevision,
              materialData,
              this.workingMaterialProjection(workspace, product, {
                id: materialId,
                type: input.type,
                originalFileName: materialData.originalFileName,
                mimeType: materialData.mimeType,
                sizeBytes: materialData.sizeBytes,
                storageKey: materialData.storageKey,
              }),
            )
          : {
              material: await this.repository.createMaterial(
                projectId,
                draft.id,
                productId,
                input.expectedRevision,
                materialData,
              ),
              previousArtifactStorageKey: null,
            };
        const material = result?.material;
        if (!material) throw conflict();
        databaseCommitted = true;
        return {
          material: this.material(material, modeValue),
          revision: input.expectedRevision + 1,
        };
      } catch (error) {
        if (!databaseCommitted)
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
    const product = await this.repository.product(projectId, draft.id, productId);
    if (!current || !product) throw notFound();
    const productName = requiredProductName(product.name, '请先填写产品名称，再重新上传资料');
    const project = await this.projectService.get(projectId);
    try {
      const validFile = await this.assertMaterialFile(file, current.type);
      let stored: { key: string; sizeBytes: number } | null = null;
      try {
        stored = await this.storage.put({
          projectId,
          stream: createReadStream(validFile.path),
          sizeBytes: validFile.size,
          contentType: safeMime(validFile.mimetype),
          keyContext: {
            projectName: project.name,
            workflow: 'EFFECT',
            lifecycle: 'staging',
            productId,
            productName,
            category: current.type === 'PRODUCT_IMAGE' ? '商品图片' : '产品文档',
            originalFileName: safeFileName(validFile.originalname),
          },
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
      let databaseCommitted = false;
      try {
        let processingReady = true;
        try {
          const opened = await this.storage.open(stored.key);
          opened.stream.destroy();
        } catch {
          processingReady = false;
        }
        if (!processingReady)
          throw new ApiHttpException(
            '新文件校验失败，原资料已保留，请重新上传',
            HttpStatus.INTERNAL_SERVER_ERROR,
            'INTERNAL_ERROR',
          );
        const workspace = await this.repository.workspace(projectId);
        if (!workspace) throw notFound();
        const materialData = {
          status: 'READY' as const,
          originalFileName: safeFileName(validFile.originalname),
          mimeType: safeMime(validFile.mimetype),
          sizeBytes: stored.sizeBytes,
          storageKey: stored.key,
          failureDisposition: null,
          errorCode: null,
          errorMessage: null,
          retryCount: { increment: 1 },
        };
        const result = await this.repository.replaceMaterialWithArtifact(
          projectId,
          draft.id,
          productId,
          materialId,
          expectedRevision,
          materialData,
          this.workingMaterialProjection(workspace, product, {
            id: materialId,
            type: current.type,
            originalFileName: materialData.originalFileName,
            mimeType: materialData.mimeType,
            sizeBytes: materialData.sizeBytes,
            storageKey: materialData.storageKey,
          }),
        );
        const material = result?.material;
        if (!material) throw conflict();
        databaseCommitted = true;
        const replacedKeys = new Set(
          [current.storageKey, result.previousArtifactStorageKey].filter((key): key is string =>
            Boolean(key && key !== stored.key),
          ),
        );
        for (const key of replacedKeys)
          await this.deleteOrQueue(projectId, key, 'MATERIAL_REPLACED');
        return {
          material: this.material(material, modeValue),
          revision: expectedRevision + 1,
        };
      } catch (error) {
        if (!databaseCommitted)
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
    await this.removeCurrentMaterial(projectId, draft.id, materialId);
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
      originalFileName: safeFileName(material.originalFileName),
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
      originalFileName: safeFileName(record.originalFileName),
      rowCount: record.rowCount,
      rows: parseJson(record.previewRows),
      stagedFiles: record.stagedFiles.map((file) => ({
        id: file.id,
        projectId: file.projectId,
        manifestImportId: file.manifestImportId,
        originalFileName: safeFileName(file.originalFileName),
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
    const project = await this.projectService.get(projectId);
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
          projectId,
          stream: createReadStream(file.path),
          sizeBytes: file.size,
          contentType: safeMime(file.mimetype),
          keyContext: {
            projectName: project.name,
            workflow: 'EFFECT',
            lifecycle: 'manifest',
            category: '清单配套文件',
            originalFileName: safeFileName(file.originalname),
          },
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
      const example = ['https://example.com/item/1', 'front.jpg|back.jpg', 'manual.pdf'];
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
    sheet.addRow(['https://example.com/item/1', 'front.jpg|back.jpg', 'manual.pdf']);
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
      if (!normalizeProductName(product.name))
        issues.push(
          validationIssue('REQUIRED_FIELD', '请填写产品名称', 'PRODUCT', {
            productId: product.id,
            field: 'name',
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
