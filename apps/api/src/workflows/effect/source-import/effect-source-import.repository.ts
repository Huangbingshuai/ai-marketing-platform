import { randomUUID } from 'node:crypto';

import type { EffectImportMode, EffectVideoConfig } from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type {
  Prisma,
  EffectImportDraft,
  EffectImportMaterial,
  EffectImportProduct,
  EffectManifestImport,
  EffectManifestStagedFile,
} from '../../../generated/prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  WorkflowWorkingRepository,
  type FileObjectInput,
  type WorkingArtifactUpsertInput,
  workingArtifactContentHash,
} from '../../../platform/workflow/workflow-working.repository';

const draftInclude = {
  products: {
    where: { status: 'ACTIVE' as const },
    include: { materials: { include: { fileObject: true } } },
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
  },
};

const workspaceInclude = {
  drafts: {
    include: { _count: { select: { products: { where: { status: 'ACTIVE' as const } } } } },
  },
};

export type EffectDraftRecord = EffectImportDraft & { products: EffectProductRecord[] };
export type EffectWorkspaceRecord = Prisma.EffectImportWorkspaceGetPayload<{
  include: typeof workspaceInclude;
}>;
export type EffectProductRecord = Prisma.EffectImportProductGetPayload<{
  include: { materials: { include: { fileObject: true } } };
}>;
export type EffectMaterialRecord = Prisma.EffectImportMaterialGetPayload<{
  include: { fileObject: true };
}>;
export type ManifestRecord = EffectManifestImport & { stagedFiles: EffectManifestStagedFile[] };
export type WorkingFileProjection = {
  workflowRunId: string;
  nodeId: string;
  fileObject?: FileObjectInput & { id: string };
  fileObjects?: Array<FileObjectInput & { id: string }>;
};
export type ValidatedArtifactCandidate = {
  artifactKey: string;
  input: WorkingArtifactUpsertInput;
};
const uploadSessionInclude = {
  items: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
};
export type EffectUploadSessionRecord = Prisma.EffectImportUploadSessionGetPayload<{
  include: typeof uploadSessionInclude;
}>;
const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const cleanupGraceMs = (): number =>
  Number(process.env.WORKING_FILE_CLEANUP_GRACE_HOURS ?? 24) * 60 * 60 * 1000;

class ManifestCommitRevisionConflict extends Error {}

@Injectable()
export class EffectSourceImportRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WorkflowWorkingRepository)
    private readonly workingRepository: WorkflowWorkingRepository,
  ) {}

  async initialize(projectId: string, config: EffectVideoConfig): Promise<EffectWorkspaceRecord> {
    return this.prisma.$transaction(async (transaction) => {
      let workspace = await transaction.effectImportWorkspace.findUnique({ where: { projectId } });
      if (!workspace) {
        const workflowRunId = randomUUID();
        await transaction.workflowRun.create({
          data: {
            id: workflowRunId,
            projectId,
            workflow: 'EFFECT',
            workflowSpace: 'EFFECT',
          },
        });
        workspace = await transaction.effectImportWorkspace.create({
          data: { projectId, workflowRunId },
        });
      }
      await transaction.workflowRun.update({
        where: { id: workspace.workflowRunId },
        data: { status: 'ACTIVE', lastActiveAt: new Date() },
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
        include: workspaceInclude,
      });
    });
  }

  workspace(projectId: string): Promise<EffectWorkspaceRecord | null> {
    return this.prisma.effectImportWorkspace.findUnique({
      where: { projectId },
      include: workspaceInclude,
    });
  }

  sourceWorkingArtifacts(projectId: string, workflowRunId: string) {
    return this.prisma.workingArtifact.findMany({
      where: { projectId, workflowRunId, nodeId: 'SOURCE_IMPORT' },
      select: {
        id: true,
        artifactKey: true,
        contentHash: true,
        revision: true,
        freshness: true,
        availability: true,
      },
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

  draftMode(projectId: string, draftId: string) {
    return this.prisma.effectImportDraft.findFirst({
      where: { projectId, id: draftId },
      select: { mode: true },
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
      status: 'ACTIVE',
      ...(query.category?.trim() ? { category: query.category.trim() } : {}),
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword, mode: 'insensitive' } },
              { category: { contains: keyword, mode: 'insensitive' } },
              { sku: { contains: keyword, mode: 'insensitive' } },
              { commerceUrl: { contains: keyword, mode: 'insensitive' } },
              {
                materials: {
                  some: {
                    OR: [
                      { originalFileName: { contains: keyword, mode: 'insensitive' } },
                      { expectedFileName: { contains: keyword, mode: 'insensitive' } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [items, total, categoryRecords] = await Promise.all([
      this.prisma.effectImportProduct.findMany({
        where,
        include: { materials: { include: { fileObject: true } } },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.effectImportProduct.count({ where }),
      this.prisma.effectImportProduct.findMany({
        where: { projectId, draftId, status: 'ACTIVE', category: { not: '' } },
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
      where: { projectId, draftId, id: productId, status: 'ACTIVE' },
      include: { materials: { include: { fileObject: true } } },
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
      const draft = await transaction.effectImportDraft.findFirst({
        where: { projectId, id: draftId },
        select: { workspace: { select: { workflowRunId: true } } },
      });
      if (!draft) return null;
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
        data: {
          projectId,
          workflowRunId: draft.workspace.workflowRunId,
          draftId,
          ...data,
          sortOrder: (tail._max.sortOrder ?? -1) + 1,
        },
        include: { materials: { include: { fileObject: true } } },
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
        where: { projectId, draftId, id: productId, status: 'ACTIVE' },
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
        include: { materials: { include: { fileObject: true } } },
      });
    });
  }

  async deleteProducts(
    projectId: string,
    draftId: string,
    productIds: string[],
    expectedRevision: number,
  ): Promise<{
    deletedIds: string[];
    removedProducts: Array<{ id: string; name: string; removedAt: Date; purgeAfter: Date }>;
    revision: number;
  } | null> {
    return this.prisma.$transaction(async (transaction) => {
      const removedAt = new Date();
      const purgeAfter = new Date(removedAt.getTime() + cleanupGraceMs());
      const products = await transaction.effectImportProduct.findMany({
        where: { projectId, draftId, id: { in: productIds }, status: 'ACTIVE' },
        select: {
          id: true,
          name: true,
          workflowRunId: true,
        },
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
      await transaction.effectImportProduct.updateMany({
        where: { projectId, draftId, id: { in: deletedIds }, status: 'ACTIVE' },
        data: { status: 'REMOVED', removedAt, purgeAfter },
      });
      return {
        deletedIds,
        removedProducts: products.map((product) => ({
          id: product.id,
          name: product.name,
          removedAt,
          purgeAfter,
        })),
        revision: expectedRevision + 1,
      };
    });
  }

  removedProducts(projectId: string, draftId: string) {
    return this.prisma.effectImportProduct.findMany({
      where: { projectId, draftId, status: 'REMOVED', purgeAfter: { gt: new Date() } },
      orderBy: [{ removedAt: 'desc' }, { id: 'asc' }],
      include: { materials: { include: { fileObject: true } } },
    });
  }

  async restoreProducts(
    projectId: string,
    draftId: string,
    productIds: string[],
    expectedRevision: number,
  ): Promise<{ products: EffectProductRecord[]; revision: number } | null> {
    return this.prisma.$transaction(async (transaction) => {
      const draft = await transaction.effectImportDraft.findFirst({
        where: { projectId, id: draftId },
        select: { mode: true },
      });
      if (!draft) return null;
      const removed = await transaction.effectImportProduct.findMany({
        where: {
          projectId,
          draftId,
          id: { in: [...new Set(productIds)] },
          status: 'REMOVED',
          purgeAfter: { gt: new Date() },
        },
      });
      if (removed.length !== new Set(productIds).size) return null;
      if (
        draft.mode === 'SINGLE' &&
        (await transaction.effectImportProduct.count({
          where: { projectId, draftId, status: 'ACTIVE' },
        })) > 0
      )
        throw new Error('SINGLE_ACTIVE_PRODUCT_CONFLICT');
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
      await transaction.effectImportProduct.updateMany({
        where: { projectId, draftId, id: { in: removed.map((item) => item.id) } },
        data: { status: 'ACTIVE', removedAt: null, purgeAfter: null },
      });
      const products = await transaction.effectImportProduct.findMany({
        where: { projectId, draftId, id: { in: removed.map((item) => item.id) } },
        include: { materials: { include: { fileObject: true } } },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      return { products, revision: expectedRevision + 1 };
    });
  }

  private async markDescendantsSourceRemoved(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    sourceIds: string[],
  ): Promise<void> {
    const seen = new Set(sourceIds);
    let pending = sourceIds;
    while (pending.length) {
      const links = await transaction.workingArtifactDependency.findMany({
        where: {
          projectId,
          workflowRunId,
          sourceType: 'WORKING_ARTIFACT',
          sourceArtifactId: { in: pending },
        },
        select: { dependentArtifactId: true },
      });
      const next = [...new Set(links.map((item) => item.dependentArtifactId))].filter(
        (id) => !seen.has(id),
      );
      if (!next.length) break;
      next.forEach((id) => seen.add(id));
      await transaction.workingArtifact.updateMany({
        where: { projectId, workflowRunId, id: { in: next } },
        data: { availability: 'SOURCE_REMOVED', freshness: 'STALE' },
      });
      pending = next;
    }
  }

  private async restoreDescendants(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    sourceIds: string[],
  ): Promise<void> {
    const seen = new Set(sourceIds);
    let pending = sourceIds;
    while (pending.length) {
      const links = await transaction.workingArtifactDependency.findMany({
        where: {
          projectId,
          workflowRunId,
          sourceType: 'WORKING_ARTIFACT',
          sourceArtifactId: { in: pending },
        },
        select: { dependentArtifactId: true },
      });
      const next = [...new Set(links.map((item) => item.dependentArtifactId))].filter(
        (id) => !seen.has(id),
      );
      if (!next.length) break;
      next.forEach((id) => seen.add(id));
      const artifacts = await transaction.workingArtifact.findMany({
        where: { projectId, workflowRunId, id: { in: next } },
        include: { dependencies: true },
      });
      for (const artifact of artifacts) {
        let current = true;
        let sourcesAvailable = true;
        for (const dependency of artifact.dependencies) {
          if (dependency.sourceType === 'WORKING_ARTIFACT') {
            const source = dependency.sourceArtifactId
              ? await transaction.workingArtifact.findFirst({
                  where: {
                    projectId,
                    workflowRunId,
                    id: dependency.sourceArtifactId,
                    revision: dependency.sourceRevision ?? -1,
                    availability: 'AVAILABLE',
                  },
                })
              : null;
            if (!source) {
              current = false;
              sourcesAvailable = false;
            }
          } else {
            const state = await transaction.workflowNodeState.findUnique({
              where: {
                projectId_workflowRunId_nodeId: {
                  projectId,
                  workflowRunId,
                  nodeId: dependency.sourceNodeId ?? dependency.sourceKey,
                },
              },
            });
            if (
              !state ||
              (dependency.sourceType === 'EXECUTION_INPUT'
                ? state.executionInputHash !== dependency.sourceHash
                : state.revision !== dependency.sourceRevision)
            )
              current = false;
          }
        }
        await transaction.workingArtifact.update({
          where: { id: artifact.id },
          data: {
            availability: sourcesAvailable ? 'AVAILABLE' : 'SOURCE_REMOVED',
            freshness: current ? 'CURRENT' : 'STALE',
          },
        });
      }
      pending = next;
    }
  }

  material(
    projectId: string,
    productId: string,
    materialId: string,
  ): Promise<EffectMaterialRecord | null> {
    return this.prisma.effectImportMaterial.findFirst({
      where: { projectId, productId, id: materialId },
      include: { fileObject: true },
    });
  }

  async createMaterial(
    projectId: string,
    draftId: string,
    productId: string,
    expectedRevision: number,
    data: Omit<Prisma.EffectImportMaterialUncheckedCreateWithoutProductInput, 'workflowRunId'>,
  ): Promise<EffectMaterialRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const product = await transaction.effectImportProduct.findFirst({
        where: { projectId, draftId, id: productId, status: 'ACTIVE' },
        select: { workflowRunId: true },
      });
      if (!product) return null;
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
      return transaction.effectImportMaterial.create({
        data: { ...data, projectId, workflowRunId: product.workflowRunId, productId },
        include: { fileObject: true },
      });
    });
  }

  async attachFileObject(
    projectId: string,
    workflowRunId: string,
    materialId: string,
    fileObject: FileObjectInput & { id: string },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const material = await transaction.effectImportMaterial.findFirst({
        where: {
          projectId,
          workflowRunId,
          id: materialId,
          status: 'READY',
          fileObjectId: null,
        },
      });
      if (!material) return false;
      await this.workingRepository.upsertFileObjectInTransaction(
        transaction,
        projectId,
        workflowRunId,
        fileObject,
      );
      const updated = await transaction.effectImportMaterial.updateMany({
        where: { projectId, id: materialId, fileObjectId: null },
        data: { fileObjectId: fileObject.id },
      });
      return updated.count === 1;
    });
  }

  async createMaterialWithFileObject(
    projectId: string,
    draftId: string,
    productId: string,
    expectedRevision: number,
    data: Omit<Prisma.EffectImportMaterialUncheckedCreateWithoutProductInput, 'workflowRunId'>,
    file: WorkingFileProjection,
  ): Promise<EffectMaterialRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const product = await transaction.effectImportProduct.findFirst({
        where: { projectId, draftId, id: productId, status: 'ACTIVE' },
        select: { workflowRunId: true },
      });
      if (!product) return null;
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
      for (const fileObject of file.fileObjects ?? (file.fileObject ? [file.fileObject] : []))
        await this.workingRepository.upsertFileObjectInTransaction(
          transaction,
          projectId,
          file.workflowRunId,
          fileObject,
        );
      const material = await transaction.effectImportMaterial.create({
        data: {
          ...data,
          projectId,
          workflowRunId: product.workflowRunId,
          productId,
          ...(file.fileObject ? { fileObjectId: file.fileObject.id } : {}),
        },
        include: { fileObject: true },
      });
      return material;
    });
  }

  async replaceMaterial(
    projectId: string,
    draftId: string,
    productId: string,
    materialId: string,
    expectedRevision: number,
    data: Prisma.EffectImportMaterialUncheckedUpdateInput,
  ): Promise<EffectMaterialRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const previousMaterial = await transaction.effectImportMaterial.findFirst({
        where: { projectId, productId, id: materialId, product: { draftId } },
        select: { fileObjectId: true },
      });
      if (!previousMaterial) return null;
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
        include: { fileObject: true },
      });
    });
  }

  async replaceMaterialWithFileObject(
    projectId: string,
    draftId: string,
    productId: string,
    materialId: string,
    expectedRevision: number,
    data: Prisma.EffectImportMaterialUncheckedUpdateInput,
    file: WorkingFileProjection,
  ): Promise<EffectMaterialRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const previousMaterial = await transaction.effectImportMaterial.findFirst({
        where: { projectId, productId, id: materialId, product: { draftId } },
        select: { fileObjectId: true },
      });
      if (!previousMaterial) return null;
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
      for (const fileObject of file.fileObjects ?? (file.fileObject ? [file.fileObject] : []))
        await this.workingRepository.upsertFileObjectInTransaction(
          transaction,
          projectId,
          file.workflowRunId,
          fileObject,
        );
      const material = await transaction.effectImportMaterial.update({
        where: { projectId_id: { projectId, id: materialId } },
        data: {
          ...data,
          ...(file.fileObject ? { fileObjectId: file.fileObject.id } : {}),
        },
        include: { fileObject: true },
      });
      if (
        previousMaterial.fileObjectId &&
        previousMaterial.fileObjectId !== file.fileObject?.id &&
        (await transaction.workingArtifactFile.count({
          where: { projectId, fileObjectId: previousMaterial.fileObjectId },
        })) === 0
      )
        await transaction.fileObject.update({
          where: { id: previousMaterial.fileObjectId },
          data: { status: 'ORPHANED', orphanedAt: new Date() },
        });
      return material;
    });
  }

  async deleteMaterial(
    projectId: string,
    draftId: string,
    productId: string,
    materialId: string,
    expectedRevision: number,
  ): Promise<{ storageKey: string | null; fileObjectId: string | null; revision: number } | null> {
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
      if (
        material.fileObjectId &&
        (await transaction.workingArtifactFile.count({
          where: { projectId, fileObjectId: material.fileObjectId },
        })) === 0
      )
        await transaction.fileObject.update({
          where: { id: material.fileObjectId },
          data: { status: 'ORPHANED', orphanedAt: new Date() },
        });
      return {
        storageKey: material.storageKey,
        fileObjectId: material.fileObjectId,
        revision: expectedRevision + 1,
      };
    });
  }

  async createUploadSession(
    projectId: string,
    workflowRunId: string,
    draftId: string,
    productId: string,
    expectedRevision: number,
    items: Array<{
      id: string;
      clientFileId: string;
      type: EffectImportMaterial['type'];
      expectedFileName: string | null;
      originalFileName: string;
      mimeType: string;
      sizeBytes: number;
    }>,
  ): Promise<EffectUploadSessionRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const product = await transaction.effectImportProduct.findFirst({
        where: {
          projectId,
          draftId,
          id: productId,
          status: 'ACTIVE',
          draft: { revision: expectedRevision },
        },
      });
      if (!product) return null;
      const session = await transaction.effectImportUploadSession.create({
        data: {
          projectId,
          workflowRunId,
          draftId,
          productId,
          expectedRevision,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      await transaction.effectImportUploadItem.createMany({
        data: items.map((item) => ({
          ...item,
          projectId,
          workflowRunId,
          sessionId: session.id,
        })),
      });
      return transaction.effectImportUploadSession.findUniqueOrThrow({
        where: { id: session.id },
        include: uploadSessionInclude,
      });
    });
  }

  uploadSession(projectId: string, sessionId: string): Promise<EffectUploadSessionRecord | null> {
    return this.prisma.effectImportUploadSession.findFirst({
      where: { projectId, id: sessionId },
      include: uploadSessionInclude,
    });
  }

  async storeUploadSessionItem(
    projectId: string,
    sessionId: string,
    clientFileId: string,
    data: {
      originalFileName: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
      sha256: string;
      fileObjectId: string;
    },
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const item = await transaction.effectImportUploadItem.findFirst({
        where: {
          projectId,
          sessionId,
          clientFileId,
          status: { in: ['PENDING', 'UPLOADED', 'FAILED'] },
          session: { status: 'UPLOADING', expiresAt: { gt: new Date() } },
        },
        include: { session: true },
      });
      if (!item) return { count: 0 };
      await this.workingRepository.upsertFileObjectInTransaction(
        transaction,
        projectId,
        item.session.workflowRunId,
        {
          id: data.fileObjectId,
          nodeId: 'SOURCE_IMPORT',
          originalFileName: data.originalFileName,
          mimeType: data.mimeType,
          sizeBytes: data.sizeBytes,
          storageKey: data.storageKey,
          sha256: data.sha256,
        },
      );
      await transaction.effectImportUploadItem.update({
        where: { id: item.id },
        data: { ...data, status: 'UPLOADED', errorCode: null, errorMessage: null },
      });
      if (item.fileObjectId && item.fileObjectId !== data.fileObjectId)
        await transaction.fileObject.update({
          where: { id: item.fileObjectId },
          data: { status: 'ORPHANED', orphanedAt: new Date() },
        });
      return { count: 1 };
    });
  }

  failUploadSessionItem(
    projectId: string,
    sessionId: string,
    clientFileId: string,
    errorCode: string,
    errorMessage: string,
  ) {
    return this.prisma.effectImportUploadItem.updateMany({
      where: {
        projectId,
        sessionId,
        clientFileId,
        status: { in: ['PENDING', 'UPLOADED', 'FAILED'] },
        session: { status: 'UPLOADING' },
      },
      data: {
        status: 'FAILED',
        errorCode: errorCode.slice(0, 120),
        errorMessage: errorMessage.slice(0, 500),
      },
    });
  }

  removeUploadSessionItem(projectId: string, sessionId: string, clientFileId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const item = await transaction.effectImportUploadItem.findFirst({
        where: {
          projectId,
          sessionId,
          clientFileId,
          status: { in: ['PENDING', 'UPLOADED', 'FAILED'] },
          session: { status: 'UPLOADING' },
        },
      });
      if (!item) return { count: 0 };
      await transaction.effectImportUploadItem.update({
        where: { id: item.id },
        data: { status: 'REMOVED', fileObjectId: null },
      });
      if (item.fileObjectId)
        await transaction.fileObject.update({
          where: { id: item.fileObjectId },
          data: { status: 'ORPHANED', orphanedAt: new Date() },
        });
      return { count: 1 };
    });
  }

  async completeUploadSession(
    projectId: string,
    sessionId: string,
    completionKey: string,
  ): Promise<{
    session: EffectUploadSessionRecord;
    materials: EffectMaterialRecord[];
    revision: number;
    unchanged: boolean;
  } | null> {
    return this.prisma.$transaction(async (transaction) => {
      const session = await transaction.effectImportUploadSession.findFirst({
        where: { projectId, id: sessionId },
        include: uploadSessionInclude,
      });
      if (!session) return null;
      if (session.status === 'COMPLETED') {
        if (session.completionKey !== completionKey) return null;
        const materials = await transaction.effectImportMaterial.findMany({
          where: {
            projectId,
            productId: session.productId,
            fileObjectId: { in: session.items.flatMap((item) => item.fileObjectId ?? []) },
          },
          include: { fileObject: true },
        });
        return { session, materials, revision: session.expectedRevision + 1, unchanged: true };
      }
      const accepted = session.items.filter((item) => item.status !== 'REMOVED');
      if (
        session.status !== 'UPLOADING' ||
        session.expiresAt <= new Date() ||
        accepted.length === 0 ||
        accepted.some(
          (item) =>
            item.status !== 'UPLOADED' || !item.storageKey || !item.sha256 || !item.fileObjectId,
        )
      )
        return null;
      const bumped = await transaction.effectImportDraft.updateMany({
        where: { projectId, id: session.draftId, revision: session.expectedRevision },
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
      const materials: EffectMaterialRecord[] = [];
      for (const item of accepted) {
        materials.push(
          await transaction.effectImportMaterial.create({
            data: {
              projectId,
              workflowRunId: session.workflowRunId,
              productId: session.productId,
              type: item.type,
              status: 'READY',
              expectedFileName: item.expectedFileName,
              originalFileName: item.originalFileName,
              mimeType: item.mimeType,
              sizeBytes: item.sizeBytes,
              storageKey: item.storageKey!,
              fileObjectId: item.fileObjectId!,
            },
            include: { fileObject: true },
          }),
        );
      }
      const completed = await transaction.effectImportUploadSession.update({
        where: { id: session.id },
        data: { status: 'COMPLETED', completionKey, completedAt: new Date() },
        include: uploadSessionInclude,
      });
      return {
        session: completed,
        materials,
        revision: session.expectedRevision + 1,
        unchanged: false,
      };
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

  async commitProductValidation(
    projectId: string,
    draftId: string,
    mode: EffectImportMode,
    workflowRunId: string,
    expectedRevision: number,
    artifacts: ValidatedArtifactCandidate[],
    allCandidates: ValidatedArtifactCandidate[],
    issues: unknown[],
  ): Promise<{
    draft: EffectDraftRecord;
    artifacts: Array<{
      artifactId: string;
      artifactKey: string;
      revision: number;
      unchanged: boolean;
    }>;
    allProductsValidated: boolean;
  } | null> {
    const committed = await this.prisma.$transaction(async (transaction) => {
      const draft = await transaction.effectImportDraft.findFirst({
        where: { projectId, id: draftId, revision: expectedRevision },
        select: { id: true },
      });
      if (!draft) return null;
      const results = await this.workingRepository.commitValidatedArtifactsInTransaction(
        transaction,
        projectId,
        workflowRunId,
        'SOURCE_IMPORT',
        artifacts,
      );
      const stored = await transaction.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId,
          nodeId: 'SOURCE_IMPORT',
          artifactKey: { in: allCandidates.map((candidate) => candidate.artifactKey) },
          freshness: 'CURRENT',
          availability: 'AVAILABLE',
        },
        select: { artifactKey: true, contentHash: true },
      });
      const hashes = new Map(
        stored.map((artifact) => [artifact.artifactKey, artifact.contentHash]),
      );
      const allProductsValidated =
        issues.length === 0 &&
        allCandidates.every(
          (candidate) =>
            hashes.get(candidate.artifactKey) === workingArtifactContentHash(candidate.input),
        );
      await transaction.effectImportDraft.update({
        where: { projectId_id: { projectId, id: draftId } },
        data: {
          validatedRevision: allProductsValidated ? expectedRevision : null,
          validationIssues: json(issues),
          validatedAt: new Date(),
          status: allProductsValidated ? 'VALID' : 'DRAFT',
        },
      });
      return {
        artifacts: results.map((result) => ({
          artifactId: result.record.id,
          artifactKey: result.artifactKey,
          revision: result.record.revision,
          unchanged: result.unchanged,
        })),
        allProductsValidated,
      };
    });
    if (!committed) return null;
    const draft = await this.draft(projectId, mode);
    return draft ? { draft, ...committed } : null;
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
        const draft = await transaction.effectImportDraft.findFirst({
          where: { projectId, id: draftId },
          select: { workspace: { select: { workflowRunId: true } } },
        });
        if (!draft) return null;
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
              workflowRunId: draft.workspace.workflowRunId,
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
                    workflowRunId: draft.workspace.workflowRunId,
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
                    workflowRunId: draft.workspace.workflowRunId,
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

  dueRemovedProducts(limit = 50) {
    return this.prisma.effectImportProduct.findMany({
      where: { status: 'REMOVED', purgeAfter: { lte: new Date() } },
      select: { id: true, projectId: true },
      orderBy: [{ purgeAfter: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  async purgeRemovedProduct(projectId: string, productId: string): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const product = await transaction.effectImportProduct.findFirst({
        where: { projectId, id: productId, status: 'REMOVED', purgeAfter: { lte: new Date() } },
        include: { materials: true },
      });
      if (!product) return false;
      const [activeRuns, activeUploadSessions] = await Promise.all([
        transaction.effectExtractionRun.count({
          where: { projectId, productId, status: { in: ['QUEUED', 'RUNNING'] } },
        }),
        transaction.effectImportUploadSession.count({
          where: { projectId, productId, status: 'UPLOADING' },
        }),
      ]);
      const materialStorageKeys = product.materials
        .map((material) => material.storageKey)
        .filter((storageKey): storageKey is string => Boolean(storageKey));
      const activeFileHolds = materialStorageKeys.length
        ? await transaction.effectExtractionFileHold.count({
            where: { projectId, storageKey: { in: materialStorageKeys } },
          })
        : 0;
      if (activeRuns + activeUploadSessions + activeFileHolds > 0) {
        await transaction.effectImportProduct.update({
          where: { id: productId },
          data: { purgeAfter: new Date(Date.now() + 60_000) },
        });
        return false;
      }
      const direct = await transaction.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId: product.workflowRunId,
          artifactKey: {
            in: [
              `source-package:${product.id}`,
              `effective-video-config:${product.id}`,
              `global-video-config:${product.id}`,
            ],
          },
        },
        select: { id: true },
      });
      const directIds = direct.map((item) => item.id);
      const levels: string[][] = [directIds];
      const seen = new Set(directIds);
      let pending: string[] = directIds;
      while (pending.length) {
        const dependencies = await transaction.workingArtifactDependency.findMany({
          where: {
            projectId,
            workflowRunId: product.workflowRunId,
            sourceType: 'WORKING_ARTIFACT',
            sourceArtifactId: { in: pending },
          },
          select: { dependentArtifactId: true },
        });
        const next = [...new Set(dependencies.map((item) => item.dependentArtifactId))].filter(
          (id) => !seen.has(id),
        );
        if (!next.length) break;
        next.forEach((id) => seen.add(id));
        levels.push(next);
        pending = next;
      }
      const artifactIds = [...seen];
      const linkedFiles = artifactIds.length
        ? await transaction.workingArtifactFile.findMany({
            where: {
              projectId,
              workflowRunId: product.workflowRunId,
              workingArtifactId: { in: artifactIds },
            },
            select: { fileObjectId: true },
          })
        : [];
      const uploadFiles = await transaction.effectImportUploadItem.findMany({
        where: { projectId, workflowRunId: product.workflowRunId, session: { productId } },
        select: { fileObjectId: true },
      });
      for (const level of [...levels].reverse())
        if (level.length)
          await transaction.workingArtifact.deleteMany({
            where: { projectId, workflowRunId: product.workflowRunId, id: { in: level } },
          });
      const fileObjectIds = [
        ...new Set([
          ...product.materials.flatMap((material) => material.fileObjectId ?? []),
          ...linkedFiles.map((file) => file.fileObjectId),
          ...uploadFiles.flatMap((file) => file.fileObjectId ?? []),
        ]),
      ];
      await transaction.effectImportProduct.delete({ where: { id: product.id } });
      for (const fileObjectId of fileObjectIds) {
        const fileObject = await transaction.fileObject.findFirst({
          where: {
            projectId,
            workflowRunId: product.workflowRunId,
            id: fileObjectId,
            materials: { none: {} },
            artifactLinks: { none: {} },
            uploadItems: { none: { session: { status: 'UPLOADING' } } },
          },
        });
        if (!fileObject) continue;
        await transaction.fileObject.update({
          where: { id: fileObject.id },
          data: { status: 'ORPHANED', orphanedAt: new Date() },
        });
        await transaction.storageCleanupTask.upsert({
          where: { projectId_storageKey: { projectId, storageKey: fileObject.storageKey } },
          create: {
            projectId,
            storageKey: fileObject.storageKey,
            reason: 'REMOVED_PRODUCT_PURGED',
            nextAttemptAt: new Date(),
          },
          update: { reason: 'REMOVED_PRODUCT_PURGED', nextAttemptAt: new Date() },
        });
      }
      return true;
    });
  }

  enqueueStorageCleanup(projectId: string, storageKey: string, reason: string) {
    const nextAttemptAt = new Date(Date.now() + cleanupGraceMs());
    return this.prisma.storageCleanupTask.upsert({
      where: { projectId_storageKey: { projectId, storageKey } },
      create: { projectId, storageKey, reason, nextAttemptAt },
      update: { reason, nextAttemptAt },
    });
  }

  async isStorageHeld(projectId: string, storageKey: string): Promise<boolean> {
    const [holds, materials, artifactFiles, uploadItems, assets, versions] = await Promise.all([
      this.prisma.effectExtractionFileHold.count({ where: { projectId, storageKey } }),
      this.prisma.effectImportMaterial.count({
        where: { projectId, OR: [{ storageKey }, { fileObject: { storageKey } }] },
      }),
      this.prisma.workingArtifactFile.count({
        where: { projectId, fileObject: { storageKey } },
      }),
      this.prisma.effectImportUploadItem.count({
        where: {
          projectId,
          storageKey,
          status: { in: ['PENDING', 'UPLOADED', 'FAILED'] },
          session: { status: 'UPLOADING' },
        },
      }),
      this.prisma.asset.count({ where: { projectId, storageKey } }),
      this.prisma.assetVersion.count({ where: { projectId, storageKey } }),
    ]);
    return holds + materials + artifactFiles + uploadItems + assets + versions > 0;
  }

  deleteOrphanedFileObject(projectId: string, storageKey: string) {
    return this.prisma.$transaction(async (transaction) => {
      const fileObject = await transaction.fileObject.findFirst({
        where: {
          projectId,
          storageKey,
          status: 'ORPHANED',
          materials: { none: {} },
          artifactLinks: { none: {} },
          uploadItems: { none: { session: { status: 'UPLOADING' } } },
        },
        select: { id: true },
      });
      if (!fileObject) return { count: 0 };
      await transaction.effectImportUploadItem.updateMany({
        where: { projectId, fileObjectId: fileObject.id, session: { status: 'COMPLETED' } },
        data: { fileObjectId: null },
      });
      return transaction.fileObject.deleteMany({ where: { projectId, id: fileObject.id } });
    });
  }

  storageCleanupTasks(projectId: string) {
    return this.prisma.storageCleanupTask.findMany({
      where: { projectId, nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  }

  storageCleanupTasksAcrossProjects() {
    return this.prisma.storageCleanupTask.findMany({
      where: { nextAttemptAt: { lte: new Date() } },
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
