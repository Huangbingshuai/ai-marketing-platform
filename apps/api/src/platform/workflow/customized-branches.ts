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
import { workflowStateHash } from './workflow-state-hash';
import { readCustomizedExtractionResult } from './customized-inherited-extraction';

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
  nodeId = 'SOURCE_IMPORT',
) {
  await lockCustomizedProject(tx, projectId);
  const active = await activeRun(tx, projectId);
  if (!active) return customizedConflict('定制类工作流不存在');
  if (
    active.editSessionNodeId === nodeId &&
    (active.id === runId || active.parentWorkflowRunId === runId)
  )
    return active;
  if (active.id !== runId || active.editSessionNodeId)
    return customizedConflict('请先保存或取消当前编辑，再切换版本');
  if (
    await tx.customizedExtractionTask.count({
      where: { projectId, workflowRunId: runId, status: { in: ['QUEUED', 'RUNNING'] } },
    })
  )
    return customizedConflict('信息提炼仍在执行，请等待完成后编辑');
  const key = nodeId === 'SOURCE_IMPORT' ? CUSTOMIZED_SOURCE_ARTIFACT_KEY : 'customized-brief';
  const artifacts = await tx.workingArtifact.findMany({
    where: { projectId, workflowRunId: runId },
    include: { dependencies: true, files: true },
  });
  const baseline = artifacts.find((a) => a.artifactKey === key);
  if (!baseline) return active;
  const child = await tx.workflowRun.create({
    data: {
      ...customizedScope(projectId),
      activeKey: null,
      parentWorkflowRunId: runId,
      forkNodeId: nodeId,
      currentNodeId: nodeId,
      editSessionNodeId: nodeId,
      editSessionPurpose: 'MANUAL',
      editBaselineHash: baseline.contentHash,
    },
  });
  const states = await tx.workflowNodeState.findMany({
    where: { projectId, workflowRunId: runId },
  });
  const source = artifacts.find((a) => a.artifactKey === CUSTOMIZED_SOURCE_ARTIFACT_KEY);
  for (const state of states) {
    if (nodeId === 'SOURCE_IMPORT' && source && state.nodeId === 'SOURCE_IMPORT') continue;
    const { id: _id, createdAt: _created, updatedAt: _updated, ...data } = state;
    await tx.workflowNodeState.create({
      data: { ...data, workflowRunId: child.id, state: state.state as Prisma.InputJsonValue },
    });
  }
  // Script branches can have confirmed upstream copies without a page draft.
  // Seed only on explicit edit; a read/navigation must not manufacture draft revisions.
  if (source && (nodeId === 'SOURCE_IMPORT' || !states.some((s) => s.nodeId === 'SOURCE_IMPORT'))) {
    const state = restoreCustomizedImportDraft(source.payload);
    await tx.workflowNodeState.create({
      data: {
        projectId,
        workflowRunId: child.id,
        nodeId: 'SOURCE_IMPORT',
        schemaVersion: 3,
        state: state as unknown as Prisma.InputJsonValue,
        contentHash: workflowStateHash(state),
      },
    });
  }
  const ids = new Map<string, string>();
  for (const artifact of artifacts) {
    const {
      id: _id,
      dependencies: _deps,
      files: _files,
      createdAt,
      updatedAt: _updated,
      ...data
    } = artifact;
    const copy = await tx.workingArtifact.create({
      data: {
        ...data,
        workflowRunId: child.id,
        sourceArtifactId: artifact.sourceArtifactId ?? artifact.id,
        sourceRunId: artifact.sourceRunId ?? runId,
        payload: artifact.payload as Prisma.InputJsonValue,
        metadata:
          artifact.metadata === null
            ? Prisma.JsonNull
            : (artifact.metadata as Prisma.InputJsonValue),
        createdAt,
      },
    });
    ids.set(artifact.id, copy.id);
  }
  for (const artifact of artifacts)
    for (const dependency of artifact.dependencies) {
      const { id: _id, createdAt: _created, ...data } = dependency;
      await tx.workingArtifactDependency.create({
        data: {
          ...data,
          workflowRunId: child.id,
          dependentArtifactId: ids.get(artifact.id)!,
          sourceArtifactId: dependency.sourceArtifactId
            ? (ids.get(dependency.sourceArtifactId) ?? dependency.sourceArtifactId)
            : null,
        },
      });
    }
  for (const artifact of artifacts)
    for (const file of artifact.files) {
      const { id: _id, createdAt: _created, ...data } = file;
      await tx.workingArtifactFile.create({
        data: { ...data, workflowRunId: child.id, workingArtifactId: ids.get(artifact.id)! },
      });
    }
  const sourceFingerprint = source
    ? workflowStateHash({
        artifactId: source.sourceArtifactId ?? source.id,
        revision: source.revision,
        payload: normalizeCustomizedImportDraft(source.payload),
      })
    : undefined;
  const resolved = await readCustomizedExtractionResult(tx, projectId, runId, sourceFingerprint);
  const result = resolved?.record;
  if (result) {
    const { id: _id, createdAt: _created, updatedAt: _updated, ...data } = result;
    await tx.customizedExtractionResult.create({
      data: {
        ...data,
        workflowRunId: child.id,
        ...(resolved?.inherited &&
        sourceFingerprint &&
        artifacts.find((a) => a.artifactKey === 'customized-brief')?.freshness !== 'STALE'
          ? { sourceFingerprint }
          : {}),
        generatedResult: data.generatedResult as Prisma.InputJsonValue,
        draftResult: data.draftResult as Prisma.InputJsonValue,
        manualOverrides: data.manualOverrides as Prisma.InputJsonValue,
      },
    });
  }
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
  const tasks = await tx.customizedExtractionTask.findMany({
    where: { projectId, workflowRunId: child.id },
    select: { id: true },
  });
  const artifacts = await tx.customizedExtractionArtifact.findMany({
    where: { projectId, taskId: { in: tasks.map((t) => t.id) } },
    select: { storageKey: true },
  });
  await tx.storageCleanupTask.createMany({
    data: [...new Set(artifacts.map((a) => a.storageKey))].map((storageKey) => ({
      projectId,
      storageKey,
      reason: 'CUSTOMIZED_EDIT_CANCELLED',
    })),
    skipDuplicates: true,
  });
  await tx.jobOutbox.deleteMany({
    where: {
      projectId,
      jobType: 'CUSTOMIZED_EXTRACTION',
      aggregateId: { in: tasks.map((t) => t.id) },
    },
  });
  await tx.workingArtifactDependency.deleteMany({ where: { projectId, workflowRunId: child.id } });
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
  nodeId = 'SOURCE_IMPORT',
) {
  await lockCustomizedProject(tx, projectId);
  const active = await activeRun(tx, projectId);
  if (
    active?.id !== runId ||
    !active.parentWorkflowRunId ||
    active.editSessionNodeId !== nodeId ||
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
