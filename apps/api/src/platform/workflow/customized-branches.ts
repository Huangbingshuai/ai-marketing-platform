import {
  CUSTOMIZED_SOURCE_ARTIFACT_KEY,
  restoreCustomizedImportDraft,
  validateCustomizedImportDraft,
  normalizeCustomizedImportDraft,
} from '@ai-marketing/contracts';
import { HttpStatus } from '@nestjs/common';
import { ApiHttpException } from '../../common/api-http-exception';
import { Prisma } from '../../generated/prisma/client';
import type { WorkflowWorkingRepository } from './workflow-working.repository';
import { importFileFormat } from '../file/import-file-validation';

export const customizedScope = (projectId: string) => ({
  projectId,
  workflow: 'CUSTOMIZED' as const,
  workflowSpace: 'CUSTOMIZED_PROJECT' as const,
});
export const customizedConflict = (message: string): never => {
  throw new ApiHttpException(message, HttpStatus.CONFLICT, 'CONFLICT');
};
export const lockCustomizedProject = (tx: Prisma.TransactionClient, projectId: string) =>
  tx.$queryRaw(Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid FOR UPDATE`);

const activeRun = (tx: Prisma.TransactionClient, projectId: string) =>
  tx.workflowRun.findFirst({
    where: {
      ...customizedScope(projectId),
      activeKey: 'ACTIVE',
      status: { in: ['ACTIVE', 'PAUSED'] },
    },
  });
const sourceArtifact = (tx: Prisma.TransactionClient, projectId: string, runId: string) =>
  tx.workingArtifact.findFirst({
    where: {
      projectId,
      workflowRunId: runId,
      nodeId: 'SOURCE_IMPORT',
      artifactKey: CUSTOMIZED_SOURCE_ARTIFACT_KEY,
      availability: 'AVAILABLE',
    },
  });

export async function assertCustomizedImportEditable(
  tx: Prisma.TransactionClient,
  projectId: string,
  runId: string,
) {
  await lockCustomizedProject(tx, projectId);
  const run = await activeRun(tx, projectId);
  if (!run || run.id !== runId) return customizedConflict('工作流版本已切换或已完成，请重新加载');
  if (run.editSessionNodeId && run.editSessionNodeId !== 'SOURCE_IMPORT')
    return customizedConflict('当前编辑节点不匹配');
  if (run.editSessionNodeId !== 'SOURCE_IMPORT' && (await sourceArtifact(tx, projectId, runId)))
    return customizedConflict('请先进入资料编辑，再上传文件');
  return run;
}

/** Same hidden-child lifecycle as effect, using generic draft/artifact storage only. */
export async function beginCustomizedEdit(
  tx: Prisma.TransactionClient,
  projectId: string,
  runId: string,
) {
  await lockCustomizedProject(tx, projectId);
  const active = await activeRun(tx, projectId);
  if (!active) return customizedConflict('定制类工作流不存在');
  if (
    active.editSessionNodeId === 'SOURCE_IMPORT' &&
    (active.id === runId || active.parentWorkflowRunId === runId)
  )
    return active;
  if (active.id !== runId || active.editSessionNodeId)
    return customizedConflict('请先保存或取消当前编辑，再切换版本');
  const baseline = await sourceArtifact(tx, projectId, runId);
  if (!baseline) return active;
  const state = await tx.workflowNodeState.findUnique({
    where: {
      projectId_workflowRunId_nodeId: { projectId, workflowRunId: runId, nodeId: 'SOURCE_IMPORT' },
    },
  });
  if (!state) return customizedConflict('资料草稿不存在，请重新加载');
  const child = await tx.workflowRun.create({
    data: {
      ...customizedScope(projectId),
      activeKey: null,
      parentWorkflowRunId: runId,
      forkNodeId: 'SOURCE_IMPORT',
      currentNodeId: 'SOURCE_IMPORT',
      editSessionNodeId: 'SOURCE_IMPORT',
      editSessionPurpose: 'MANUAL',
      editBaselineHash: baseline.contentHash,
    },
  });
  await tx.workflowNodeState.create({
    data: {
      projectId,
      workflowRunId: child.id,
      nodeId: 'SOURCE_IMPORT',
      schemaVersion: state.schemaVersion,
      revision: state.revision,
      state: state.state as Prisma.InputJsonValue,
      contentHash: state.contentHash,
      executionInputHash: state.executionInputHash,
      executionInputSchemaVersion: state.executionInputSchemaVersion,
    },
  });
  // Clone the confirmed baseline so the shared commit helper preserves business revision.
  await tx.workingArtifact.create({
    data: {
      projectId,
      workflowRunId: child.id,
      nodeId: baseline.nodeId,
      artifactKey: baseline.artifactKey,
      kind: baseline.kind,
      name: baseline.name,
      directory: baseline.directory,
      type: baseline.type,
      tags: baseline.tags,
      payload: baseline.payload as Prisma.InputJsonValue,
      revision: baseline.revision,
      contentHash: baseline.contentHash,
      createdAt: baseline.createdAt,
    },
  });
  await tx.workflowRun.update({
    where: { id: runId },
    data: { activeKey: null, status: 'PAUSED' },
  });
  return tx.workflowRun.update({ where: { id: child.id }, data: { activeKey: 'ACTIVE' } });
}

async function returnToParent(
  tx: Prisma.TransactionClient,
  projectId: string,
  child: { id: string; parentWorkflowRunId: string | null },
) {
  const parent = await tx.workflowRun.findFirst({
    where: {
      ...customizedScope(projectId),
      id: child.parentWorkflowRunId ?? '',
      status: { in: ['ACTIVE', 'PAUSED'] },
    },
  });
  if (!parent) return customizedConflict('原版本不可用，请重新加载');
  await tx.workflowRun.delete({ where: { id: child.id } });
  return tx.workflowRun.update({
    where: { id: parent.id },
    data: { activeKey: 'ACTIVE', status: 'ACTIVE', lastActiveAt: new Date() },
  });
}

export async function cancelCustomizedEdit(
  tx: Prisma.TransactionClient,
  projectId: string,
  runId: string,
) {
  await lockCustomizedProject(tx, projectId);
  const active = await activeRun(tx, projectId);
  if (
    active?.id !== runId ||
    !active.parentWorkflowRunId ||
    active.editSessionNodeId !== 'SOURCE_IMPORT' ||
    active.branchPublishedAt
  )
    return customizedConflict('编辑作用域已变化，请重新加载');
  return returnToParent(tx, projectId, active);
}

export async function saveCustomizedVersion(
  tx: Prisma.TransactionClient,
  repository: WorkflowWorkingRepository,
  projectId: string,
  runId: string,
  expectedRevision: number,
) {
  await lockCustomizedProject(tx, projectId);
  const run = await activeRun(tx, projectId);
  if (!run || run.id !== runId) return customizedConflict('工作流版本已切换，请重新加载');
  const state = await tx.workflowNodeState.findUnique({
    where: {
      projectId_workflowRunId_nodeId: { projectId, workflowRunId: runId, nodeId: 'SOURCE_IMPORT' },
    },
  });
  if (!state || state.revision !== expectedRevision)
    return customizedConflict('资料草稿已更新，请重新加载后保存版本');
  let draft;
  try {
    draft = restoreCustomizedImportDraft(state.state);
  } catch {
    throw new ApiHttpException('资料草稿格式不正确', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
  }
  const ids = draft.materials.map((item) => item.assetId);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
  )
    throw new ApiHttpException('资料引用无效或重复', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
  const assets = await tx.asset.findMany({
    where: {
      projectId,
      id: { in: ids },
      storageWorkflow: 'CUSTOMIZED',
      workflowSpace: 'CUSTOMIZED_PROJECT',
      directory: 'SOURCE_MATERIALS',
      type: 'SOURCE_MATERIAL',
      archivedAt: null,
      status: { not: 'UNAVAILABLE' },
      hasFile: true,
    },
  });
  const versions = await tx.assetVersion.findMany({
    where: {
      projectId,
      OR: draft.materials.map((item) => ({ assetId: item.assetId, version: item.assetVersion })),
    },
  });
  if (
    assets.length !== ids.length ||
    draft.materials.some(
      (item) =>
        !versions.some(
          (version) =>
            version.assetId === item.assetId &&
            version.version === item.assetVersion &&
            version.storageKey &&
            version.sizeBytes > 0 &&
            version.status !== 'UNAVAILABLE',
        ),
    )
  )
    return customizedConflict('资料版本不可用，请重新上传后保存版本');
  const imageIds = new Set(
    versions
      .filter((version) => importFileFormat(version.originalFileName)?.kind === 'IMAGE')
      .map((version) => version.assetId),
  );
  const payload = normalizeCustomizedImportDraft(draft, imageIds);
  if (
    versions.some((version) => {
      const format = importFileFormat(version.originalFileName);
      return (
        !format ||
        (version.mimeType !== format.mime &&
          version.mimeType !== 'application/octet-stream' &&
          !(format.signature === 'TEXT' && version.mimeType === 'text/plain'))
      );
    })
  )
    throw new ApiHttpException(
      '资料文件类型不支持或 MIME 不匹配，请重新上传',
      HttpStatus.BAD_REQUEST,
      'FILE_TYPE_UNSUPPORTED',
    );
  if (
    payload.materials.some(
      (item) => item.category === 'VISUAL_REFERENCE' && !imageIds.has(item.assetId),
    )
  )
    throw new ApiHttpException(
      '视觉参考区域只支持图片，请将文档上传到视频创作简报区域。',
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
    );
  const baseline = await sourceArtifact(tx, projectId, runId);
  if (
    baseline &&
    JSON.stringify(normalizeCustomizedImportDraft(baseline.payload, imageIds)) ===
      JSON.stringify(payload)
  ) {
    const unchangedRun =
      run.parentWorkflowRunId && run.editSessionNodeId === 'SOURCE_IMPORT'
        ? await returnToParent(tx, projectId, run)
        : run;
    return { run: unchangedRun, createdBranch: false, unchanged: true };
  }
  const completeness = validateCustomizedImportDraft(payload);
  const documentIds = new Set(
    versions
      .filter((version) => importFileFormat(version.originalFileName)?.kind === 'DOCUMENT')
      .map((version) => version.assetId),
  );
  if (
    !completeness.length &&
    !payload.materials.some((item) => item.category === 'BRIEF' && documentIds.has(item.assetId))
  )
    completeness.push('请上传至少一份视频创作简报文档');
  if (completeness.length)
    throw new ApiHttpException(completeness.join('；'), HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
  const [result] = await repository.commitValidatedArtifactsInTransaction(
    tx,
    projectId,
    runId,
    'SOURCE_IMPORT',
    [
      {
        artifactKey: CUSTOMIZED_SOURCE_ARTIFACT_KEY,
        input: {
          kind: 'STRUCTURED',
          name: '定制类资料包',
          directory: 'SOURCE_MATERIALS',
          type: 'SOURCE_MATERIAL',
          payload,
        },
      },
    ],
  );
  if (run.parentWorkflowRunId && run.editSessionNodeId === 'SOURCE_IMPORT') {
    if (result!.record.contentHash === run.editBaselineHash) {
      const parent = await returnToParent(tx, projectId, run);
      return { run: parent, createdBranch: false, unchanged: true };
    }
    const published = await tx.workflowRun.update({
      where: { id: runId },
      data: {
        branchPublishedAt: new Date(),
        editSessionNodeId: null,
        editSessionPurpose: null,
        editBaselineHash: null,
      },
    });
    return { run: published, createdBranch: true, unchanged: false };
  }
  return { run, createdBranch: false, unchanged: result!.unchanged };
}

export async function activateCustomizedBranch(
  tx: Prisma.TransactionClient,
  projectId: string,
  runId: string,
  nodeId: string,
) {
  await lockCustomizedProject(tx, projectId);
  const active = await activeRun(tx, projectId);
  if (active?.editSessionNodeId) return customizedConflict('请先保存或取消当前编辑，再切换版本');
  const target = await tx.workflowRun.findFirst({
    where: {
      ...customizedScope(projectId),
      id: runId,
      status: { in: ['ACTIVE', 'PAUSED'] },
    },
  });
  if (!target || (target.parentWorkflowRunId && !target.branchPublishedAt))
    return customizedConflict('所选版本不可用，请重新加载版本树');
  if (active && active.id !== target.id)
    await tx.workflowRun.update({
      where: { id: active.id },
      data: { activeKey: null, status: 'PAUSED' },
    });
  return tx.workflowRun.update({
    where: { id: target.id },
    data: {
      activeKey: 'ACTIVE',
      status: 'ACTIVE',
      currentNodeId: nodeId,
      lastActiveAt: new Date(),
    },
  });
}
