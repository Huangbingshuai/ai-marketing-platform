// Offline, guarded restoration from retained output/packaging snapshots. No task dispatch.
// Run from repository root: node --env-file=.env apps/api/scripts/recover-deleted-mix-template.mjs
//   projectId deletedTemplateId survivingTemplateId backupDirectory [--apply]
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function restorationVariants(items, snapshotOf) {
  const ids = new Set();
  return items.map((item) => {
    const snapshot = snapshotOf(item),
      variant = snapshot?.variant;
    if (
      !variant ||
      item.variantId !== variant.id ||
      ids.has(variant.id) ||
      !variant.slots?.length ||
      !Object.keys(variant.bindings ?? {}).length
    )
      throw new Error('INVALID_RECOVERY_VARIANT');
    ids.add(variant.id);
    for (const [slotId, sourceId] of Object.entries(variant.bindings)) {
      const source = variant.bindingSources?.[slotId];
      const clip = snapshot.clips?.find(
        (clip) => clip.slotId === slotId && clip.materialId === sourceId,
      );
      if (
        !source ||
        source.artifactId !== sourceId ||
        !source.artifactKey?.startsWith('render-clip:') ||
        !source.artifactRevision ||
        !source.artifactContentHash ||
        variant.bindingRevisions?.[slotId] !== source.artifactRevision ||
        !clip ||
        clip.fileObjectId !== source.fileObjectId ||
        clip.contentHash !== source.contentHash
      )
        throw new Error('UNPROVEN_RECOVERY_SOURCE');
    }
    return structuredClone(variant);
  });
}

// Presentation order only: source identity is always the frozen variant ID above.
export function orderedSnapshotItems(items, snapshotOf) {
  return [...items].sort(
    (a, b) =>
      snapshotOf(a).variant.name.localeCompare(snapshotOf(b).variant.name, 'zh-CN', {
        numeric: true,
      }) || a.variantId.localeCompare(b.variantId),
  );
}

export function repairedDeletionRuns(receiptRuns, foreignRuns) {
  const foreign = new Set(foreignRuns);
  if (!foreign.size || !foreignRuns.every((id) => receiptRuns.includes(id)))
    throw new Error('RECOVERY_RECEIPT_CHANGED');
  return receiptRuns.filter((id) => !foreign.has(id));
}

async function main() {
  const [projectId, deletedTemplateId, templateId, backupDirectory, ...options] =
    process.argv.slice(2);
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  if (
    ![projectId, deletedTemplateId, templateId].every((id) => uuid.test(id ?? '')) ||
    deletedTemplateId === templateId ||
    !backupDirectory ||
    options.some((v) => v !== '--apply')
  )
    throw new Error(
      'USAGE: projectId deletedTemplateId survivingTemplateId backupDirectory [--apply]',
    );
  const apply = options.includes('--apply'),
    backupDir = resolve(backupDirectory);
  await access(resolve(backupDir, 'pre-repair.dump'));
  const backup = JSON.parse(await readFile(resolve(backupDir, 'retained-sources.json'), 'utf8'));
  if (backup.projectId !== projectId || backup.templateId !== templateId)
    throw new Error('BACKUP_SCOPE_MISMATCH');
  const require = createRequire(resolve('apps/api/package.json'));
  const build = resolve(process.env.RECOVERY_API_BUILD ?? 'apps/api/dist-dev');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require(resolve(build, 'generated/prisma/client.js'));
  const { workingArtifactContentHash } = require(
    resolve(build, 'platform/workflow/workflow-working.repository.js'),
  );
  const { workflowStateHash } = require(resolve(build, 'platform/workflow/workflow-state-hash.js'));
  const { templateConfigurationHash } = require(
    resolve(build, 'workflows/effect/template-mix/template-mix-lifecycle.js'),
  );
  const { visualHash, validatePackagingCheckpoint } = require(
    resolve(build, 'workflows/effect/template-mix/effect-packaging.domain.js'),
  );
  const {
    packagingVisualVariant,
    packagingTimelineDuration,
    effectTemplateMixContentDuration,
  } = require('@ai-marketing/contracts');
  const { ConfigService } = require('@nestjs/config');
  const config = new ConfigService(process.env);
  const { createTosClient } = require(resolve(build, 'platform/file/tos-storage.adapter.js'));
  const tos = createTosClient(config);
  const { stat } = await import('node:fs/promises');
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const json = (v) => JSON.parse(JSON.stringify(v));
  try {
    const receipt = await db.effectTemplateDeletion.findUniqueOrThrow({
      where: { projectId_templateId: { projectId, templateId: deletedTemplateId } },
    });
    if (await db.effectTemplateDeletion.count({ where: { projectId, templateId } }))
      throw new Error('SURVIVING_TEMPLATE_WAS_DELETED');
    const mixTasks = await db.effectTemplateMixAiRun.findMany({ where: { projectId, templateId } });
    const foreignRuns = [...new Set(mixTasks.map((task) => task.workflowRunId))];
    const remainingRuns = repairedDeletionRuns(receipt.workflowRunIds, foreignRuns);
    if (receipt.status !== 'COMPLETED' || !remainingRuns.length)
      throw new Error('UNSAFE_RECOVERY_RECEIPT');
    const outputRuns = await db.effectFinalOutputRun.findMany({
      where: { projectId, templateId },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    const packagingRuns = await db.effectPackagingRun.findMany({
      where: { projectId, templateId, status: 'COMPLETED' },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    const plans = [];
    // Only restore complete, persisted per-Run snapshots. Copied AI checkpoints cannot prove manual edits.
    for (const runId of foreignRuns) {
      const pack = packagingRuns
        .filter((r) => r.workflowRunId === runId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const output = outputRuns
        .filter((r) => r.workflowRunId === runId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const task = mixTasks.find((r) => r.workflowRunId === runId && r.status === 'COMPLETED');
      if (!task) throw new Error('RECOVERY_TASK_NOT_TERMINAL');
      if (!pack && !output) continue;
      const retainedItems = pack?.items ?? output.items;
      if (pack && retainedItems.some((i) => i.status !== 'COMPLETED'))
        throw new Error('INCOMPLETE_PACKAGING');
      const snapshotOf = pack ? (i) => i.snapshot : (i) => i.snapshot.timeline;
      const items = orderedSnapshotItems(retainedItems, snapshotOf);
      const variants = restorationVariants(items, snapshotOf);
      const template = structuredClone(task.inputSnapshot.template);
      if (
        !template ||
        template.id !== templateId ||
        variants.some(
          (v) =>
            templateConfigurationHash({ ...template, slots: v.slots }) !==
            templateConfigurationHash(template),
        )
      )
        throw new Error('RECOVERY_TEMPLATE_CONFIG_UNPROVEN');
      const entry = {
        id: templateId,
        filledTemplateHash: templateConfigurationHash(template),
        materialRoleOverrides: task.inputSnapshot.manualMaterialRoles ?? {},
        workspace: { editVersion: 1, template, variants },
      };
      const draft = { schemaVersion: 1, activeTemplateId: templateId, templates: [entry] };
      const sources = new Map(
        variants.flatMap((v) => Object.values(v.bindingSources)).map((s) => [s.artifactId, s]),
      );
      const deps = (ids) =>
        [...new Set(ids)].map((id) => {
          const s = sources.get(id);
          return {
            sourceType: 'WORKING_ARTIFACT',
            sourceNodeId: 'SEGMENT_RENDER',
            sourceArtifactId: id,
            sourceKey: s.artifactKey,
            sourceRevision: s.artifactRevision,
            sourceHash: s.artifactContentHash,
          };
        });
      const artifacts = [
        {
          artifactKey: `mix-template:${templateId}`,
          input: {
            kind: 'STRUCTURED',
            name: template.name,
            directory: 'EDITING_PROJECTS',
            type: 'MIX_TEMPLATE',
            tags: ['效果类', '混剪模板'],
            payload: { schemaVersion: 1, templateId, workspaceVersion: 1, template },
            metadata: { templateId, variantCount: variants.length },
            dependencies: deps(sources.keys()),
          },
        },
      ];
      for (let index = 0; index < variants.length; index++) {
        const v = variants[index],
          item = items[index],
          snapshot = snapshotOf(item);
        const artifactKey = `timeline-project:${templateId}:${v.id}`;
        const original = (pack ? snapshot.dependencies : item.snapshot.dependencies)?.find(
          (d) => d.artifactKey === artifactKey,
        );
        const input = {
          kind: 'STRUCTURED',
          name: v.name,
          directory: 'EDITING_PROJECTS',
          type: 'TIMELINE_PROJECT',
          tags: ['效果类', '时间轴工程'],
          payload: {
            schemaVersion: 1,
            templateId,
            templateVersion: template.editVersion,
            variant: packagingVisualVariant(v),
          },
          metadata: { templateId, variantId: v.id, durationSeconds: packagingTimelineDuration(v) },
          dependencies: deps(Object.values(v.bindings)),
        };
        // Original identities and revisions are reusable only if the full canonical hash agrees.
        const exact = original && original.contentHash === workingArtifactContentHash(input);
        if (original && !exact) throw new Error('RECOVERY_VISUAL_HASH_MISMATCH');
        artifacts.push({ artifactKey, input, ...(exact ? { original } : {}) });
        if (!pack && !exact) throw new Error('OUTPUT_VISUAL_HASH_NOT_RESTORABLE');
        if (pack) {
          validatePackagingCheckpoint(snapshot, item.checkpoint, true, false);
          const cp = structuredClone(item.checkpoint);
          delete cp.musicTaskId;
          delete cp.musicSubmissionPending;
          artifacts.push({
            artifactKey: `timeline-package:${templateId}:${v.id}`,
            package: {
              item,
              cp,
              duration: effectTemplateMixContentDuration(v, cp),
              sourceTimelineHash: visualHash(v),
            },
          });
        }
      }
      plans.push({ runId, draft, artifacts, sources: [...sources.values()] });
    }
    if (!plans.length) throw new Error('NO_RELIABLE_RECOVERY_SNAPSHOTS');
    const allSources = plans.flatMap((p) => p.sources);
    const audioIds = plans.flatMap((p) =>
      p.artifacts.flatMap((a) =>
        a.package
          ? [
              ...Object.values(a.package.cp.voices ?? {}),
              ...Object.values(a.package.cp.captionVoices ?? {}),
              ...(a.package.cp.music ? [a.package.cp.music] : []),
            ].map((v) => v.fileObjectId)
          : [],
      ),
    );
    const files = await db.fileObject.findMany({
      where: {
        projectId,
        id: { in: [...new Set([...allSources.map((s) => s.fileObjectId), ...audioIds])] },
        status: 'AVAILABLE',
      },
    });
    const fileMap = new Map(files.map((f) => [f.id, f]));
    if (new Set([...allSources.map((s) => s.fileObjectId), ...audioIds]).size !== files.length)
      throw new Error('RECOVERY_FILES_MISSING');
    for (const s of allSources) {
      const a = await db.workingArtifact.findFirst({
        where: {
          projectId,
          id: s.artifactId,
          nodeId: 'SEGMENT_RENDER',
          artifactKey: s.artifactKey,
        },
      });
      if (!a || fileMap.get(s.fileObjectId)?.sha256 !== s.contentHash)
        throw new Error('RECOVERY_SOURCE_IDENTITY_MISMATCH');
    }
    // Storage read-only metadata check, bounded parallelism. No generation or public URLs.
    for (let start = 0; start < files.length; start += 8)
      await Promise.all(
        files.slice(start, start + 8).map(async (file) => {
          const size = tos
            ? Number(
                (await tos.headObject({ bucket: process.env.TOS_BUCKET, key: file.storageKey }))
                  .data['content-length'],
              )
            : (
                await stat(
                  resolve(process.env.LOCAL_STORAGE_ROOT ?? '.local-storage', file.storageKey),
                )
              ).size;
          if (size !== file.sizeBytes) throw new Error('RECOVERY_STORAGE_FILE_MISSING');
        }),
      );
    const report = {
      mode: apply ? 'apply' : 'dry-run',
      projectId,
      templateId,
      receiptId: receipt.id,
      restored: plans.map((p) => ({
        runId: p.runId,
        variants: p.draft.templates[0].workspace.variants.length,
        packaged: p.artifacts.filter((a) => a.package).length,
      })),
      unrecoverableDraftRunIds: foreignRuns.filter((id) => !plans.some((p) => p.runId === id)),
      checkedFiles: files.length,
    };
    await writeFile(
      resolve(backupDir, apply ? 'recovery-intent.json' : 'recovery-preview.json'),
      JSON.stringify(report, null, 2),
    );
    if (!apply) {
      console.log(JSON.stringify(report));
      return;
    }
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
        const current = await tx.effectTemplateDeletion.findUniqueOrThrow({
          where: { id: receipt.id },
        });
        if (workflowStateHash(current.workflowRunIds) !== workflowStateHash(receipt.workflowRunIds))
          throw new Error('RECOVERY_RECEIPT_CHANGED');
        for (const model of [
          'effectTemplateMixAiRun',
          'effectPackagingRun',
          'effectFinalOutputRun',
        ]) {
          if (
            await tx[model].count({
              where: {
                projectId,
                workflowRunId: { in: foreignRuns },
                status: { in: ['QUEUED', 'RUNNING'] },
              },
            })
          )
            throw new Error('RECOVERY_ACTIVE_TASK');
        }
        if (
          (await tx.workingArtifact.count({
            where: { projectId, workflowRunId: { in: foreignRuns }, nodeId: 'TEMPLATE_MIX' },
          })) ||
          (await tx.workflowNodeState.count({
            where: { projectId, workflowRunId: { in: foreignRuns }, nodeId: 'TEMPLATE_MIX' },
          }))
        )
          throw new Error('RECOVERY_ALREADY_RESTORED_OR_EDITED');
        for (const old of mixTasks) {
          const latest = await tx.effectTemplateMixAiRun.findFirstOrThrow({
            where: { projectId, id: old.id },
          });
          if (
            latest.updatedAt.getTime() !== old.updatedAt.getTime() ||
            latest.templateId !== templateId ||
            workflowStateHash(latest.inputSnapshot) !== workflowStateHash(old.inputSnapshot)
          )
            throw new Error('RECOVERY_TASK_CHANGED');
        }
        for (const run of [...outputRuns, ...packagingRuns])
          for (const old of run.items) {
            const model = 'checkpoint' in old ? 'effectPackagingItem' : 'effectFinalOutputItem';
            const latest = await tx[model].findFirstOrThrow({ where: { projectId, id: old.id } });
            if (workflowStateHash(json(latest)) !== workflowStateHash(json(old)))
              throw new Error('RECOVERY_SNAPSHOT_CHANGED');
          }
        const latestFiles = await tx.fileObject.findMany({
          where: { projectId, id: { in: files.map((f) => f.id) }, status: 'AVAILABLE' },
        });
        if (
          latestFiles.length !== files.length ||
          latestFiles.some(
            (f) =>
              f.sha256 !== fileMap.get(f.id).sha256 ||
              f.sizeBytes !== fileMap.get(f.id).sizeBytes ||
              f.storageKey !== fileMap.get(f.id).storageKey,
          )
        )
          throw new Error('RECOVERY_FILE_CHANGED');
        const fallback = await tx.workflowRun.findFirstOrThrow({
          where: {
            projectId,
            id: receipt.fallbackRunId,
            workflow: 'EFFECT',
            workflowSpace: 'EFFECT',
          },
        });
        if (
          await tx.effectTemplateDeletion.count({
            where: { projectId, workflowRunIds: { has: fallback.id } },
          })
        )
          throw new Error('RECOVERY_FALLBACK_DELETED');
        await tx.effectTemplateDeletion.update({
          where: { id: receipt.id },
          data: { workflowRunIds: remainingRuns },
        });
        for (const runId of foreignRuns) {
          const run = await tx.workflowRun.findFirstOrThrow({
            where: { projectId, id: runId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
          });
          await tx.workflowRun.update({
            where: { id: runId },
            data: {
              forkTemplateId: templateId,
              ...(remainingRuns.includes(run.parentWorkflowRunId)
                ? { parentWorkflowRunId: receipt.fallbackRunId }
                : {}),
            },
          });
        }
        for (const plan of plans) {
          const runId = plan.runId;
          const visuals = new Map();
          for (const artifact of plan.artifacts) {
            let input = artifact.input;
            if (artifact.package) {
              const { item, cp, duration, sourceTimelineHash } = artifact.package;
              const visual = visuals.get(item.variantId);
              const wanted = [
                ...new Set(
                  [
                    ...Object.values(cp.voices ?? {}),
                    ...Object.values(cp.captionVoices ?? {}),
                    ...(cp.music ? [cp.music] : []),
                  ].map((f) => f.fileObjectId),
                ),
              ];
              input = {
                kind: 'STRUCTURED',
                name: `${item.name} · 智能包装`,
                directory: 'EDITING_PROJECTS',
                type: 'TIMELINE_PROJECT',
                payload: {
                  schemaVersion: 1,
                  templateId,
                  variantId: item.variantId,
                  sourceTimelineHash,
                  visualArtifactId: visual.id,
                  visualRevision: visual.revision,
                  duration,
                  ...cp,
                  mix: { originalVolume: 0.15, bgmVolume: cp.music?.volume ?? 0, ducking: true },
                  subtitleStyle: 'standard',
                },
                files: wanted.map((id, sortOrder) => {
                  const f = fileMap.get(id);
                  return {
                    fileObjectId: id,
                    role: id === cp.music?.fileObjectId ? 'BGM' : 'VOICE',
                    sortOrder,
                    originalFileName: f.originalFileName,
                    mimeType: f.mimeType,
                    sha256: f.sha256,
                  };
                }),
                dependencies: [
                  {
                    sourceType: 'WORKING_ARTIFACT',
                    sourceNodeId: 'TEMPLATE_MIX',
                    sourceArtifactId: visual.id,
                    sourceKey: visual.artifactKey,
                    sourceRevision: visual.revision,
                    sourceHash: visual.contentHash,
                  },
                ],
              };
            }
            const row = await tx.workingArtifact.create({
              data: {
                id: artifact.original?.artifactId ?? randomUUID(),
                projectId,
                workflowRunId: runId,
                nodeId: 'TEMPLATE_MIX',
                artifactKey: artifact.artifactKey,
                kind: input.kind,
                name: input.name,
                directory: input.directory,
                type: input.type,
                tags: input.tags ?? [],
                payload: json(input.payload),
                metadata: json(input.metadata ?? null),
                revision: artifact.original?.revision ?? 1,
                contentHash: workingArtifactContentHash(input),
                freshness: 'CURRENT',
                availability: 'AVAILABLE',
              },
            });
            if (artifact.artifactKey.startsWith('timeline-project:'))
              visuals.set(input.payload.variant.id, row);
            if (input.dependencies?.length)
              await tx.workingArtifactDependency.createMany({
                data: input.dependencies.map((d) => ({
                  ...d,
                  projectId,
                  workflowRunId: runId,
                  dependentArtifactId: row.id,
                })),
              });
            if (input.files?.length)
              await tx.workingArtifactFile.createMany({
                data: input.files.map(({ fileObjectId, role, sortOrder }) => ({
                  projectId,
                  workflowRunId: runId,
                  workingArtifactId: row.id,
                  fileObjectId,
                  role,
                  sortOrder,
                })),
              });
          }
          await tx.workflowNodeState.create({
            data: {
              projectId,
              workflowRunId: runId,
              nodeId: 'TEMPLATE_MIX',
              state: json(plan.draft),
              contentHash: workflowStateHash(plan.draft),
              executionInputHash: workflowStateHash(plan.draft),
              revision: 1,
            },
          });
        }
      },
      { timeout: 60_000 },
    );
    await writeFile(resolve(backupDir, 'recovery-applied.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    // SDK/Prisma errors can contain private input or connection details.
    console.error(
      error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)
        ? error.message
        : 'RECOVERY_FAILED',
    );
    process.exitCode = 1;
  });
