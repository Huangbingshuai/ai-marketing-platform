import { DEFAULT_EFFECT_VIDEO_CONFIG, type EffectImportDraft } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { StoragePort } from '../../../platform/file/storage.port';
import type { ProjectService } from '../../../platform/project/project.service';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { EffectSourceImportRepository } from './effect-source-import.repository';
import {
  EFFECT_MANIFEST_UPLOAD_TOTAL_BYTES,
  EffectSourceImportService,
  normalizeMultipartFileName,
} from './effect-source-import.service';

const serviceWith = (
  repository: Partial<EffectSourceImportRepository> = {},
  storage: Partial<StoragePort> = {},
  workingService: Partial<WorkflowWorkingService> = {},
) =>
  new EffectSourceImportService(
    {
      expireManifestPreviews: vi.fn().mockResolvedValue([]),
      storageCleanupTasks: vi.fn().mockResolvedValue([]),
      isStorageHeld: vi.fn().mockResolvedValue(false),
      enqueueStorageCleanup: vi.fn().mockResolvedValue(undefined),
      deleteStorageCleanup: vi.fn().mockResolvedValue(undefined),
      failStorageCleanup: vi.fn().mockResolvedValue(undefined),
      ...repository,
    } as EffectSourceImportRepository,
    {
      exists: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockResolvedValue({ id: 'project-1', name: '测试项目' }),
    } as unknown as ProjectService,
    workingService as WorkflowWorkingService,
    storage as StoragePort,
  );

describe('normalizeMultipartFileName', () => {
  it('recovers UTF-8 Chinese file names decoded as latin1 by multipart parsing', () => {
    const mojibake = Buffer.from('广式腊肠_主图.png', 'utf8').toString('latin1');

    expect(normalizeMultipartFileName(mojibake)).toBe('广式腊肠_主图.png');
  });

  it('keeps file names that are already valid Unicode or latin1 text', () => {
    expect(normalizeMultipartFileName('广式腊肠_主图.png')).toBe('广式腊肠_主图.png');
    expect(normalizeMultipartFileName('café.png')).toBe('café.png');
  });
});

const draftValue = (overrides: Partial<EffectImportDraft> = {}): EffectImportDraft => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  mode: 'BATCH',
  status: 'VALID',
  revision: 3,
  validatedRevision: 3,
  productCount: 0,
  issueCount: 0,
  completedAt: null,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  globalConfig: DEFAULT_EFFECT_VIDEO_CONFIG,
  validationIssues: [],
  products: [],
  ...overrides,
});

const publishableDraft = (): EffectImportDraft =>
  draftValue({
    productCount: 1,
    products: [
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        draftId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: '产品',
        category: '食品',
        sku: 'SKU-1',
        normalizedSku: 'SKU-1',
        commerceUrl: null,
        configOverride: {},
        effectiveConfig: DEFAULT_EFFECT_VIDEO_CONFIG,
        sortOrder: 0,
        sourceManifestImportId: null,
        sourceManifestRowNumber: null,
        materials: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            productId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            type: 'PRODUCT_IMAGE',
            status: 'READY',
            expectedFileName: null,
            originalFileName: 'front.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 3,
            contentUrl: '/content',
            failureDisposition: null,
            errorCode: null,
            errorMessage: null,
            retryCount: 0,
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
        ],
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      },
    ],
  });

describe('EffectSourceImportService', () => {
  it('caps the manifest and companion aggregate budget at 522 MiB', () => {
    expect(EFFECT_MANIFEST_UPLOAD_TOTAL_BYTES).toBe(522 * 1024 * 1024);
  });

  it('生成只包含商品图片和产品文档的标准清单模板', async () => {
    const template = await serviceWith().template('csv');
    const [header, example] = template.buffer
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .split('\r\n');

    expect(header).toBe('电商链接,商品图片,产品文档');
    expect(example?.split(',')).toHaveLength(3);
  });

  it('把产品名称作为资料导入节点必填项，品类仍交给 AI 提炼', () => {
    const service = serviceWith() as unknown as {
      collectValidation(draft: EffectImportDraft): Array<{ field?: string | null }>;
    };
    const draft = publishableDraft();
    draft.products[0]!.name = '';
    draft.products[0]!.category = '';

    expect(service.collectValidation(draft)).toEqual([
      expect.objectContaining({
        code: 'REQUIRED_FIELD',
        field: 'name',
        productId: draft.products[0]!.id,
      }),
    ]);
  });

  it('rejects a material upload before the product has a name', async () => {
    const service = serviceWith({
      product: vi.fn().mockResolvedValue({ id: 'product-1', name: '   ' }),
    });
    vi.spyOn(service, 'getDraft').mockResolvedValue(draftValue());

    await expect(
      service.uploadMaterial(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'BATCH',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        { type: 'PRODUCT_IMAGE', expectedRevision: 3 },
        undefined,
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_ERROR', message: '请先填写产品名称，再上传产品资料' },
    });
  });

  it('accepts only absolute HTTP(S) commerce links without credentials', () => {
    const service = serviceWith();
    expect(service.validateLink(' https://shop.example.com/item/1#details ')).toMatchObject({
      valid: true,
      normalizedUrl: 'https://shop.example.com/item/1',
    });
    expect(service.validateLink('javascript:alert(1)').valid).toBe(false);
    expect(service.validateLink('https://user:secret@example.com/item').valid).toBe(false);
    expect(service.validateLink('/relative/item').valid).toBe(false);
  });

  it('returns an atomically initialized workspace containing both draft modes', async () => {
    const now = new Date('2026-08-20T00:00:00.000Z');
    const draft = (mode: 'SINGLE' | 'BATCH') => ({
      id: `${mode === 'SINGLE' ? '11111111' : '22222222'}-1111-4111-8111-111111111111`,
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      mode,
      status: 'DRAFT' as const,
      globalConfig: DEFAULT_EFFECT_VIDEO_CONFIG,
      revision: 1,
      validatedRevision: null,
      validationIssues: [],
      validatedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      _count: { products: 0 },
    });
    const initialize = vi.fn().mockResolvedValue({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workflowRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      currentMode: 'SINGLE',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      drafts: [draft('SINGLE'), draft('BATCH')],
    });
    const service = serviceWith({ initialize } as Partial<EffectSourceImportRepository>);

    const result = await service.getWorkspace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    expect(Object.keys(result.workspace.drafts).sort()).toEqual(['BATCH', 'SINGLE']);
    expect(result.workspace.nodeStatuses).toEqual({
      SOURCE_IMPORT: 'CURRENT',
      AI_INFO_EXTRACTION: 'LOCKED',
    });
    expect(initialize).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      DEFAULT_EFFECT_VIDEO_CONFIG,
    );
  });

  it('validates a link only after the product is found in the scoped project draft', async () => {
    const product = vi.fn().mockResolvedValue(null);
    const service = serviceWith({ product });
    vi.spyOn(service, 'getDraft').mockResolvedValue(draftValue());

    await expect(
      service.validateLinkScoped(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'BATCH',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'https://example.com',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(product).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
  });

  it('reprocesses retained failed content before marking it ready', async () => {
    const retryMaterials = vi.fn().mockResolvedValue([
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        productId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        status: 'FAILED',
        failureDisposition: 'RETRYABLE',
        storageKey: 'retained/object',
      },
    ]);
    const finishMaterialRetry = vi.fn().mockResolvedValue({ count: 1 });
    const stream = { destroy: vi.fn() };
    const service = serviceWith(
      { retryMaterials, finishMaterialRetry },
      { open: vi.fn().mockResolvedValue({ stream }) },
    );
    vi.spyOn(service, 'getDraft').mockResolvedValue(draftValue());

    const result = await service.batchRetry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'BATCH',
      ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
      3,
    );

    expect(stream.destroy).toHaveBeenCalled();
    expect(finishMaterialRetry).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      true,
    );
    expect(result.results[0]?.status).toBe('RETRYING');
  });

  it('keeps the READY material and old object when replacement storage fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'effect-replace-'));
    const path = join(directory, 'front.jpg');
    await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]));
    const current = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      productId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'PRODUCT_IMAGE' as const,
      status: 'READY' as const,
      expectedFileName: null,
      originalFileName: 'old.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      storageKey: 'old/storage-object',
      failureDisposition: null,
      errorCode: null,
      errorMessage: null,
      retryCount: 0,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
      updatedAt: new Date('2026-08-20T00:00:00.000Z'),
    };
    const replaceMaterial = vi.fn();
    const deleteObject = vi.fn();
    const service = serviceWith(
      {
        material: vi.fn().mockResolvedValue(current),
        product: vi.fn().mockResolvedValue({ id: current.productId, name: '产品' }),
        replaceMaterial,
      },
      {
        put: vi.fn().mockRejectedValue(new Error('storage unavailable')),
        delete: deleteObject,
      },
    );
    vi.spyOn(service, 'getDraft').mockResolvedValue(draftValue());

    try {
      await expect(
        service.replaceMaterial(current.projectId, 'BATCH', current.productId, current.id, 3, {
          path,
          originalname: 'new.jpg',
          mimetype: 'image/jpeg',
          size: 24,
        }),
      ).rejects.toMatchObject({
        status: 500,
        response: { code: 'STORAGE_WRITE_FAILED' },
      });
      expect(replaceMaterial).not.toHaveBeenCalled();
      expect(deleteObject).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the old material and removes only the new object when replacement verification fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'effect-replace-verify-'));
    const path = join(directory, 'front.jpg');
    await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]));
    const current = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      productId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'PRODUCT_IMAGE' as const,
      status: 'READY' as const,
      storageKey: '01-working/old.jpg',
    };
    const replaceMaterialWithArtifact = vi.fn();
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const service = serviceWith(
      {
        material: vi.fn().mockResolvedValue(current),
        product: vi.fn().mockResolvedValue({ id: current.productId, name: '产品' }),
        replaceMaterialWithArtifact,
      },
      {
        put: vi.fn().mockResolvedValue({ key: '01-working/new.jpg', sizeBytes: 24 }),
        open: vi.fn().mockRejectedValue(new Error('cannot read stored object')),
        delete: deleteObject,
      },
    );
    vi.spyOn(service, 'getDraft').mockResolvedValue(draftValue());

    try {
      await expect(
        service.replaceMaterial(current.projectId, 'BATCH', current.productId, current.id, 3, {
          path,
          originalname: 'new.jpg',
          mimetype: 'image/jpeg',
          size: 24,
        }),
      ).rejects.toMatchObject({ status: 500 });
      expect(replaceMaterialWithArtifact).not.toHaveBeenCalled();
      expect(deleteObject).toHaveBeenCalledWith('01-working/new.jpg');
      expect(deleteObject).not.toHaveBeenCalledWith('01-working/old.jpg');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects RIFF without WEBP and legacy DOC without OLE signatures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'effect-signature-'));
    const riffPath = join(directory, 'fake.webp');
    const docPath = join(directory, 'fake.doc');
    await writeFile(riffPath, Buffer.from('RIFF0000WAVE0000'));
    await writeFile(docPath, Buffer.from('plain text document'));
    const service = serviceWith();
    const assertFile = (
      service as unknown as {
        assertMaterialFile: (
          file: { path: string; originalname: string; mimetype: string; size: number },
          type: 'PRODUCT_IMAGE' | 'PRODUCT_DOCUMENT',
        ) => Promise<unknown>;
      }
    ).assertMaterialFile.bind(service);
    try {
      await expect(
        assertFile(
          { path: riffPath, originalname: 'fake.webp', mimetype: 'image/webp', size: 16 },
          'PRODUCT_IMAGE',
        ),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        assertFile(
          { path: docPath, originalname: 'fake.doc', mimetype: 'application/msword', size: 19 },
          'PRODUCT_DOCUMENT',
        ),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts PSD/Excel sources and rejects retired material categories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'effect-standardized-material-'));
    const psdPath = join(directory, 'hero.psd');
    const xlsxPath = join(directory, 'product.xlsx');
    await writeFile(psdPath, Buffer.concat([Buffer.from('8BPS'), Buffer.alloc(12)]));
    await writeFile(xlsxPath, Buffer.concat([Buffer.from('PK'), Buffer.alloc(14)]));
    const service = serviceWith();
    const assertFile = (
      service as unknown as {
        assertMaterialFile: (
          file: { path: string; originalname: string; mimetype: string; size: number } | undefined,
          type: 'BRAND_GUIDELINE' | 'PRODUCT_DOCUMENT' | 'PRODUCT_IMAGE' | 'REFERENCE_VIDEO',
        ) => Promise<unknown>;
      }
    ).assertMaterialFile.bind(service);
    try {
      await expect(
        assertFile(
          {
            path: psdPath,
            originalname: 'hero.psd',
            mimetype: 'image/vnd.adobe.photoshop',
            size: 16,
          },
          'PRODUCT_IMAGE',
        ),
      ).resolves.toBeDefined();
      await expect(
        assertFile(
          {
            path: xlsxPath,
            originalname: 'product.xlsx',
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 16,
          },
          'PRODUCT_DOCUMENT',
        ),
      ).resolves.toBeDefined();
      await expect(assertFile(undefined, 'BRAND_GUIDELINE')).rejects.toMatchObject({
        status: 400,
        response: { code: 'FILE_TYPE_UNSUPPORTED' },
      });
      await expect(assertFile(undefined, 'REFERENCE_VIDEO')).rejects.toMatchObject({
        status: 400,
        response: { code: 'FILE_TYPE_UNSUPPORTED' },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists deferred cleanup instead of deleting an object held by a publish snapshot', async () => {
    const enqueueStorageCleanup = vi.fn().mockResolvedValue(undefined);
    const deleteObject = vi.fn();
    const service = serviceWith(
      {
        isStorageHeld: vi.fn().mockResolvedValue(true),
        enqueueStorageCleanup,
      },
      { delete: deleteObject },
    );
    const deleteOrQueue = (
      service as unknown as {
        deleteOrQueue: (projectId: string, storageKey: string, reason: string) => Promise<void>;
      }
    ).deleteOrQueue.bind(service);

    await deleteOrQueue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'held/source', 'MATERIAL_DELETED');

    expect(deleteObject).not.toHaveBeenCalled();
    expect(enqueueStorageCleanup).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'held/source',
      'MATERIAL_DELETED',
    );
  });
});
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
