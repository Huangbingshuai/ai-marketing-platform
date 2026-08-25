import type {
  AssetDirectory,
  AssetType,
  AssetWorkflow,
  AssetWorkflowSpace,
  WorkingArtifactKind,
} from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type WorkflowNodeState } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { workflowStateHash } from './workflow-state-hash';

export type WorkingArtifactUpsertInput = {
  kind: WorkingArtifactKind;
  name: string;
  directory: AssetDirectory;
  type: AssetType;
  tags?: string[];
  payload?: unknown;
  metadata?: unknown;
  originalFileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  storageKey?: string | null;
  sourceRunId?: string | null;
  sourceArtifactId?: string | null;
  fileChecksum?: string | null;
  expectedRevision?: number;
  files?: Array<{
    fileObjectId: string;
    role: string;
    sortOrder: number;
    originalFileName: string;
    mimeType: string;
    sha256: string;
  }>;
  dependencies?: Array<{
    sourceType: 'NODE_STATE' | 'WORKING_ARTIFACT' | 'EXECUTION_INPUT';
    sourceNodeId?: string | null;
    sourceArtifactId?: string | null;
    sourceKey: string;
    sourceRevision?: number | null;
    sourceHash?: string | null;
  }>;
};

export type FileObjectInput = {
  id?: string;
  nodeId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  sha256: string;
};

export const workingArtifactInclude = {
  files: {
    include: { fileObject: true },
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
  },
  dependencies: { orderBy: [{ sourceType: 'asc' as const }, { sourceKey: 'asc' as const }] },
} satisfies Prisma.WorkingArtifactInclude;

export type WorkingArtifactRecord = Prisma.WorkingArtifactGetPayload<{
  include: typeof workingArtifactInclude;
}>;

const jsonValue = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === undefined || value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

const openRunStatuses = ['ACTIVE', 'PAUSED'] as const;
const cleanupGraceMs = (): number =>
  Number(process.env.WORKING_FILE_CLEANUP_GRACE_HOURS ?? 24) * 60 * 60 * 1000;

const semanticMetadata = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
  const metadata = { ...(value as Record<string, unknown>) };
  delete metadata.legacyArtifactIds;
  return metadata;
};

const semanticFileName = (value: string | null | undefined): string | null =>
  value ? value.normalize('NFC').toLocaleLowerCase('en-US') : null;

export const workingArtifactContentHash = (input: WorkingArtifactUpsertInput): string =>
  workflowStateHash({
    kind: input.kind,
    name: input.name,
    directory: input.directory,
    type: input.type,
    tags: [...(input.tags ?? [])]
      .map((item) => item.trim())
      .filter(Boolean)
      .sort(),
    payload: input.payload ?? null,
    metadata: semanticMetadata(input.metadata),
    fileChecksum: input.fileChecksum ?? null,
    legacyFile: input.files?.length
      ? null
      : {
          originalFileName: semanticFileName(input.originalFileName),
          mimeType: input.mimeType?.trim().toLowerCase() ?? null,
          sizeBytes: input.sizeBytes ?? null,
        },
    files: [...(input.files ?? [])]
      .sort(
        (left, right) => left.sortOrder - right.sortOrder || left.role.localeCompare(right.role),
      )
      .map(({ role, sortOrder, originalFileName, mimeType, sha256 }) => ({
        role,
        sortOrder,
        originalFileName: semanticFileName(originalFileName),
        mimeType: mimeType.trim().toLowerCase(),
        sha256,
      })),
    dependencies: [...(input.dependencies ?? [])]
      .sort((left, right) =>
        `${left.sourceType}:${left.sourceKey}`.localeCompare(
          `${right.sourceType}:${right.sourceKey}`,
        ),
      )
      .map(({ sourceType, sourceNodeId, sourceKey, sourceRevision, sourceHash }) => ({
        sourceType,
        sourceNodeId: sourceNodeId ?? null,
        sourceKey,
        sourceRevision: sourceRevision ?? null,
        sourceHash: sourceHash ?? null,
      })),
  });

const persistedArtifactHash = (record: WorkingArtifactRecord): string =>
  workingArtifactContentHash({
    kind: record.kind,
    name: record.name,
    directory: record.directory,
    type: record.type,
    tags: record.tags,
    payload: record.payload,
    metadata: record.metadata,
    originalFileName: record.originalFileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    storageKey: record.storageKey,
    sourceRunId: record.sourceRunId,
    sourceArtifactId: record.sourceArtifactId,
    files: record.files.map((file) => ({
      fileObjectId: file.fileObjectId,
      role: file.role,
      sortOrder: file.sortOrder,
      originalFileName: file.fileObject.originalFileName,
      mimeType: file.fileObject.mimeType,
      sha256: file.fileObject.sha256,
    })),
    dependencies: record.dependencies.map((dependency) => ({
      sourceType: dependency.sourceType,
      sourceNodeId: dependency.sourceNodeId,
      sourceArtifactId: dependency.sourceArtifactId,
      sourceKey: dependency.sourceKey,
      sourceRevision: dependency.sourceRevision,
      sourceHash: dependency.sourceHash,
    })),
  });

@Injectable()
export class WorkflowWorkingRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  findRun(projectId: string, workflowRunId: string) {
    return this.prisma.workflowRun.findFirst({ where: { id: workflowRunId, projectId } });
  }

  findActiveRun(projectId: string, workflow: AssetWorkflow, space: AssetWorkflowSpace) {
    return this.prisma.workflowRun.findFirst({
      where: { projectId, workflow, workflowSpace: space, status: { in: [...openRunStatuses] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  findActiveRunWithNodeStates(
    projectId: string,
    workflow: AssetWorkflow,
    space: AssetWorkflowSpace,
  ) {
    return this.prisma.workflowRun.findFirst({
      where: { projectId, workflow, workflowSpace: space, status: { in: [...openRunStatuses] } },
      include: { nodeStates: { orderBy: [{ savedAt: 'asc' }, { id: 'asc' }] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  createRun(projectId: string, workflow: AssetWorkflow, space: AssetWorkflowSpace, id?: string) {
    return this.prisma.workflowRun.create({
      data: { ...(id ? { id } : {}), projectId, workflow, workflowSpace: space },
    });
  }

  findNodeState(projectId: string, workflowRunId: string, nodeId: string) {
    return this.prisma.workflowNodeState.findUnique({
      where: { projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId } },
    });
  }

  async saveNodeState(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    contentHash: string,
    state: unknown,
    expectedRevision: number | null,
    schemaVersion: number,
    executionInputHash = '0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72',
    executionInputSchemaVersion = 1,
  ): Promise<{ record: WorkflowNodeState; unchanged: boolean; conflict: boolean }> {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findFirst({
        where: { id: workflowRunId, projectId, status: { in: [...openRunStatuses] } },
      });
      if (!run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
      const current = await transaction.workflowNodeState.findUnique({
        where: { projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId } },
      });
      const contentUnchanged = Boolean(
        current &&
        (current.contentHash === contentHash || workflowStateHash(current.state) === contentHash),
      );
      if (current && contentUnchanged) {
        if (
          current.executionInputHash === executionInputHash &&
          current.executionInputSchemaVersion === executionInputSchemaVersion
        )
          return { record: current, unchanged: true, conflict: false };
        const record = await transaction.workflowNodeState.update({
          where: { id: current.id },
          data: { executionInputHash, executionInputSchemaVersion },
        });
        await this.markNodeDependentsStaleInTransaction(
          transaction,
          projectId,
          workflowRunId,
          nodeId,
        );
        return { record, unchanged: true, conflict: false };
      }
      if (current) {
        if (expectedRevision !== current.revision)
          return { record: current, unchanged: false, conflict: true };
        const record = await transaction.workflowNodeState.update({
          where: { id: current.id },
          data: {
            state: jsonValue(state),
            contentHash,
            schemaVersion,
            executionInputHash,
            executionInputSchemaVersion,
            revision: { increment: 1 },
            savedAt: new Date(),
          },
        });
        await transaction.workflowRun.update({
          where: { id: workflowRunId },
          data: { currentNodeId: nodeId, lastActiveAt: new Date() },
        });
        if (current.executionInputHash !== executionInputHash)
          await this.markNodeDependentsStaleInTransaction(
            transaction,
            projectId,
            workflowRunId,
            nodeId,
          );
        return { record, unchanged: false, conflict: false };
      }
      if (expectedRevision !== null && expectedRevision !== 0)
        return {
          record: null as never,
          unchanged: false,
          conflict: true,
        };
      const record = await transaction.workflowNodeState.create({
        data: {
          projectId,
          workflowRunId,
          nodeId,
          state: jsonValue(state),
          contentHash,
          schemaVersion,
          executionInputHash,
          executionInputSchemaVersion,
        },
      });
      await transaction.workflowRun.update({
        where: { id: workflowRunId },
        data: { currentNodeId: nodeId, lastActiveAt: new Date() },
      });
      return { record, unchanged: false, conflict: false };
    });
  }

  async replaceNodeState(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    contentHash: string,
    state: unknown,
    schemaVersion = 1,
    executionInputHash = '0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72',
    executionInputSchemaVersion = 1,
  ): Promise<WorkflowNodeState> {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findFirst({
        where: { id: workflowRunId, projectId, status: { in: [...openRunStatuses] } },
      });
      if (!run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
      const unique = { projectId, workflowRunId, nodeId };
      const current = await transaction.workflowNodeState.findUnique({
        where: { projectId_workflowRunId_nodeId: unique },
      });
      if (current && current.contentHash === contentHash) {
        if (
          current.executionInputHash === executionInputHash &&
          current.executionInputSchemaVersion === executionInputSchemaVersion
        )
          return current;
        const record = await transaction.workflowNodeState.update({
          where: { id: current.id },
          data: { executionInputHash, executionInputSchemaVersion },
        });
        await this.markNodeDependentsStaleInTransaction(
          transaction,
          projectId,
          workflowRunId,
          nodeId,
        );
        return record;
      }
      const record = current
        ? await transaction.workflowNodeState.update({
            where: { id: current.id },
            data: {
              state: jsonValue(state),
              contentHash,
              schemaVersion,
              executionInputHash,
              executionInputSchemaVersion,
              revision: { increment: 1 },
              savedAt: new Date(),
            },
          })
        : await transaction.workflowNodeState.create({
            data: {
              ...unique,
              state: jsonValue(state),
              contentHash,
              schemaVersion,
              executionInputHash,
              executionInputSchemaVersion,
            },
          });
      await transaction.workflowRun.update({
        where: { id: workflowRunId },
        data: { currentNodeId: nodeId, lastActiveAt: new Date() },
      });
      if (!current || current.executionInputHash !== executionInputHash)
        await this.markNodeDependentsStaleInTransaction(
          transaction,
          projectId,
          workflowRunId,
          nodeId,
        );
      return record;
    });
  }

  listArtifacts(
    projectId: string,
    filters: {
      workflowRunId?: string;
      nodeId?: string;
      workflow?: AssetWorkflow;
      space?: AssetWorkflowSpace;
    },
  ) {
    return this.prisma.workingArtifact.findMany({
      where: {
        projectId,
        ...(filters.workflowRunId ? { workflowRunId: filters.workflowRunId } : {}),
        ...(filters.nodeId ? { nodeId: filters.nodeId } : {}),
        workflowRun: {
          status: { in: [...openRunStatuses] },
          ...(filters.workflow ? { workflow: filters.workflow } : {}),
          ...(filters.space ? { workflowSpace: filters.space } : {}),
        },
      },
      include: workingArtifactInclude,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
  }

  findArtifact(projectId: string, artifactId: string) {
    return this.prisma.workingArtifact.findFirst({
      where: { id: artifactId, projectId },
      include: workingArtifactInclude,
    });
  }

  findArtifactByKey(projectId: string, workflowRunId: string, nodeId: string, artifactKey: string) {
    return this.prisma.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          projectId,
          workflowRunId,
          nodeId,
          artifactKey,
        },
      },
      include: workingArtifactInclude,
    });
  }

  pauseRun(projectId: string, workflowRunId: string) {
    return this.prisma.workflowRun.updateMany({
      where: { projectId, id: workflowRunId, status: { in: [...openRunStatuses] } },
      data: { status: 'PAUSED', lastActiveAt: new Date() },
    });
  }

  findFileObject(projectId: string, fileObjectId: string) {
    return this.prisma.fileObject.findFirst({ where: { id: fileObjectId, projectId } });
  }

  upsertFileObjectInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    input: FileObjectInput,
  ) {
    return transaction.fileObject.upsert({
      where: { projectId_storageKey: { projectId, storageKey: input.storageKey } },
      create: {
        ...(input.id ? { id: input.id } : {}),
        projectId,
        workflowRunId,
        nodeId: input.nodeId,
        originalFileName: input.originalFileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        storageKey: input.storageKey,
        sha256: input.sha256,
      },
      update: {
        nodeId: input.nodeId,
        originalFileName: input.originalFileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        status: 'AVAILABLE',
        orphanedAt: null,
      },
    });
  }

  async upsertArtifact(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifactKey: string,
    input: WorkingArtifactUpsertInput,
  ): Promise<{
    record: WorkingArtifactRecord;
    previousStorageKey: string | null;
    unchanged: boolean;
    orphanedFileObjectIds: string[];
  }> {
    return this.prisma.$transaction((transaction) =>
      this.upsertArtifactInTransaction(
        transaction,
        projectId,
        workflowRunId,
        nodeId,
        artifactKey,
        input,
      ),
    );
  }

  async upsertArtifactInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifactKey: string,
    input: WorkingArtifactUpsertInput,
  ): Promise<{
    record: WorkingArtifactRecord;
    previousStorageKey: string | null;
    unchanged: boolean;
    orphanedFileObjectIds: string[];
  }> {
    const run = await transaction.workflowRun.findFirst({
      where: { id: workflowRunId, projectId, status: { in: [...openRunStatuses] } },
    });
    if (!run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
    const unique = { projectId, workflowRunId, nodeId, artifactKey };
    const previous = await transaction.workingArtifact.findUnique({
      where: { projectId_workflowRunId_nodeId_artifactKey: unique },
      include: workingArtifactInclude,
    });
    await this.validateArtifactInputsInTransaction(transaction, projectId, workflowRunId, input);
    const contentHash = workingArtifactContentHash(input);
    if (previous?.contentHash === contentHash)
      return {
        record: previous,
        previousStorageKey: previous.storageKey,
        unchanged: true,
        orphanedFileObjectIds: [],
      };
    if (previous && persistedArtifactHash(previous) === contentHash) {
      // Compatibility normalization for migrated rows whose initial hash was calculated
      // before FileObject SHA-256 values were available. Do not touch updatedAt/revision.
      await transaction.$executeRaw(
        Prisma.sql`UPDATE "working_artifacts" SET "contentHash" = ${contentHash} WHERE "id" = ${previous.id}::uuid`,
      );
      return {
        record: { ...previous, contentHash },
        previousStorageKey: previous.storageKey,
        unchanged: true,
        orphanedFileObjectIds: [],
      };
    }
    const data = {
      kind: input.kind,
      name: input.name,
      directory: input.directory,
      type: input.type,
      tags: input.tags ?? [],
      payload: jsonValue(input.payload),
      metadata: jsonValue(input.metadata),
      originalFileName: input.originalFileName ?? null,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      storageKey: input.storageKey ?? null,
      sourceRunId: input.sourceRunId ?? null,
      sourceArtifactId: input.sourceArtifactId ?? null,
      contentHash,
      freshness: 'CURRENT' as const,
      availability: 'AVAILABLE' as const,
    };
    if (input.expectedRevision !== undefined && previous?.revision !== input.expectedRevision)
      throw new Error('WORKING_ARTIFACT_REVISION_CONFLICT');
    let baseRecord;
    if (previous) {
      const changed = await transaction.workingArtifact.updateMany({
        where: { id: previous.id, revision: previous.revision },
        data: { ...data, revision: { increment: 1 } },
      });
      if (changed.count === 0) throw new Error('WORKING_ARTIFACT_REVISION_CONFLICT');
      baseRecord = await transaction.workingArtifact.findUniqueOrThrow({
        where: { id: previous.id },
      });
    } else {
      if (input.expectedRevision !== undefined && input.expectedRevision !== 0)
        throw new Error('WORKING_ARTIFACT_REVISION_CONFLICT');
      baseRecord = await transaction.workingArtifact.create({
        data: { projectId, workflowRunId, nodeId, artifactKey, ...data },
      });
    }
    const previousFileIds = previous?.files.map((item) => item.fileObjectId) ?? [];
    await transaction.workingArtifactFile.deleteMany({
      where: { projectId, workingArtifactId: baseRecord.id },
    });
    if (input.files?.length)
      await transaction.workingArtifactFile.createMany({
        data: input.files.map((file) => ({
          projectId,
          workflowRunId,
          workingArtifactId: baseRecord.id,
          fileObjectId: file.fileObjectId,
          role: file.role,
          sortOrder: file.sortOrder,
        })),
      });
    await transaction.workingArtifactDependency.deleteMany({
      where: { projectId, dependentArtifactId: baseRecord.id },
    });
    if (input.dependencies?.length)
      await transaction.workingArtifactDependency.createMany({
        data: input.dependencies.map((dependency) => ({
          projectId,
          workflowRunId,
          dependentArtifactId: baseRecord.id,
          sourceType: dependency.sourceType,
          sourceNodeId: dependency.sourceNodeId ?? null,
          sourceArtifactId: dependency.sourceArtifactId ?? null,
          sourceKey: dependency.sourceKey,
          sourceRevision: dependency.sourceRevision ?? null,
          sourceHash: dependency.sourceHash ?? null,
        })),
      });
    if (input.files?.length)
      await transaction.fileObject.updateMany({
        where: { projectId, id: { in: input.files.map((file) => file.fileObjectId) } },
        data: { status: 'AVAILABLE', orphanedAt: null },
      });
    const currentFileIds = new Set(input.files?.map((item) => item.fileObjectId) ?? []);
    const replacedFileObjectIds = previousFileIds.filter((id) => !currentFileIds.has(id));
    const orphanedFileObjectIds: string[] = [];
    for (const fileObjectId of replacedFileObjectIds) {
      const [artifactLinks, materials, uploadItems] = await Promise.all([
        transaction.workingArtifactFile.count({ where: { projectId, fileObjectId } }),
        transaction.effectImportMaterial.count({ where: { projectId, fileObjectId } }),
        transaction.effectImportUploadItem.count({ where: { projectId, fileObjectId } }),
      ]);
      if (artifactLinks + materials + uploadItems === 0) orphanedFileObjectIds.push(fileObjectId);
    }
    if (orphanedFileObjectIds.length)
      await transaction.fileObject.updateMany({
        where: { projectId, id: { in: orphanedFileObjectIds } },
        data: { status: 'ORPHANED', orphanedAt: new Date() },
      });
    if (previous)
      await this.markArtifactDependentsStaleInTransaction(
        transaction,
        projectId,
        workflowRunId,
        previous.id,
      );
    const record = await transaction.workingArtifact.findUniqueOrThrow({
      where: { id: baseRecord.id },
      include: workingArtifactInclude,
    });
    return {
      record,
      previousStorageKey: previous?.storageKey ?? null,
      unchanged: false,
      orphanedFileObjectIds,
    };
  }

  async commitValidatedArtifacts(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifacts: Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }>,
  ) {
    return this.prisma.$transaction((transaction) =>
      this.commitValidatedArtifactsInTransaction(
        transaction,
        projectId,
        workflowRunId,
        nodeId,
        artifacts,
      ),
    );
  }

  async commitValidatedArtifactsInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifacts: Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }>,
  ) {
    const results = [];
    for (const artifact of artifacts) {
      const result = await this.upsertArtifactInTransaction(
        transaction,
        projectId,
        workflowRunId,
        nodeId,
        artifact.artifactKey,
        artifact.input,
      );
      results.push({ artifactKey: artifact.artifactKey, ...result });
    }
    return results;
  }

  private async validateArtifactInputsInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    input: WorkingArtifactUpsertInput,
  ): Promise<void> {
    const fileIds = [...new Set(input.files?.map((file) => file.fileObjectId) ?? [])];
    if (fileIds.length) {
      const count = await transaction.fileObject.count({
        where: { projectId, workflowRunId, id: { in: fileIds } },
      });
      if (count !== fileIds.length) throw new Error('WORKING_FILE_OBJECT_NOT_FOUND');
    }
    for (const dependency of input.dependencies ?? []) {
      if (dependency.sourceType === 'WORKING_ARTIFACT') {
        const source = dependency.sourceArtifactId
          ? await transaction.workingArtifact.findFirst({
              where: {
                id: dependency.sourceArtifactId,
                projectId,
                workflowRunId,
              },
            })
          : await transaction.workingArtifact.findFirst({
              where: { projectId, workflowRunId, artifactKey: dependency.sourceKey },
            });
        const keyMatches =
          source?.artifactKey === dependency.sourceKey ||
          (dependency.sourceKey.startsWith('effective-video-config:') &&
            source?.artifactKey ===
              dependency.sourceKey.replace('effective-video-config:', 'global-video-config:'));
        if (!source || !keyMatches || source.revision !== dependency.sourceRevision)
          throw new Error('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
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
        if (!state) throw new Error('WORKFLOW_NODE_STATE_DEPENDENCY_CONFLICT');
        if (dependency.sourceType === 'EXECUTION_INPUT') {
          if (!dependency.sourceHash || state.executionInputHash !== dependency.sourceHash)
            throw new Error('WORKFLOW_EXECUTION_INPUT_DEPENDENCY_CONFLICT');
        } else if (state.revision !== dependency.sourceRevision)
          throw new Error('WORKFLOW_NODE_STATE_DEPENDENCY_CONFLICT');
      }
    }
  }

  private async markNodeDependentsStaleInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    nodeId: string,
  ): Promise<void> {
    const dependencies = await transaction.workingArtifactDependency.findMany({
      where: {
        projectId,
        workflowRunId,
        sourceType: 'EXECUTION_INPUT',
        OR: [{ sourceNodeId: nodeId }, { sourceKey: nodeId }],
      },
      select: { dependentArtifactId: true },
    });
    await this.markArtifactIdsAndDependentsStaleInTransaction(
      transaction,
      projectId,
      workflowRunId,
      dependencies.map((item) => item.dependentArtifactId),
    );
  }

  private async markArtifactDependentsStaleInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    sourceArtifactId: string,
  ): Promise<void> {
    const dependencies = await transaction.workingArtifactDependency.findMany({
      where: { projectId, workflowRunId, sourceType: 'WORKING_ARTIFACT', sourceArtifactId },
      select: { dependentArtifactId: true },
    });
    await this.markArtifactIdsAndDependentsStaleInTransaction(
      transaction,
      projectId,
      workflowRunId,
      dependencies.map((item) => item.dependentArtifactId),
    );
  }

  private async markArtifactIdsAndDependentsStaleInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    initialIds: string[],
  ): Promise<void> {
    const seen = new Set<string>();
    let pending = [...new Set(initialIds)];
    while (pending.length) {
      const current = pending.filter((id) => !seen.has(id));
      if (!current.length) break;
      current.forEach((id) => seen.add(id));
      await transaction.workingArtifact.updateMany({
        where: { projectId, workflowRunId, id: { in: current } },
        data: { freshness: 'STALE' },
      });
      const next = await transaction.workingArtifactDependency.findMany({
        where: {
          projectId,
          workflowRunId,
          sourceType: 'WORKING_ARTIFACT',
          sourceArtifactId: { in: current },
        },
        select: { dependentArtifactId: true },
      });
      pending = next.map((item) => item.dependentArtifactId);
    }
  }

  deleteArtifact(projectId: string, workflowRunId: string, nodeId: string, artifactKey: string) {
    return this.prisma.$transaction(async (transaction) => {
      const record = await transaction.workingArtifact.findUnique({
        where: {
          projectId_workflowRunId_nodeId_artifactKey: {
            projectId,
            workflowRunId,
            nodeId,
            artifactKey,
          },
        },
        include: workingArtifactInclude,
      });
      if (record) {
        await this.markArtifactDependentsStaleInTransaction(
          transaction,
          projectId,
          workflowRunId,
          record.id,
        );
        await transaction.workingArtifact.delete({ where: { id: record.id } });
        const fileObjectIds = record.files.map((item) => item.fileObjectId);
        if (fileObjectIds.length)
          await transaction.fileObject.updateMany({
            where: { projectId, id: { in: fileObjectIds } },
            data: { status: 'ORPHANED', orphanedAt: new Date() },
          });
      }
      return record;
    });
  }

  enqueueCleanup(projectId: string, storageKey: string, reason: string) {
    const nextAttemptAt = new Date(Date.now() + cleanupGraceMs());
    return this.prisma.storageCleanupTask.upsert({
      where: { projectId_storageKey: { projectId, storageKey } },
      create: {
        projectId,
        storageKey,
        reason,
        nextAttemptAt,
      },
      update: {
        reason,
        nextAttemptAt,
      },
    });
  }
}
