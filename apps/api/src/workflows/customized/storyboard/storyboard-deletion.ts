import type { DeleteStoryboardScriptResult, StoryboardInput } from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { Prisma } from '../../../generated/prisma/client';
import { PROJECT_STORAGE_COLUMNS } from '../../../platform/file/storage-reference-columns';
import {
  customizedScope,
  customizedConflict,
} from '../../../platform/workflow/customized-branches';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

export function storyboardDescendants(
  runs: { id: string; parentWorkflowRunId: string | null }[],
  root: string | null,
) {
  const ids = new Set<string>(root ? [root] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of runs)
      if (run.parentWorkflowRunId && ids.has(run.parentWorkflowRunId) && !ids.has(run.id)) {
        ids.add(run.id);
        changed = true;
      }
  }
  return [...ids];
}

// Caller holds the customized project lock. No external IO occurs in this transaction.
export async function deleteStoryboardScript(
  tx: Prisma.TransactionClient,
  projectId: string,
  scriptId: string,
  expectedRevision: number,
): Promise<DeleteStoryboardScriptResult> {
  const script = await tx.customizedStoryboardScript.findFirst({
    where: { projectId, id: scriptId },
  });
  if (!script) throw new ApiHttpException('脚本已删除或不存在', 404, 'ASSET_NOT_FOUND');
  if (script.revision !== expectedRevision)
    customizedConflict('脚本已在其他窗口更新，请重新加载后删除');
  const runs = await tx.workflowRun.findMany({ where: customizedScope(projectId) });
  if (script.workflowRunId && !runs.some((r) => r.id === script.workflowRunId))
    customizedConflict('脚本分支不属于定制类工作流');
  const removedRunIds = storyboardDescendants(runs, script.workflowRunId);
  const runScope = { projectId, workflowRunId: { in: removedRunIds } };
  const fallback = runs.find((r) => r.id === script.sourceRunId && !removedRunIds.includes(r.id));
  if (!fallback) customizedConflict('脚本来源版本不可用，无法安全删除');
  const removedScripts = await tx.customizedStoryboardScript.findMany({
    where: {
      projectId,
      OR: [
        { id: scriptId },
        { workflowRunId: { in: removedRunIds } },
        { sourceRunId: { in: removedRunIds } },
      ],
    },
  });
  const removedScriptIds = removedScripts.map((s) => s.id);
  const removedSet = new Set(removedScriptIds);
  const artifacts = await tx.workingArtifact.findMany({
    where: runScope,
    select: { id: true, storageKey: true, payload: true },
  });
  const artifactIds = artifacts.map((a) => a.id);
  const assets = await tx.asset.findMany({
    where: {
      projectId,
      storageWorkflow: 'CUSTOMIZED',
      workflowSpace: 'CUSTOMIZED_PROJECT',
      OR: [{ sourceRunId: { in: removedRunIds } }, { sourceArtifactId: { in: artifactIds } }],
    },
    select: { id: true, storageKey: true },
  });
  const assetIds = assets.map((a) => a.id);
  const versions = await tx.assetVersion.findMany({
    where: { projectId, assetId: { in: assetIds } },
    select: { storageKey: true },
  });
  const files = await tx.fileObject.findMany({
    where: {
      projectId,
      OR: [
        { workflowRunId: { in: removedRunIds } },
        { artifactLinks: { some: { workflowRunId: { in: removedRunIds } } } },
        { revisionLinks: { some: { workflowRunId: { in: removedRunIds } } } },
      ],
    },
    select: { id: true, storageKey: true },
  });
  const history = await tx.workingArtifactRevisionSnapshot.findMany({
    where: runScope,
    select: { snapshot: true },
  });
  const removedConcepts = [
    ...removedScripts.flatMap((s) => [s.draft, s.generated]),
    ...artifacts.map((a) => a.payload),
    ...history.map((h) => (h.snapshot as { payload?: unknown } | null)?.payload),
  ].flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const candidate = value as { id?: string; name?: string; synopsis?: string };
    return candidate.id &&
      removedSet.has(candidate.id) &&
      typeof candidate.name === 'string' &&
      typeof candidate.synopsis === 'string'
      ? [{ name: candidate.name, synopsis: candidate.synopsis }]
      : [];
  });
  const extractionTasks = await tx.customizedExtractionTask.findMany({
    where: runScope,
    select: { id: true },
  });
  const extractionFiles = await tx.customizedExtractionArtifact.findMany({
    where: { projectId, taskId: { in: extractionTasks.map((t) => t.id) } },
    select: { storageKey: true },
  });
  const extractionHolds = await tx.customizedExtractionFileHold.findMany({
    where: { projectId, taskId: { in: extractionTasks.map((t) => t.id) } },
    select: { storageKey: true },
  });
  const productionTasks = await tx.customizedProductionTask.findMany({
    where: runScope,
    select: { id: true },
  });
  const keys = [
    ...new Set(
      [...artifacts, ...assets, ...versions, ...files, ...extractionFiles, ...extractionHolds]
        .flatMap((f) => (f.storageKey ? [f.storageKey] : []))
        .concat(
          history.flatMap((h) => {
            const value = h.snapshot as { storageKey?: unknown } | null;
            return typeof value?.storageKey === 'string' ? [value.storageKey] : [];
          }),
        ),
    ),
  ];

  // Shared generation batches belong to the retained upstream, not to one script Run.
  const tasks = await tx.customizedStoryboardTask.findMany({ where: { projectId } });
  const removedTaskIds: string[] = [];
  for (const task of tasks) {
    const input = task.inputSnapshot as unknown as StoryboardInput;
    const remaining = input.scriptIds.filter((id) => !removedSet.has(id));
    if (removedRunIds.includes(task.workflowRunId) || !remaining.length) {
      removedTaskIds.push(task.id);
      continue;
    }
    const existingConcepts = input.existingConcepts.filter(
      (c) =>
        !removedSet.has(c.scriptId ?? '') &&
        !removedConcepts.some((value) => c.name === value.name && c.synopsis === value.synopsis),
    );
    if (
      remaining.length === input.scriptIds.length &&
      existingConcepts.length === input.existingConcepts.length
    )
      continue;
    const nextInput = {
      ...input,
      scriptIds: remaining,
      settings: { ...input.settings, variantCount: remaining.length },
      existingConcepts,
    };
    const completed = await tx.customizedStoryboardScript.count({
      where: { projectId, id: { in: remaining }, status: 'COMPLETED' },
    });
    await tx.customizedStoryboardTask.update({
      where: { id: task.id },
      data: {
        inputSnapshot: nextInput as unknown as Prisma.InputJsonValue,
        inputHash: workflowStateHash(nextInput),
        autoRetryScriptIds: task.autoRetryScriptIds.filter((id) => !removedSet.has(id)),
        errorMessage: null,
        ...(!['QUEUED', 'RUNNING'].includes(task.status) && completed === remaining.length
          ? { status: 'COMPLETED', attemptToken: null, leaseExpiresAt: null }
          : {}),
      },
    });
    const concept = await tx.customizedStoryboardStep.findFirst({
      where: { projectId, taskId: task.id, nodeId: 'CONCEPT', scriptId: '' },
    });
    if (concept?.output) {
      const value = concept.output as { concepts?: { scriptId: string }[] };
      if (Array.isArray(value.concepts))
        await tx.customizedStoryboardStep.update({
          where: { id: concept.id },
          data: {
            output: {
              ...value,
              concepts: value.concepts.filter((c) => !removedSet.has(c.scriptId)),
            } as Prisma.InputJsonValue,
          },
        });
    }
  }
  await tx.customizedStoryboardStep.deleteMany({
    where: { projectId, scriptId: { in: removedScriptIds } },
  });
  await tx.customizedStoryboardScript.deleteMany({
    where: { projectId, id: { in: removedScriptIds } },
  });
  await tx.jobOutbox.deleteMany({
    where: {
      projectId,
      jobType: {
        in: [
          'CUSTOMIZED_STORYBOARD',
          'CUSTOMIZED_EXTRACTION',
          'CUSTOMIZED_PRODUCTION',
          'CUSTOMIZED_ASSETS',
        ],
      },
      aggregateId: {
        in: [
          ...removedTaskIds,
          ...extractionTasks.map((t) => t.id),
          ...productionTasks.map((t) => t.id),
        ],
      },
    },
  });
  await tx.customizedStoryboardTask.deleteMany({
    where: { projectId, id: { in: removedTaskIds } },
  });
  await tx.assetOperationReceipt.deleteMany({ where: { projectId, assetId: { in: assetIds } } });
  await tx.assetVersion.deleteMany({ where: { projectId, assetId: { in: assetIds } } });
  await tx.asset.deleteMany({ where: { projectId, id: { in: assetIds } } });

  const externalDependents = await tx.workingArtifactDependency.findMany({
    where: {
      projectId,
      sourceArtifactId: { in: artifactIds },
      workflowRunId: { notIn: removedRunIds },
    },
    select: { dependentArtifactId: true },
  });
  await tx.workingArtifact.updateMany({
    where: { projectId, id: { in: externalDependents.map((d) => d.dependentArtifactId) } },
    data: { freshness: 'STALE' },
  });
  await tx.workingArtifactDependency.deleteMany({
    where: {
      projectId,
      OR: [{ workflowRunId: { in: removedRunIds } }, { sourceArtifactId: { in: artifactIds } }],
    },
  });

  // File bindings can belong to retained Runs. Move ownership before cascading the tree.
  await tx.fileObject.updateMany({ where: runScope, data: { workflowRunId: fallback!.id } });
  const activeRemoved = runs.some((r) => removedRunIds.includes(r.id) && r.activeKey === 'ACTIVE');
  await tx.workflowRun.updateMany({
    where: { ...customizedScope(projectId), id: { in: removedRunIds } },
    data: { activeKey: null, parentWorkflowRunId: null },
  });
  await tx.workflowRun.deleteMany({
    where: { ...customizedScope(projectId), id: { in: removedRunIds } },
  });
  if (activeRemoved)
    await tx.workflowRun.update({
      where: { id: fallback!.id },
      data: {
        activeKey: 'ACTIVE',
        status: 'ACTIVE',
        currentNodeId: 'STORYBOARD',
        lastActiveAt: new Date(),
      },
    });

  // Prevent stale saved selection/legacy navigation snapshots from restoring deleted scripts.
  const states = await tx.workflowNodeState.findMany({
    where: {
      projectId,
      nodeId: { in: ['STORYBOARD_SETTINGS', 'STORYBOARD'] },
      workflowRun: customizedScope(projectId),
    },
  });
  for (const state of states) {
    const old = state.state as Record<string, unknown>;
    const next = { ...old };
    if (removedSet.has(String(next.selectedScriptId))) next.selectedScriptId = null;
    if (removedSet.has(String(next.activeScriptId))) next.activeScriptId = null;
    if (removedSet.has(String(next.mainCandidateId))) next.mainCandidateId = null;
    if (Array.isArray(next.scripts))
      next.scripts = next.scripts.filter((s: { id?: string }) => !removedSet.has(String(s.id)));
    if (workflowStateHash(next) !== state.contentHash)
      await tx.workflowNodeState.update({
        where: { id: state.id },
        data: {
          state: next as Prisma.InputJsonValue,
          contentHash: workflowStateHash(next),
          revision: { increment: 1 },
        },
      });
  }
  const legacyRefs = Prisma.sql`SELECT "snapshot"->>'storageKey' AS key FROM "working_artifact_revision_snapshots"`;
  const refs = Prisma.join(
    [
      ...PROJECT_STORAGE_COLUMNS.filter(
        ([table]) => !['file_objects', 'storage_cleanup_tasks'].includes(table),
      ).map(
        ([table, column]) =>
          Prisma.sql`SELECT ${Prisma.raw(`"${column}"`)} AS key FROM ${Prisma.raw(`"${table}"`)}`,
      ),
      legacyRefs,
    ],
    ' UNION ALL ',
  );
  const heldFileKeys = keys.length
    ? await tx.$queryRaw<{ key: string }[]>(
        Prisma.sql`SELECT DISTINCT r.key FROM (${refs}) r WHERE r.key IN (${Prisma.join(keys)})`,
      )
    : [];
  const heldFiles = new Set(heldFileKeys.map((row) => row.key));
  await tx.fileObject.deleteMany({
    where: {
      projectId,
      id: { in: files.filter((file) => !heldFiles.has(file.storageKey)).map((file) => file.id) },
      artifactLinks: { none: {} },
      revisionLinks: { none: {} },
      materials: { none: {} },
      uploadItems: { none: {} },
      packagingFiles: { none: {} },
      voicePreviews: { none: {} },
      finalOutputItems: { none: {} },
    },
  });
  // The existing durable storage queue retries failures across API restarts.
  const allRefs = Prisma.join(
    [
      ...PROJECT_STORAGE_COLUMNS.filter(([table]) => table !== 'storage_cleanup_tasks').map(
        ([table, column]) =>
          Prisma.sql`SELECT ${Prisma.raw(`"${column}"`)} AS key FROM ${Prisma.raw(`"${table}"`)}`,
      ),
      legacyRefs,
    ],
    ' UNION ALL ',
  );
  const heldObjectKeys = keys.length
    ? await tx.$queryRaw<{ key: string }[]>(
        Prisma.sql`SELECT DISTINCT r.key FROM (${allRefs}) r WHERE r.key IN (${Prisma.join(keys)})`,
      )
    : [];
  const heldObjects = new Set(heldObjectKeys.map((row) => row.key));
  const disposable = keys.filter((key) => !heldObjects.has(key));
  await tx.storageCleanupTask.createMany({
    data: disposable.map((storageKey) => ({
      projectId,
      storageKey,
      reason: 'CUSTOMIZED_SCRIPT_DELETED',
    })),
    skipDuplicates: true,
  });
  return {
    scriptId,
    removedScriptIds,
    removedRunIds,
    fallbackRunId: fallback!.id,
    activeRunChanged: activeRemoved,
  };
}
