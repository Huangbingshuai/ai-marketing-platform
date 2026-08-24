import type {
  AssetDirectory,
  AssetType,
  AssetWorkflow,
  AssetWorkflowSpace,
  WorkingArtifactKind,
} from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  type WorkflowNodeState,
  type WorkingArtifact,
} from '../../generated/prisma/client';
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
};

const jsonValue = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === undefined || value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

@Injectable()
export class WorkflowWorkingRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  findRun(projectId: string, workflowRunId: string) {
    return this.prisma.workflowRun.findFirst({ where: { id: workflowRunId, projectId } });
  }

  findActiveRun(projectId: string, workflow: AssetWorkflow, space: AssetWorkflowSpace) {
    return this.prisma.workflowRun.findFirst({
      where: { projectId, workflow, workflowSpace: space, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
  }

  findActiveRunWithNodeStates(
    projectId: string,
    workflow: AssetWorkflow,
    space: AssetWorkflowSpace,
  ) {
    return this.prisma.workflowRun.findFirst({
      where: { projectId, workflow, workflowSpace: space, status: 'ACTIVE' },
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
  ): Promise<{ record: WorkflowNodeState; unchanged: boolean; conflict: boolean }> {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findFirst({
        where: { id: workflowRunId, projectId, status: 'ACTIVE' },
      });
      if (!run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
      const current = await transaction.workflowNodeState.findUnique({
        where: { projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId } },
      });
      if (
        current &&
        (current.contentHash === contentHash || workflowStateHash(current.state) === contentHash)
      )
        return { record: current, unchanged: true, conflict: false };
      if (current) {
        if (expectedRevision !== current.revision)
          return { record: current, unchanged: false, conflict: true };
        const record = await transaction.workflowNodeState.update({
          where: { id: current.id },
          data: {
            state: jsonValue(state),
            contentHash,
            schemaVersion,
            revision: { increment: 1 },
            savedAt: new Date(),
          },
        });
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
        },
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
  ): Promise<WorkflowNodeState> {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findFirst({
        where: { id: workflowRunId, projectId, status: 'ACTIVE' },
      });
      if (!run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
      const unique = { projectId, workflowRunId, nodeId };
      const current = await transaction.workflowNodeState.findUnique({
        where: { projectId_workflowRunId_nodeId: unique },
      });
      return current
        ? transaction.workflowNodeState.update({
            where: { id: current.id },
            data: {
              state: jsonValue(state),
              contentHash,
              schemaVersion,
              revision: { increment: 1 },
              savedAt: new Date(),
            },
          })
        : transaction.workflowNodeState.create({
            data: { ...unique, state: jsonValue(state), contentHash, schemaVersion },
          });
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
          status: 'ACTIVE',
          ...(filters.workflow ? { workflow: filters.workflow } : {}),
          ...(filters.space ? { workflowSpace: filters.space } : {}),
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
  }

  findArtifact(projectId: string, artifactId: string) {
    return this.prisma.workingArtifact.findFirst({ where: { id: artifactId, projectId } });
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
    });
  }

  async upsertArtifact(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifactKey: string,
    input: WorkingArtifactUpsertInput,
  ): Promise<{ record: WorkingArtifact; previousStorageKey: string | null }> {
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
  ): Promise<{ record: WorkingArtifact; previousStorageKey: string | null }> {
    const run = await transaction.workflowRun.findFirst({
      where: { id: workflowRunId, projectId, status: 'ACTIVE' },
    });
    if (!run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
    const unique = { projectId, workflowRunId, nodeId, artifactKey };
    const previous = await transaction.workingArtifact.findUnique({
      where: { projectId_workflowRunId_nodeId_artifactKey: unique },
    });
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
    };
    const record = previous
      ? await transaction.workingArtifact.update({ where: { id: previous.id }, data })
      : await transaction.workingArtifact.create({
          data: { projectId, workflowRunId, nodeId, artifactKey, ...data },
        });
    return { record, previousStorageKey: previous?.storageKey ?? null };
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
      });
      if (record) await transaction.workingArtifact.delete({ where: { id: record.id } });
      return record;
    });
  }

  enqueueCleanup(projectId: string, storageKey: string, reason: string) {
    return this.prisma.storageCleanupTask.upsert({
      where: { projectId_storageKey: { projectId, storageKey } },
      create: { projectId, storageKey, reason },
      update: { reason, nextAttemptAt: new Date() },
    });
  }
}
