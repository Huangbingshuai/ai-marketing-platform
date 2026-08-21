import type {
  AssetDirectory,
  AssetListQuery,
  AssetStatus,
  AssetType,
  AssetWorkflow,
  AssetWorkflowSpace,
  CreateAssetVersionRequest,
  StoreArtifactInput,
} from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Asset as AssetRecord, AssetVersion, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';

export type CreateAssetRecord = {
  name: string;
  directory: AssetDirectory;
  type: AssetType;
  tags: string[];
  notes: string | null;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  hasFile?: boolean;
  storageWorkflow?: AssetWorkflow;
  workflowSpace?: AssetWorkflowSpace;
  status?: AssetStatus;
  qualityStatus?: AssetStatus;
  assetClass?: string | null;
  businessType?: string | null;
  contentKind?: string | null;
  content?: Prisma.InputJsonValue;
  businessData?: Prisma.InputJsonValue;
  views?: string[];
  sourceArtifactId?: string | null;
  sourceRunId?: string | null;
  sourceNode?: string | null;
  sourceShot?: string | null;
  idempotencyKey?: string | null;
  sourceProjectId?: string | null;
  sourceAssetId?: string | null;
  sourceVersion?: number | null;
  importedAt?: Date | null;
  dependencies?: Prisma.InputJsonValue;
};

export type UpdateAssetRecord = Pick<
  CreateAssetRecord,
  'name' | 'directory' | 'type' | 'tags' | 'notes'
> & {
  status?: AssetStatus | undefined;
  qualityStatus?: AssetStatus | undefined;
};

const compact = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

const jsonField = (name: string, value: unknown): Record<string, unknown> =>
  value === null || value === undefined ? {} : { [name]: value };

const activeWhere = (projectId: string): Prisma.AssetWhereInput => ({
  projectId,
  archivedAt: null,
});

const filteredWhere = (projectId: string, filters: AssetListQuery): Prisma.AssetWhereInput => {
  const keyword = filters.keyword?.trim();
  return {
    ...activeWhere(projectId),
    ...(filters.directory ? { directory: filters.directory } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.workflow ? { storageWorkflow: filters.workflow } : {}),
    ...(filters.space ? { workflowSpace: filters.space } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.tag?.trim() ? { tags: { has: filters.tag.trim() } } : {}),
    ...(keyword
      ? {
          OR: [
            { name: { contains: keyword, mode: 'insensitive' } },
            { originalFileName: { contains: keyword, mode: 'insensitive' } },
            { notes: { contains: keyword, mode: 'insensitive' } },
            { sourceArtifactId: { contains: keyword, mode: 'insensitive' } },
            { sourceRunId: { contains: keyword, mode: 'insensitive' } },
            { sourceNode: { contains: keyword, mode: 'insensitive' } },
            { sourceShot: { contains: keyword, mode: 'insensitive' } },
            { tags: { has: keyword } },
          ],
        }
      : {}),
  };
};

@Injectable()
export class AssetRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  list(projectId: string, filters: AssetListQuery): Promise<AssetRecord[]> {
    const paged = filters.page !== undefined || filters.pageSize !== undefined;
    const page = Math.max(1, filters.page ?? 1),
      pageSize = Math.min(96, Math.max(1, filters.pageSize ?? 24));
    return this.prisma.asset.findMany({
      where: filteredWhere(projectId, filters),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      ...(paged ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
    });
  }

  count(projectId: string, filters: AssetListQuery): Promise<number> {
    return this.prisma.asset.count({ where: filteredWhere(projectId, filters) });
  }

  listForFacets(
    projectId: string,
    filters: Pick<AssetListQuery, 'workflow' | 'space'> = {},
  ): Promise<Pick<AssetRecord, 'directory' | 'type' | 'status' | 'tags'>[]> {
    return this.prisma.asset.findMany({
      where: {
        ...activeWhere(projectId),
        ...(filters.workflow ? { storageWorkflow: filters.workflow } : {}),
        ...(filters.space ? { workflowSpace: filters.space } : {}),
      },
      select: { directory: true, type: true, status: true, tags: true },
    });
  }

  async create(
    projectId: string,
    data: CreateAssetRecord,
    changeNote = '初始导入版本',
    operationKey?: string,
  ): Promise<AssetRecord> {
    return this.prisma.$transaction(async (transaction) => {
      if (operationKey) {
        const receipt = await transaction.assetOperationReceipt.findUnique({
          where: { projectId_operationKey: { projectId, operationKey } },
        });
        if (receipt) {
          return transaction.asset.findFirstOrThrow({
            where: { projectId, id: receipt.assetId, archivedAt: null },
          });
        }
      }
      const { content, businessData, dependencies, ...assetFields } = data;
      const asset = await transaction.asset.create({
        data: compact({
          projectId,
          ...assetFields,
          ...jsonField('content', content),
          ...jsonField('businessData', businessData),
          ...jsonField('dependencies', dependencies),
        }) as Prisma.AssetUncheckedCreateInput,
      });
      const assetVersion = await transaction.assetVersion.create({
        data: compact({
          projectId,
          assetId: asset.id,
          version: asset.currentVersion,
          changeNote,
          status: asset.status,
          qualityStatus: asset.qualityStatus,
          ...jsonField('content', asset.content),
          ...jsonField('businessData', asset.businessData),
          originalFileName: asset.originalFileName,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          storageKey: asset.storageKey,
        }) as Prisma.AssetVersionUncheckedCreateInput,
      });
      if (operationKey) {
        await transaction.assetOperationReceipt.create({
          data: {
            projectId,
            operationKey,
            assetId: asset.id,
            assetVersionId: assetVersion.id,
            version: assetVersion.version,
          },
        });
      }
      return asset;
    });
  }

  find(projectId: string, assetId: string): Promise<AssetRecord | null> {
    return this.prisma.asset.findFirst({ where: { ...activeWhere(projectId), id: assetId } });
  }

  findByIdempotency(
    projectId: string,
    workflow: AssetWorkflow,
    space: AssetWorkflowSpace,
    idempotencyKey: string,
  ): Promise<AssetRecord | null> {
    return this.prisma.asset.findFirst({
      where: {
        ...activeWhere(projectId),
        storageWorkflow: workflow,
        workflowSpace: space,
        idempotencyKey,
      },
    });
  }

  async update(
    projectId: string,
    assetId: string,
    data: UpdateAssetRecord,
  ): Promise<AssetRecord | null> {
    const result = await this.prisma.asset.updateMany({
      where: { ...activeWhere(projectId), id: assetId },
      data: compact(data) as Prisma.AssetUncheckedUpdateManyInput,
    });
    return result.count === 0 ? null : this.find(projectId, assetId);
  }

  async archive(projectId: string, assetId: string): Promise<Date | null> {
    const archivedAt = new Date();
    const result = await this.prisma.asset.updateMany({
      where: { ...activeWhere(projectId), id: assetId },
      data: { archivedAt },
    });
    return result.count === 1 ? archivedAt : null;
  }

  async archiveMany(projectId: string, assetIds: string[]): Promise<string[]> {
    const records = await this.prisma.asset.findMany({
      where: { ...activeWhere(projectId), id: { in: assetIds } },
      select: { id: true },
    });
    const scopedIds = records.map((record) => record.id);
    if (scopedIds.length > 0) {
      await this.prisma.asset.updateMany({
        where: { ...activeWhere(projectId), id: { in: scopedIds } },
        data: { archivedAt: new Date() },
      });
    }
    return scopedIds;
  }

  listVersions(projectId: string, assetId: string): Promise<AssetVersion[]> {
    return this.prisma.assetVersion.findMany({
      where: { projectId, assetId, asset: { archivedAt: null } },
      orderBy: { version: 'desc' },
    });
  }

  findVersion(projectId: string, assetId: string, version: number): Promise<AssetVersion | null> {
    return this.prisma.assetVersion.findFirst({
      where: { projectId, assetId, version, asset: { archivedAt: null } },
    });
  }

  findOperation(
    projectId: string,
    operationKey: string,
  ): Promise<{ asset: AssetRecord; assetVersionId: string; version: number } | null> {
    return this.prisma.assetOperationReceipt
      .findUnique({ where: { projectId_operationKey: { projectId, operationKey } } })
      .then(async (receipt) => {
        if (!receipt) return null;
        const asset = await this.prisma.asset.findFirst({
          where: { projectId, id: receipt.assetId, archivedAt: null },
        });
        return asset
          ? { asset, assetVersionId: receipt.assetVersionId, version: receipt.version }
          : null;
      });
  }

  async createVersion(
    projectId: string,
    assetId: string,
    input: CreateAssetVersionRequest,
    operationKey?: string,
  ): Promise<AssetRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      if (operationKey) {
        const receipt = await transaction.assetOperationReceipt.findUnique({
          where: { projectId_operationKey: { projectId, operationKey } },
        });
        if (receipt) {
          return transaction.asset.findFirst({
            where: { projectId, id: receipt.assetId, archivedAt: null },
          });
        }
      }
      const current = await transaction.asset.findFirst({
        where: { projectId, id: assetId, archivedAt: null },
      });
      if (!current) return null;
      const version = current.currentVersion + 1;
      const status = input.status ?? 'PENDING_REVIEW',
        qualityStatus = input.qualityStatus ?? current.qualityStatus;
      const content =
        input.content === undefined ? current.content : (input.content as Prisma.InputJsonValue);
      const businessData =
        input.businessData === undefined
          ? current.businessData
          : (input.businessData as Prisma.InputJsonValue);
      const jsonUpdates = {
        ...jsonField('content', content),
        ...jsonField('businessData', businessData),
      };
      const updated = await transaction.asset.update({
        where: { id: current.id },
        data: { currentVersion: version, status, qualityStatus, ...jsonUpdates },
      });
      const assetVersion = await transaction.assetVersion.create({
        data: {
          projectId,
          assetId,
          version,
          changeNote: input.changeNote,
          status,
          qualityStatus,
          ...jsonUpdates,
          originalFileName: current.originalFileName,
          mimeType: current.mimeType,
          sizeBytes: current.sizeBytes,
          storageKey: current.storageKey,
        } as Prisma.AssetVersionUncheckedCreateInput,
      });
      if (operationKey) {
        await transaction.assetOperationReceipt.create({
          data: { projectId, operationKey, assetId, assetVersionId: assetVersion.id, version },
        });
      }
      return updated;
    });
  }

  async createFileVersion(
    projectId: string,
    assetId: string,
    file: { originalFileName: string; mimeType: string; sizeBytes: number; storageKey: string },
    operationKey?: string,
  ): Promise<AssetRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      if (operationKey) {
        const receipt = await transaction.assetOperationReceipt.findUnique({
          where: { projectId_operationKey: { projectId, operationKey } },
        });
        if (receipt) {
          return transaction.asset.findFirst({
            where: { projectId, id: receipt.assetId, archivedAt: null },
          });
        }
      }
      const current = await transaction.asset.findFirst({
        where: { projectId, id: assetId, archivedAt: null },
      });
      if (!current) return null;
      const version = current.currentVersion + 1;
      const updated = await transaction.asset.update({
        where: { id: current.id },
        data: {
          ...file,
          hasFile: true,
          currentVersion: version,
          status: 'PENDING_REVIEW',
          qualityStatus: 'PENDING_REVIEW',
        },
      });
      const assetVersion = await transaction.assetVersion.create({
        data: {
          projectId,
          assetId,
          version,
          changeNote: `重新上传 ${file.originalFileName}`,
          status: updated.status,
          qualityStatus: updated.qualityStatus,
          ...jsonField('content', updated.content),
          ...jsonField('businessData', updated.businessData),
          ...file,
        } as Prisma.AssetVersionUncheckedCreateInput,
      });
      if (operationKey) {
        await transaction.assetOperationReceipt.create({
          data: { projectId, operationKey, assetId, assetVersionId: assetVersion.id, version },
        });
      }
      return updated;
    });
  }

  async upgradeSnapshot(
    projectId: string,
    assetId: string,
    source: AssetRecord,
  ): Promise<AssetRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.asset.findFirst({
        where: { projectId, id: assetId, archivedAt: null },
      });
      if (
        !current ||
        current.sourceProjectId !== source.projectId ||
        current.sourceAssetId !== source.id
      )
        return null;
      if ((current.sourceVersion ?? 0) >= source.currentVersion) return current;
      const version = current.currentVersion + 1;
      const updated = await transaction.asset.update({
        where: { id: current.id },
        data: {
          currentVersion: version,
          sourceVersion: source.currentVersion,
          importedAt: new Date(),
          name: source.name,
          directory: source.directory,
          type: source.type,
          tags: source.tags,
          notes: source.notes,
          originalFileName: source.originalFileName,
          mimeType: source.mimeType,
          sizeBytes: source.sizeBytes,
          storageKey: source.storageKey,
          hasFile: source.hasFile,
          status: source.status,
          qualityStatus: source.qualityStatus,
          assetClass: source.assetClass,
          businessType: source.businessType,
          contentKind: source.contentKind,
          ...jsonField('content', source.content),
          ...jsonField('businessData', source.businessData),
          views: source.views,
          ...jsonField('dependencies', source.dependencies),
        },
      });
      await transaction.assetVersion.create({
        data: {
          projectId,
          assetId,
          version,
          changeNote: `升级来源至 v${source.currentVersion}`,
          status: updated.status,
          qualityStatus: updated.qualityStatus,
          ...jsonField('content', updated.content),
          ...jsonField('businessData', updated.businessData),
          originalFileName: updated.originalFileName,
          mimeType: updated.mimeType,
          sizeBytes: updated.sizeBytes,
          storageKey: updated.storageKey,
        } as Prisma.AssetVersionUncheckedCreateInput,
      });
      return updated;
    });
  }

  async addTags(projectId: string, assetIds: string[], tags: string[]): Promise<string[]> {
    const records = await this.prisma.asset.findMany({
      where: { ...activeWhere(projectId), id: { in: assetIds } },
      select: { id: true, tags: true },
    });
    await this.prisma.$transaction(
      records.map((record) =>
        this.prisma.asset.update({
          where: { id: record.id },
          data: { tags: [...new Set([...record.tags, ...tags])] },
        }),
      ),
    );
    return records.map((record) => record.id);
  }

  toArtifactRecord(
    input: StoreArtifactInput,
    workflow: AssetWorkflow,
    space: AssetWorkflowSpace,
  ): CreateAssetRecord {
    return {
      name: input.name,
      directory: input.directory,
      type: input.type,
      tags: input.tags ?? [],
      notes: input.notes ?? null,
      originalFileName: '',
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
      storageKey: '',
      hasFile: false,
      storageWorkflow: workflow,
      workflowSpace: space,
      status: 'AVAILABLE',
      qualityStatus: 'AVAILABLE',
      assetClass: input.assetClass ?? null,
      businessType: input.businessType ?? null,
      contentKind: input.contentKind ?? null,
      ...(input.content === undefined ? {} : { content: input.content as Prisma.InputJsonValue }),
      ...(input.businessData === undefined
        ? {}
        : { businessData: input.businessData as Prisma.InputJsonValue }),
      views: input.views ?? [],
      sourceArtifactId: input.sourceArtifactId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      sourceNode: input.sourceNode ?? null,
      sourceShot: input.sourceShot ?? null,
      idempotencyKey: input.idempotencyKey,
      ...(input.dependencies === undefined
        ? {}
        : { dependencies: input.dependencies as Prisma.InputJsonValue }),
    };
  }
}
