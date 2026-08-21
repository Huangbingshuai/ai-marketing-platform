import type { EffectImportMode, EffectVideoConfig } from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  type EffectImportDraft,
  type EffectImportMaterial,
  type EffectImportProduct,
  type EffectImportPublishOperation,
  type EffectManifestImport,
  type EffectManifestStagedFile,
} from '../../../generated/prisma/client';

import { PrismaService } from '../../../database/prisma.service';

const draftInclude = {
  products: {
    include: { materials: true },
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
  },
};

export type EffectDraftRecord = EffectImportDraft & { products: EffectProductRecord[] };
export type EffectWorkspaceRecord = Prisma.EffectImportWorkspaceGetPayload<{
  include: { drafts: { include: { _count: { select: { products: true } } } } };
}>;
export type EffectProductRecord = EffectImportProduct & { materials: EffectImportMaterial[] };
export type ManifestRecord = EffectManifestImport & { stagedFiles: EffectManifestStagedFile[] };
export type PublishOperationClaim = {
  operation: EffectImportPublishOperation;
  owner: boolean;
  requestMatches: boolean;
};
export type PublishDraftSnapshot = {
  id: string;
  projectId: string;
  mode: EffectImportMode;
  revision: number;
  globalConfig: unknown;
  products: Array<{
    id: string;
    name: string;
    category: string;
    sku: string;
    commerceUrl: string | null;
    configOverride: unknown;
    materials: Array<{
      id: string;
      type: EffectImportMaterial['type'];
      status: EffectImportMaterial['status'];
      originalFileName: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      storageKey: string | null;
    }>;
  }>;
};

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

class ManifestCommitRevisionConflict extends Error {}
class PublishCompletionConflict extends Error {}

@Injectable()
export class EffectSourceImportRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async initialize(projectId: string, config: EffectVideoConfig): Promise<EffectWorkspaceRecord> {
    return this.prisma.$transaction(async (transaction) => {
      const workspace = await transaction.effectImportWorkspace.upsert({
        where: { projectId },
        create: { projectId },
        update: {},
      });
      await transaction.effectImportDraft.createMany({
        data: (['SINGLE', 'BATCH'] as const).map((mode) => ({
          projectId,
          workspaceId: workspace.id,
          mode,
          globalConfig: json(config),
          validationIssues: json([]),
        })),
        skipDuplicates: true,
      });
      return transaction.effectImportWorkspace.findUniqueOrThrow({
        where: { projectId },
        include: { drafts: { include: { _count: { select: { products: true } } } } },
      });
    });
  }

  workspace(projectId: string): Promise<EffectWorkspaceRecord | null> {
    return this.prisma.effectImportWorkspace.findUnique({
      where: { projectId },
      include: { drafts: { include: { _count: { select: { products: true } } } } },
    });
  }

  async switchMode(
    projectId: string,
    mode: EffectImportMode,
    expectedRevision: number,
  ): Promise<EffectWorkspaceRecord | null> {
    const result = await this.prisma.effectImportWorkspace.updateMany({
      where: { projectId, revision: expectedRevision },
      data: { currentMode: mode, revision: { increment: 1 } },
    });
    return result.count === 0 ? null : this.workspace(projectId);
  }

  draft(projectId: string, mode: EffectImportMode): Promise<EffectDraftRecord | null> {
    return this.prisma.effectImportDraft.findUnique({
      where: { projectId_mode: { projectId, mode } },
      include: draftInclude,
    });
  }

  async updateConfig(
    projectId: string,
    mode: EffectImportMode,
    expectedRevision: number,
    globalConfig: EffectVideoConfig,
  ): Promise<EffectDraftRecord | null> {
    const result = await this.prisma.effectImportDraft.updateMany({
      where: { projectId, mode, revision: expectedRevision },
      data: {
        globalConfig: json(globalConfig),
        revision: { increment: 1 },
        validatedRevision: null,
        validationIssues: json([]),
        validatedAt: null,
        status: 'DRAFT',
        completedAt: null,
      },
    });
    return result.count === 0 ? null : this.draft(projectId, mode);
  }

  async listProducts(
    projectId: string,
    draftId: string,
    query: { keyword?: string; category?: string; skip: number; take: number },
  ): Promise<{ items: EffectProductRecord[]; total: number; categories: string[] }> {
    const keyword = query.keyword?.trim();
    const where: Prisma.EffectImportProductWhereInput = {
      projectId,
      draftId,
      ...(query.category?.trim() ? { category: query.category.trim() } : {}),
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword, mode: 'insensitive' } },
              { category: { contains: keyword, mode: 'insensitive' } },
              { sku: { contains: keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total, categoryRecords] = await Promise.all([
      this.prisma.effectImportProduct.findMany({
        where,
        include: { materials: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.effectImportProduct.count({ where }),
      this.prisma.effectImportProduct.findMany({
        where: { projectId, draftId, category: { not: '' } },
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' },
      }),
    ]);
    return { items, total, categories: categoryRecords.map((item) => item.category) };
  }

  product(
    projectId: string,
    draftId: string,
    productId: string,
  ): Promise<EffectProductRecord | null> {
    return this.prisma.effectImportProduct.findFirst({
      where: { projectId, draftId, id: productId },
      include: { materials: true },
    });
  }

  async createProduct(
    projectId: string,
    draftId: string,
    expectedRevision: number,
    data: Pick<
      EffectImportProduct,
      'name' | 'category' | 'sku' | 'normalizedSku' | 'commerceUrl'
    > & {
      configOverride: Prisma.InputJsonValue;
    },
  ): Promise<EffectProductRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const bumped = await transaction.effectImportDraft.updateMany({
        where: { projectId, id: draftId, revision: expectedRevision },
        data: {
          revision: { increment: 1 },
          validatedRevision: null,
          validationIssues: json([]),
          validatedAt: null,
          status: 'DRAFT',
          completedAt: null,
        },
      });
      if (bumped.count === 0) return null;
      const tail = await transaction.effectImportProduct.aggregate({
        where: { projectId, draftId },
        _max: { sortOrder: true },
      });
      return transaction.effectImportProduct.create({
        data: { projectId, draftId, ...data, sortOrder: (tail._max.sortOrder ?? -1) + 1 },
        include: { materials: true },
      });
    });
  }

  async updateProduct(
    projectId: string,
    draftId: string,
    productId: string,
    expectedRevision: number,
    data: Prisma.EffectImportProductUncheckedUpdateInput,
  ): Promise<EffectProductRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const exists = await transaction.effectImportProduct.count({
        where: { projectId, draftId, id: productId },
      });
      if (exists === 0) return null;
      const bumped = await transaction.effectImportDraft.updateMany({
        where: { projectId, id: draftId, revision: expectedRevision },
        data: {
          revision: { increment: 1 },
          validatedRevision: null,
          validationIssues: json([]),
          validatedAt: null,
          status: 'DRAFT',
          completedAt: null,
        },
      });
      if (bumped.count === 0) return null;
      return transaction.effectImportProduct.update({
        where: { projectId_id: { projectId, id: productId } },
        data,
        include: { materials: true },
      });
    });
  }

  async deleteProducts(
    projectId: string,
    draftId: string,
    productIds: string[],
    expectedRevision: number,
  ): Promise<{ deletedIds: string[]; storageKeys: string[]; revision: number } | null> {
    return this.prisma.$transaction(async (transaction) => {
      const products = await transaction.effectImportProduct.findMany({
        where: { projectId, draftId, id: { in: productIds } },
        select: { id: true, materials: { select: { storageKey: true } } },
      });
      const deletedIds = products.map((item) => item.id);
      if (deletedIds.length === 0) return null;
      const bumped = await transaction.effectImportDraft.updateMany({
        where: { projectId, id: draftId, revision: expectedRevision },
        data: {
          revision: { increment: 1 },
          validatedRevision: null,
          validationIssues: json([]),
          validatedAt: null,
          status: 'DRAFT',
          completedAt: null,
        },
      });
      if (bumped.count === 0) return null;
      await transaction.effectImportProduct.deleteMany({
        where: { projectId, draftId, id: { in: deletedIds } },
      });
      return {
        deletedIds,
        storageKeys: products.flatMap((item) => item.materials.flatMap((m) => m.storageKey ?? [])),
        revision: expectedRevision + 1,
      };
    });
  }

  material(
    projectId: string,
    productId: string,
    materialId: string,
  ): Promise<EffectImportMaterial | null> {
    return this.prisma.effectImportMaterial.findFirst({
      where: { projectId, productId, id: materialId },
    });
  }

  async createMaterial(
    projectId: string,
    draftId: string,
    productId: string,
    expectedRevision: number,
    data: Prisma.EffectImportMaterialUncheckedCreateWithoutProductInput,
  ): Promise<EffectImportMaterial | null> {
    return this.prisma.$transaction(async (transaction) => {
      if (
        (await transaction.effectImportProduct.count({
          where: { projectId, draftId, id: productId },
        })) === 0
      )
        return null;
      const bumped = await transaction.effectImportDraft.updateMany({
        where: { projectId, id: draftId, revision: expectedRevision },
        data: {
          revision: { increment: 1 },
          validatedRevision: null,
          validationIssues: json([]),
          validatedAt: null,
          status: 'DRAFT',
          completedAt: null,
        },
      });
      if (bumped.count === 0) return null;
      return transaction.effectImportMaterial.create({ data: { ...data, projectId, productId } });
    });
  }

  async replaceMaterial(
    projectId: string,
    draftId: string,
    productId: string,
    materialId: string,
    expectedRevision: number,
    data: Prisma.EffectImportMaterialUncheckedUpdateInput,
  ): Promise<EffectImportMaterial | null> {
    return this.prisma.$transaction(async (transaction) => {
      if (
        (await transaction.effectImportMaterial.count({
          where: { projectId, productId, id: materialId, product: { draftId } },
        })) === 0
      )
        return null;
      const bumped = await transaction.effectImportDraft.updateMany({
        where: { projectId, id: draftId, revision: expectedRevision },
        data: {
          revision: { increment: 1 },
          validatedRevision: null,
          validationIssues: json([]),
          validatedAt: null,
          status: 'DRAFT',
          completedAt: null,
        },
      });
      if (bumped.count === 0) return null;
      return transaction.effectImportMaterial.update({
        where: { projectId_id: { projectId, id: materialId } },
        data,
      });
    });
  }

  async deleteMaterial(
    projectId: string,
    draftId: string,
    productId: string,
    materialId: string,
    expectedRevision: number,
  ): Promise<{ storageKey: string | null; revision: number } | null> {
    return this.prisma.$transaction(async (transaction) => {
      const material = await transaction.effectImportMaterial.findFirst({
        where: { projectId, productId, id: materialId, product: { draftId } },
      });
      if (!material) return null;
      const bumped = await transaction.effectImportDraft.updateMany({
        where: { projectId, id: draftId, revision: expectedRevision },
        data: {
          revision: { increment: 1 },
          validatedRevision: null,
          validationIssues: json([]),
          validatedAt: null,
          status: 'DRAFT',
          completedAt: null,
        },
      });
      if (bumped.count === 0) return null;
      await transaction.effectImportMaterial.delete({
        where: { projectId_id: { projectId, id: materialId } },
      });
      return { storageKey: material.storageKey, revision: expectedRevision + 1 };
    });
  }

  async saveValidation(
    projectId: string,
    draftId: string,
    expectedRevision: number,
    issues: unknown[],
  ): Promise<EffectDraftRecord | null> {
    const result = await this.prisma.effectImportDraft.updateMany({
      where: { projectId, id: draftId, revision: expectedRevision },
      data: {
        validatedRevision: issues.length === 0 ? expectedRevision : null,
        validationIssues: json(issues),
        validatedAt: new Date(),
        status: issues.length === 0 ? 'VALID' : 'DRAFT',
      },
    });
    return result.count === 0
      ? null
      : this.draft(
          projectId,
          (
            await this.prisma.effectImportDraft.findFirstOrThrow({
              where: { projectId, id: draftId },
              select: { mode: true },
            })
          ).mode,
        );
  }

  async markCompleted(projectId: string, draftId: string, revision: number): Promise<boolean> {
    const result = await this.prisma.effectImportDraft.updateMany({
      where: { projectId, id: draftId, revision, validatedRevision: revision },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    return result.count === 1;
  }

  manifestByIdempotency(
    projectId: string,
    draftId: string,
    key: string,
  ): Promise<ManifestRecord | null> {
    return this.prisma.effectManifestImport.findFirst({
      where: { projectId, draftId, idempotencyKey: key },
      include: { stagedFiles: true },
    });
  }

  createManifest(
    projectId: string,
    draftId: string,
    input: Omit<Prisma.EffectManifestImportUncheckedCreateInput, 'projectId' | 'draftId'>,
  ): Promise<ManifestRecord> {
    return this.prisma.effectManifestImport.create({
      data: { ...input, projectId, draftId },
      include: { stagedFiles: true },
    });
  }

  async createManifestWithFiles(
    projectId: string,
    draftId: string,
    input: Omit<Prisma.EffectManifestImportUncheckedCreateInput, 'projectId' | 'draftId'>,
    files: Prisma.EffectManifestStagedFileCreateManyInput[],
  ): Promise<ManifestRecord> {
    return this.prisma.$transaction(async (transaction) => {
      const manifest = await transaction.effectManifestImport.create({
        data: { ...input, projectId, draftId },
      });
      if (files.length > 0) await transaction.effectManifestStagedFile.createMany({ data: files });
      return transaction.effectManifestImport.findUniqueOrThrow({
        where: { projectId_id: { projectId, id: manifest.id } },
        include: { stagedFiles: true },
      });
    });
  }

  manifest(projectId: string, draftId: string, id: string): Promise<ManifestRecord | null> {
    return this.prisma.effectManifestImport.findFirst({
      where: { projectId, draftId, id },
      include: { stagedFiles: true },
    });
  }

  createStagedFiles(
    data: Prisma.EffectManifestStagedFileCreateManyInput[],
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.effectManifestStagedFile.createMany({ data });
  }

  async commitManifest(
    projectId: string,
    draftId: string,
    importId: string,
    expectedRevision: number,
    commitIdempotencyKey: string,
    rows: Array<{
      rowNumber: number;
      name: string;
      category: string;
      sku: string;
      normalizedSku: string;
      commerceUrl: string | null;
      materials: Array<{
        type: EffectImportMaterial['type'];
        expectedFileName: string;
        stagedFileId: string | null;
      }>;
    }>,
  ): Promise<{ productIds: string[]; revision: number; cleanupStorageKeys: string[] } | null> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const claimed = await transaction.effectManifestImport.updateMany({
          where: {
            projectId,
            draftId,
            id: importId,
            status: 'PREVIEW',
            expiresAt: { gt: new Date() },
          },
          data: { status: 'COMMITTED', committedAt: new Date(), commitIdempotencyKey },
        });
        if (claimed.count === 0) return null;
        const bumped = await transaction.effectImportDraft.updateMany({
          where: { projectId, id: draftId, revision: expectedRevision },
          data: {
            revision: { increment: 1 },
            validatedRevision: null,
            validationIssues: json([]),
            validatedAt: null,
            status: 'DRAFT',
            completedAt: null,
          },
        });
        // Returning null would commit the manifest claim. Throw so Prisma rolls the
        // complete transaction back when the optimistic draft revision lost.
        if (bumped.count === 0) throw new ManifestCommitRevisionConflict();
        const tail = await transaction.effectImportProduct.aggregate({
          where: { projectId, draftId },
          _max: { sortOrder: true },
        });
        let order = (tail._max.sortOrder ?? -1) + 1;
        const productIds: string[] = [];
        for (const row of rows) {
          const product = await transaction.effectImportProduct.create({
            data: {
              projectId,
              draftId,
              name: row.name,
              category: row.category,
              sku: row.sku,
              normalizedSku: row.normalizedSku,
              commerceUrl: row.commerceUrl,
              configOverride: json({}),
              sortOrder: order++,
              sourceManifestImportId: importId,
              sourceManifestRowNumber: row.rowNumber,
            },
          });
          productIds.push(product.id);
          for (const material of row.materials) {
            const staged = material.stagedFileId
              ? await transaction.effectManifestStagedFile.findFirst({
                  where: {
                    projectId,
                    manifestImportId: importId,
                    id: material.stagedFileId,
                    transferredAt: null,
                  },
                })
              : null;
            await transaction.effectImportMaterial.create({
              data: staged
                ? {
                    projectId,
                    productId: product.id,
                    type: material.type,
                    status: 'READY',
                    expectedFileName: material.expectedFileName,
                    originalFileName: staged.originalFileName,
                    mimeType: staged.mimeType,
                    sizeBytes: staged.sizeBytes,
                    storageKey: staged.storageKey,
                  }
                : {
                    projectId,
                    productId: product.id,
                    type: material.type,
                    status: 'MISSING',
                    expectedFileName: material.expectedFileName,
                    failureDisposition: 'REQUIRES_NEW_FILE',
                    errorCode: 'FILE_MATCH_NOT_FOUND',
                    errorMessage: '清单引用的文件未匹配',
                  },
            });
            if (staged)
              await transaction.effectManifestStagedFile.update({
                where: { projectId_id: { projectId, id: staged.id } },
                data: { transferredAt: new Date() },
              });
          }
        }
        const cleanup = await transaction.effectManifestStagedFile.findMany({
          where: { projectId, manifestImportId: importId, transferredAt: null },
          select: { storageKey: true },
        });
        return {
          productIds,
          revision: expectedRevision + 1,
          cleanupStorageKeys: cleanup.map((item) => item.storageKey),
        };
      });
    } catch (error) {
      if (error instanceof ManifestCommitRevisionConflict) return null;
      throw error;
    }
  }

  async cancelManifest(
    projectId: string,
    draftId: string,
    importId: string,
  ): Promise<ManifestRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const cancelled = await transaction.effectManifestImport.updateMany({
        where: { projectId, draftId, id: importId, status: 'PREVIEW' },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      if (cancelled.count === 0) return null;
      return transaction.effectManifestImport.findUniqueOrThrow({
        where: { projectId_id: { projectId, id: importId } },
        include: { stagedFiles: true },
      });
    });
  }

  async expireManifestPreviews(projectId: string): Promise<EffectManifestStagedFile[]> {
    return this.prisma.$transaction(async (transaction) => {
      const expired = await transaction.effectManifestImport.findMany({
        where: { projectId, status: 'PREVIEW', expiresAt: { lte: new Date() } },
        include: { stagedFiles: true },
      });
      const ids = expired.map((item) => item.id);
      if (ids.length > 0) {
        await transaction.effectManifestImport.updateMany({
          where: { projectId, id: { in: ids }, status: 'PREVIEW' },
          data: { status: 'EXPIRED' },
        });
      }
      return transaction.effectManifestStagedFile.findMany({
        where: {
          projectId,
          transferredAt: null,
          manifestImport: { status: { in: ['EXPIRED', 'CANCELLED', 'COMMITTED'] } },
        },
      });
    });
  }

  async retryMaterials(
    projectId: string,
    draftId: string,
    productIds: string[],
    expectedRevision: number,
  ): Promise<EffectImportMaterial[] | null> {
    return this.prisma.$transaction(async (transaction) => {
      const materials = await transaction.effectImportMaterial.findMany({
        where: {
          projectId,
          productId: { in: productIds },
          product: { draftId },
          status: 'FAILED',
        },
      });
      const bumped = await transaction.effectImportDraft.updateMany({
        where: { projectId, id: draftId, revision: expectedRevision },
        data: {
          revision: { increment: 1 },
          validatedRevision: null,
          validationIssues: json([]),
          validatedAt: null,
          status: 'DRAFT',
          completedAt: null,
        },
      });
      if (bumped.count === 0) return null;
      return materials;
    });
  }

  async startPublishOperation(
    projectId: string,
    draftId: string,
    revision: number,
    idempotencyKey: string,
    attemptToken: string,
  ): Promise<PublishOperationClaim | null> {
    return this.prisma.$transaction(async (transaction) => {
      const present = async (operation: EffectImportPublishOperation) => {
        const requestMatches = operation.draftId === draftId && operation.revision === revision;
        if (!requestMatches || operation.status === 'COMPLETED') {
          return { operation, owner: false, requestMatches };
        }
        if (operation.status === 'RUNNING' && operation.attemptToken === attemptToken) {
          return { operation, owner: true, requestMatches: true };
        }
        const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
        const claimed = await transaction.effectImportPublishOperation.updateMany({
          where: {
            projectId,
            id: operation.id,
            OR: [{ status: 'FAILED' }, { status: 'RUNNING', updatedAt: { lt: staleBefore } }],
          },
          data: { status: 'RUNNING', attemptToken, errorMessage: null },
        });
        if (claimed.count !== 1) return { operation, owner: false, requestMatches: true };
        return {
          operation: await transaction.effectImportPublishOperation.findUniqueOrThrow({
            where: { projectId_id: { projectId, id: operation.id } },
          }),
          owner: true,
          requestMatches: true,
        };
      };

      const existing = await transaction.effectImportPublishOperation.findUnique({
        where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      });
      if (existing) return present(existing);

      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "effect_import_drafts"
        WHERE "projectId" = ${projectId}::uuid
          AND "id" = ${draftId}::uuid
          AND "revision" = ${revision}
          AND "validatedRevision" = ${revision}
        FOR UPDATE
      `);
      if (locked.length !== 1) return null;
      // Re-check after the row lock: another request with the same key may
      // have committed while this transaction was waiting.
      const raced = await transaction.effectImportPublishOperation.findUnique({
        where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      });
      if (raced) return present(raced);
      const lockedDraft = await transaction.effectImportDraft.findUniqueOrThrow({
        where: { projectId_id: { projectId, id: draftId } },
        include: draftInclude,
      });
      const snapshot: PublishDraftSnapshot = {
        id: lockedDraft.id,
        projectId: lockedDraft.projectId,
        mode: lockedDraft.mode,
        revision: lockedDraft.revision,
        globalConfig: lockedDraft.globalConfig,
        products: lockedDraft.products.map((product) => ({
          id: product.id,
          name: product.name,
          category: product.category,
          sku: product.sku,
          commerceUrl: product.commerceUrl,
          configOverride: product.configOverride,
          materials: product.materials.map((material) => ({
            id: material.id,
            type: material.type,
            status: material.status,
            originalFileName: material.originalFileName,
            mimeType: material.mimeType,
            sizeBytes: material.sizeBytes,
            storageKey: material.storageKey,
          })),
        })),
      };
      const operation = await transaction.effectImportPublishOperation.create({
        data: {
          projectId,
          draftId,
          revision,
          idempotencyKey,
          snapshot: json(snapshot),
          attemptToken,
          status: 'RUNNING',
        },
      });
      const heldStorageKeys = [
        ...new Set(
          snapshot.products.flatMap((product) =>
            product.materials
              .filter((material) => material.status === 'READY' && material.storageKey)
              .map((material) => material.storageKey!),
          ),
        ),
      ];
      if (heldStorageKeys.length > 0) {
        await transaction.effectImportPublishFileHold.createMany({
          data: heldStorageKeys.map((storageKey) => ({
            projectId,
            operationId: operation.id,
            storageKey,
          })),
        });
      }
      return { operation, owner: true, requestMatches: true };
    });
  }

  publishOperationByKey(projectId: string, idempotencyKey: string) {
    return this.prisma.effectImportPublishOperation.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
    });
  }

  async completePublishOperation(
    projectId: string,
    operationId: string,
    attemptToken: string,
    result: unknown,
    lastPublish: unknown,
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const operation = await transaction.effectImportPublishOperation.findFirst({
          where: { projectId, id: operationId, status: 'RUNNING', attemptToken },
        });
        if (!operation) return false;
        const draft = await transaction.effectImportDraft.updateMany({
          where: { projectId, id: operation.draftId },
          data: { lastPublish: json(lastPublish) },
        });
        if (draft.count !== 1) throw new PublishCompletionConflict();
        const updated = await transaction.effectImportPublishOperation.updateMany({
          where: { projectId, id: operationId, status: 'RUNNING', attemptToken },
          data: { status: 'COMPLETED', result: json(result), completedAt: new Date() },
        });
        if (updated.count !== 1) throw new PublishCompletionConflict();
        await transaction.effectImportPublishFileHold.deleteMany({
          where: { projectId, operationId },
        });
        return true;
      });
    } catch (error) {
      if (error instanceof PublishCompletionConflict) return false;
      throw error;
    }
  }

  enqueueStorageCleanup(projectId: string, storageKey: string, reason: string) {
    return this.prisma.storageCleanupTask.upsert({
      where: { projectId_storageKey: { projectId, storageKey } },
      create: { projectId, storageKey, reason },
      update: { reason, nextAttemptAt: new Date() },
    });
  }

  async isStorageHeld(projectId: string, storageKey: string): Promise<boolean> {
    return (
      (await this.prisma.effectImportPublishFileHold.count({ where: { projectId, storageKey } })) >
      0
    );
  }

  releaseExpiredPublishHolds(projectId: string, failedBefore: Date) {
    return this.prisma.effectImportPublishFileHold.deleteMany({
      where: {
        projectId,
        operation: { status: 'FAILED', updatedAt: { lt: failedBefore } },
      },
    });
  }

  storageCleanupTasks(projectId: string) {
    return this.prisma.storageCleanupTask.findMany({
      where: { projectId, nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  }

  deleteStorageCleanup(projectId: string, id: string) {
    return this.prisma.storageCleanupTask.deleteMany({ where: { projectId, id } });
  }

  failStorageCleanup(projectId: string, id: string, message: string) {
    return this.prisma.storageCleanupTask.updateMany({
      where: { projectId, id },
      data: {
        attempts: { increment: 1 },
        lastError: message.slice(0, 500),
        nextAttemptAt: new Date(Date.now() + 60_000),
      },
    });
  }

  async failPublishOperation(
    projectId: string,
    operationId: string,
    attemptToken: string,
    message: string,
  ): Promise<void> {
    await this.prisma.effectImportPublishOperation.updateMany({
      where: { projectId, id: operationId, status: 'RUNNING', attemptToken },
      data: { status: 'FAILED', errorMessage: message.slice(0, 500) },
    });
  }

  finishMaterialRetry(
    projectId: string,
    draftId: string,
    materialId: string,
    ready: boolean,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.effectImportMaterial.updateMany({
      where: { projectId, id: materialId, product: { draftId }, status: 'FAILED' },
      data: ready
        ? {
            status: 'READY',
            failureDisposition: null,
            errorCode: null,
            errorMessage: null,
            retryCount: { increment: 1 },
          }
        : {
            failureDisposition: 'RETRYABLE',
            errorCode: 'STORED_CONTENT_PROCESSING_FAILED',
            errorMessage: '服务端重试处理失败',
            retryCount: { increment: 1 },
          },
    });
  }
}
