import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type {
  EffectTemplateMixDraft,
  EffectTemplateMixVariant,
  FinalOutputSnapshot,
  PackagingCheckpoint,
  EffectTemplateMixWorkspaceData,
  EffectWorkflowBranchTreeData,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  WorkflowWorkingRepository,
  workingArtifactInclude,
  type WorkingArtifactUpsertInput,
} from '../../../platform/workflow/workflow-working.repository';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import type { EffectTemplateMixService } from '../template-mix/effect-template-mix.service';
import {
  artifactVisitor,
  packagingClips,
  packagingSnapshot,
  visualHash,
} from '../template-mix/effect-packaging.domain';
import { EffectPackagingRepository } from '../template-mix/effect-packaging.repository';
import { EffectFinalOutputService } from './effect-final-output.service';

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

// Optional reproduction against a named local project: every write and Outbox stays in an
// uncommitted transaction. This verifies real saved inputs without dispatching paid work.
it.skipIf(process.env.EFFECT_OUTPUT_LIVE_PROJECT_TEST !== '1')(
  'accepts all affected projects from the local workbench without dispatching work',
  async () => {
    const projectId = process.env.EFFECT_OUTPUT_TEST_PROJECT_ID!;
    const workflowRunId = process.env.EFFECT_OUTPUT_TEST_WORKFLOW_RUN_ID!;
    const templateId = process.env.EFFECT_OUTPUT_TEST_TEMPLATE_ID!;
    expect(projectId && workflowRunId && templateId).toBeTruthy();
    const response = await fetch(
      `http://localhost:3100/api/projects/${encodeURIComponent(projectId)}/workflows/effect/template-mix?workflowRunId=${encodeURIComponent(workflowRunId)}`,
    );
    expect(response.ok).toBe(true);
    const { data: workspace } = (await response.json()) as { data: EffectTemplateMixWorkspaceData };
    const treeResponse = await fetch(
      `http://localhost:3100/api/projects/${encodeURIComponent(projectId)}/workflow-runs/effect/branches`,
    );
    expect(treeResponse.ok).toBe(true);
    const { data: tree } = (await treeResponse.json()) as { data: EffectWorkflowBranchTreeData };
    expect(tree.activeWorkflowRunId).toBe(workflowRunId);
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('LOCAL_PROJECT_REFRESH_TEST_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const scopedDb = new Proxy(tx, {
              get(target, key) {
                return key === '$transaction'
                  ? (fn: (client: typeof tx) => unknown) => fn(tx)
                  : Reflect.get(target, key);
              },
            }) as unknown as PrismaService;
            const working = new WorkflowWorkingRepository(scopedDb);
            const service = new EffectFinalOutputService(
              scopedDb,
              {
                workspace: async () => workspace,
              } as unknown as EffectTemplateMixService,
              working,
              {} as StoragePort,
              {
                getEffectBranchTree: async () => tree,
              } as unknown as WorkflowWorkingService,
            );
            const run = await tx.effectFinalOutputRun.findFirst({
              where: { projectId, workflowRunId, templateId },
              orderBy: { createdAt: 'desc' },
              include: { items: true },
            });
            const batchCount = await tx.effectFinalOutputRun.count({
              where: { projectId, workflowRunId, templateId },
            });
            const { effectTemplateMixSourceChanges } = await import('@ai-marketing/contracts');
            const variants = workspace.draft!.templates.find((entry) => entry.id === templateId)!
              .workspace.variants;
            const affected = variants.filter(
              (variant) => effectTemplateMixSourceChanges(variant, workspace.materials).length,
            );
            expect(affected.length).toBeGreaterThan(0);
            const sources = await working.listArtifacts(projectId, { workflowRunId });
            for (const variant of affected) {
              const updated = structuredClone(variant);
              for (const change of effectTemplateMixSourceChanges(variant, workspace.materials)) {
                expect(change.blockedReason, variant.name).toBeUndefined();
                updated.bindings[change.slotId] = change.material!.id;
                updated.bindingRevisions[change.slotId] = change.material!.artifactRevision;
                updated.offsets[change.slotId] = 0;
              }
              try {
                packagingClips(
                  updated,
                  workspace.materials,
                  artifactVisitor(sources as unknown as Parameters<typeof artifactVisitor>[0]),
                );
              } catch (error) {
                throw new Error(
                  `${variant.name}: ${error instanceof Error ? error.message : '来源校验失败'}`,
                  { cause: error },
                );
              }
            }
            const siblingBefore = await tx.workingArtifact.findMany({
              where: { projectId, nodeId: 'TEMPLATE_MIX', workflowRunId: { not: workflowRunId } },
              orderBy: { id: 'asc' },
            });
            const siblingDrafts = await tx.workflowNodeState.findMany({
              where: { projectId, nodeId: 'TEMPLATE_MIX', workflowRunId: { not: workflowRunId } },
              orderBy: { id: 'asc' },
            });
            const siblingItems = await tx.effectFinalOutputItem.findMany({
              where: { projectId, run: { workflowRunId: { not: workflowRunId } } },
              orderBy: { id: 'asc' },
            });
            const result = await service.updateSourceProjects(projectId, {
              workflowRunId,
              templateId,
              expectedDraftRevision: workspace.draftRevision!,
              variantIds: affected.map((variant) => variant.id),
            });
            if ('noChanges' in result) throw new Error('Expected source refresh task');
            const updated = await tx.effectFinalOutputItem.findMany({
              where: { runId: result.id },
              orderBy: { id: 'asc' },
            });
            for (const item of updated) {
              if (affected.some((variant) => variant.id === item.variantId)) {
                expect(item.status).toBe('QUEUED');
                const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
                expect(snapshot.sourceRefresh?.slots.length).toBeGreaterThan(0);
                expect(
                  effectTemplateMixSourceChanges(snapshot.timeline.variant, workspace.materials),
                ).toEqual([]);
              } else if (run)
                expect(item).toEqual(run.items.find((before) => before.id === item.id));
              else {
                expect(item.status).toBe('PENDING_RENDER');
                expect(
                  (item.snapshot as unknown as FinalOutputSnapshot).timeline.clips.length,
                ).toBeGreaterThan(0);
              }
            }
            expect(
              await tx.effectFinalOutputRun.count({
                where: { projectId, workflowRunId, templateId },
              }),
            ).toBe(batchCount || 1);
            expect(
              await tx.workingArtifact.findMany({
                where: { projectId, nodeId: 'TEMPLATE_MIX', workflowRunId: { not: workflowRunId } },
                orderBy: { id: 'asc' },
              }),
            ).toEqual(siblingBefore);
            expect(
              await tx.workflowNodeState.findMany({
                where: { projectId, nodeId: 'TEMPLATE_MIX', workflowRunId: { not: workflowRunId } },
                orderBy: { id: 'asc' },
              }),
            ).toEqual(siblingDrafts);
            expect(
              await tx.effectFinalOutputItem.findMany({
                where: { projectId, run: { workflowRunId: { not: workflowRunId } } },
                orderBy: { id: 'asc' },
              }),
            ).toEqual(siblingItems);
            // Retrying cannot create a second batch or another Outbox task.
            await expect(
              service.updateSourceProjects(projectId, {
                workflowRunId,
                templateId,
                expectedDraftRevision: workspace.draftRevision!,
                variantIds: affected.map((variant) => variant.id),
              }),
            ).rejects.toThrow('正在渲染');
            throw rollback;
          },
          { timeout: 120_000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
);
function wav(): Buffer {
  const bytes = Buffer.alloc(44 + 96_000);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(96_000, 40);
  return bytes;
}

// Outbox and all fixture writes remain invisible in this outer transaction and are rolled back.
// Storage and supplier interactions are explicit local test doubles; no paid task is dispatched.
it.skipIf(process.env.EFFECT_OUTPUT_DATABASE_TEST !== '1').each([
  { projectRefreshOnly: false, removal: false },
  { projectRefreshOnly: true, removal: false },
  { projectRefreshOnly: false, removal: true },
  { projectRefreshOnly: true, removal: true },
  { projectRefreshOnly: false, removal: 'all' },
  { projectRefreshOnly: true, removal: 'all' },
  { projectRefreshOnly: false, removal: 'mixed' },
  { projectRefreshOnly: true, removal: 'mixed' },
])(
  'source refresh preserves siblings and old delivery: %j',
  async ({ projectRefreshOnly, removal }) => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const projectId = randomUUID(),
      workflowRunId = randomUUID(),
      templateId = randomUUID();
    const rollback = new Error('SOURCE_REFRESH_TEST_ROLLBACK');
    const directory = await mkdtemp(join(tmpdir(), 'source-refresh-'));
    const mp4Path = join(directory, 'video.mp4'),
      wavPath = join(directory, 'voice.wav');
    const mp4 = Buffer.alloc(128);
    mp4.write('ftyp', 4);
    await writeFile(mp4Path, mp4);
    await writeFile(wavPath, wav());
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            await tx.project.create({ data: { id: projectId, name: '局部更新隔离回滚验收' } });
            await tx.workflowRun.create({
              data: {
                id: workflowRunId,
                projectId,
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                status: 'ACTIVE',
                activeKey: 'ACTIVE',
              },
            });
            const scopedDb = new Proxy(tx, {
              get(target, key) {
                return key === '$transaction'
                  ? (fn: (client: typeof tx) => unknown) => fn(tx)
                  : Reflect.get(target, key);
              },
            }) as unknown as PrismaService;
            const working = new WorkflowWorkingRepository(scopedDb);
            const files = await Promise.all(
              ['old-a', 'b', 'new-a', 'voice-a', 'voice-b', 'music'].map((name) =>
                tx.fileObject.create({
                  data: {
                    projectId,
                    workflowRunId,
                    nodeId: 'TEMPLATE_MIX',
                    originalFileName: name,
                    mimeType: 'audio/wav',
                    sizeBytes: 100,
                    storageKey: `test/${projectId}/${name}`,
                    sha256: name.padEnd(64, 'x'),
                  },
                }),
              ),
            );
            const insight = await tx.workingArtifact.create({
              data: {
                projectId,
                workflowRunId,
                nodeId: 'AI_EXTRACTION',
                artifactKey: `marketing-insight:${randomUUID()}`,
                kind: 'STRUCTURED',
                name: '已确认事实',
                directory: 'INSIGHTS',
                type: 'INSIGHT_RESULT',
                contentHash: 'i'.repeat(64),
                payload: { productName: '商品' },
              },
            });
            const prompt = await tx.workingArtifact.create({
              data: {
                projectId,
                workflowRunId,
                nodeId: 'PROMPT_GENERATION',
                artifactKey: `prompt-batch:${randomUUID()}`,
                kind: 'STRUCTURED',
                name: '已确认 Prompt',
                directory: 'EDITING_PROJECTS',
                type: 'TIMELINE_PROJECT',
                contentHash: 'p'.repeat(64),
                payload: {
                  items: [
                    { id: 'pr-a', content: '商品镜头甲' },
                    { id: 'pr-b', content: '商品镜头乙' },
                  ],
                },
                dependencies: {
                  create: [
                    {
                      sourceType: 'WORKING_ARTIFACT',
                      sourceArtifactId: insight.id,
                      sourceKey: insight.artifactKey,
                      sourceRevision: 1,
                    },
                  ],
                },
              },
            });
            const clipInput = (i: number, fileIndex: number): WorkingArtifactUpsertInput => ({
              kind: 'FILE',
              name: `镜头${i}`,
              directory: 'VIDEO_MATERIALS',
              type: 'VIDEO_MATERIAL',
              storageKey: files[fileIndex]!.storageKey,
              payload: {
                promptId: i === 0 ? 'pr-a' : 'pr-b',
                fileObjectId: files[fileIndex]!.id,
                contentHash: files[fileIndex]!.sha256,
                durationSeconds: 12,
                primaryPurpose: 'PRODUCT_DISPLAY',
                ratio: '9:16',
                resolution: '720p',
              },
              dependencies: [
                {
                  sourceType: 'WORKING_ARTIFACT',
                  sourceNodeId: 'PROMPT_GENERATION',
                  sourceArtifactId: prompt.id,
                  sourceKey: prompt.artifactKey,
                  sourceRevision: prompt.revision,
                  sourceHash: prompt.contentHash,
                },
              ],
            });
            const clips = await working.commitValidatedArtifactsInTransaction(
              tx,
              projectId,
              workflowRunId,
              'SEGMENT_RENDER',
              [0, 1].map((i) => ({ artifactKey: `render-clip:${i}`, input: clipInput(i, i) })),
            );
            const a = clips[0]!.record,
              b = clips[1]!.record;
            const makeVariant = (id: string, onlyB: boolean): EffectTemplateMixVariant => ({
              id,
              name: onlyB ? '未受影响成片' : '待更新成片',
              appliedTemplateVersion: 1,
              manualSlotIds: [],
              conflictSlotIds: [],
              voice: null,
              bgm: null,
              captions: [],
              status: 'CURRENT',
              subtitleStyle: 'standard',
              originalVolume: 0.15,
              slots: (onlyB ? ['b'] : ['a', 'b']).map((id) => ({
                id,
                label: id,
                role: 'PRODUCT',
                purpose: 'PRODUCT_DISPLAY',
                duration: 4,
                transition: '硬切',
              })),
              bindings: onlyB ? { b: b.id } : { a: a.id, b: b.id },
              bindingRevisions: onlyB ? { b: 1 } : { a: 1, b: 1 },
              offsets: onlyB ? { b: 1 } : { a: 3, b: 1 },
            });
            const variants = [makeVariant(randomUUID(), false), makeVariant(randomUUID(), true)];
            variants[0]!.audioLanes = { 'voice:a': 2, 'voice:b': 3, music: 1 };
            const draft: EffectTemplateMixDraft = {
              schemaVersion: 1,
              activeTemplateId: templateId,
              templates: [
                {
                  id: templateId,
                  workspace: {
                    editVersion: 1,
                    template: { name: '局部更新', editVersion: 1, slots: variants[0]!.slots },
                    variants,
                  },
                },
              ],
            };
            await tx.workflowNodeState.create({
              data: {
                projectId,
                workflowRunId,
                nodeId: 'TEMPLATE_MIX',
                state: json(draft),
                contentHash: workflowStateHash(draft),
              },
            });
            const sourceWorkspace = async () => {
              const [state, artifacts] = await Promise.all([
                tx.workflowNodeState.findFirstOrThrow({
                  where: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
                }),
                tx.workingArtifact.findMany({
                  where: { projectId, workflowRunId },
                  include: workingArtifactInclude,
                }),
              ]);
              return {
                draft: state.state,
                draftRevision: state.revision,
                artifacts,
                materials: artifacts
                  .filter((row) => row.artifactKey.startsWith('render-clip:'))
                  .map((row) => {
                    const payload = row.payload as {
                      fileObjectId: string;
                      contentHash: string;
                      promptId: string;
                    };
                    return {
                      id: row.id,
                      artifactId: row.id,
                      artifactKey: row.artifactKey,
                      artifactRevision: row.revision,
                      sourcePromptId: payload.promptId,
                      fileObjectId: payload.fileObjectId,
                      contentHash: payload.contentHash,
                      duration: 12,
                      available: row.freshness === 'CURRENT',
                      activeSource: !artifacts.some((artifact) =>
                        (
                          (artifact.payload as { removedSources?: { promptId: string }[] })
                            ?.removedSources ?? []
                        ).some((source) => source.promptId === payload.promptId),
                      ),
                      sourceRemoved: artifacts.some((artifact) =>
                        (
                          (artifact.payload as { removedSources?: { promptId: string }[] })
                            ?.removedSources ?? []
                        ).some((source) => source.promptId === payload.promptId),
                      ),
                      ratio: '9:16',
                    };
                  }),
              };
            };
            const visualInputs: Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }> =
              variants.map((variant) => ({
                artifactKey: `timeline-project:${templateId}:${variant.id}`,
                input: {
                  kind: 'STRUCTURED',
                  name: variant.name,
                  directory: 'EDITING_PROJECTS',
                  type: 'TIMELINE_PROJECT',
                  payload: { templateId, variant },
                  dependencies: Object.values(variant.bindings).map((id) => ({
                    sourceType: 'WORKING_ARTIFACT',
                    sourceNodeId: 'SEGMENT_RENDER',
                    sourceArtifactId: id,
                    sourceKey: id === a.id ? a.artifactKey : b.artifactKey,
                    sourceRevision: 1,
                  })),
                },
              }));
            const mix = {
              workspace: sourceWorkspace,
              outputSourceWorkspace: sourceWorkspace,
              prepareValidation: async () => ({
                variants: (json((await sourceWorkspace()).draft) as EffectTemplateMixDraft)
                  .templates[0]!.workspace.variants,
                inputs: visualInputs,
              }),
            } as unknown as EffectTemplateMixService;
            const workspace = await sourceWorkspace();
            const packageRows = variants.map((variant, index) => {
              const snapshot = packagingSnapshot(
                variant,
                workspace.materials as never,
                workspace.artifacts as never,
              );
              const checkpoint: PackagingCheckpoint = {
                narrationLayoutVersion: 'SLOT_V1',
                captionLayoutVersion: 'SEGMENT_V3',
                vision: snapshot.clips.map((clip) => ({
                  slotId: clip.slotId,
                  start: clip.start,
                  end: clip.start + 4,
                  description: '原镜头',
                })),
                script: snapshot.clips.map((clip) => ({
                  id: clip.slotId,
                  slotId: clip.slotId,
                  text: '原口播',
                  start: clip.start,
                  end: clip.start + 4,
                  factIds: [snapshot.facts[0]!.id],
                })),
                voices: Object.fromEntries(
                  snapshot.clips.map((clip) => [
                    clip.slotId,
                    {
                      fileObjectId: files[clip.slotId === 'a' ? 3 : 4]!.id,
                      start: clip.start,
                      duration: 2,
                      volume: 0.5,
                      segmentFrames: [48000],
                    },
                  ]),
                ),
                music: {
                  fileObjectId: files[5]!.id,
                  start: 0,
                  duration: snapshot.duration,
                  volume: 0.2,
                },
                captions: snapshot.clips.map((clip) => ({
                  id: clip.slotId,
                  voiceLineId: clip.slotId,
                  segmentIndex: 0,
                  segmentCount: 1,
                  text: '原口播',
                  start: clip.start,
                  end: clip.start + 2,
                })),
              };
              return {
                variantId: variant.id,
                name: variant.name,
                shardIndex: index,
                status: 'COMPLETED' as const,
                stage: 'READY',
                sourceTimelineHash: visualHash(variant),
                snapshot: json(snapshot),
                checkpoint: json(checkpoint),
              };
            });
            const packaging = await tx.effectPackagingRun.create({
              data: {
                projectId,
                workflowRunId,
                templateId,
                status: 'COMPLETED',
                idempotencyKey: 'package',
                requestHash: 'k'.repeat(64),
                items: { create: packageRows },
              },
              include: { items: true },
            });
            for (const item of packaging.items) {
              const cp = item.checkpoint as unknown as PackagingCheckpoint;
              await tx.effectPackagingFile.createMany({
                data: [
                  ...Object.entries(cp.voices!).map(([id, voice]) => ({
                    projectId,
                    itemId: item.id,
                    role: `voice-${id}`,
                    fileObjectId: voice.fileObjectId,
                  })),
                  {
                    projectId,
                    itemId: item.id,
                    role: 'music',
                    fileObjectId: cp.music!.fileObjectId,
                  },
                ],
              });
            }
            let uploads = 0,
              failUpload = false;
            const storage = {
              put: async (input: { sizeBytes: number }) => {
                if (failUpload) throw new Error('test storage failure');
                return { key: `test/${projectId}/upload-${++uploads}`, sizeBytes: input.sizeBytes };
              },
              delete: async () => undefined,
            } as unknown as StoragePort;
            const service = new EffectFinalOutputService(scopedDb, mix, working, storage, {
              getEffectBranchTree: async () => ({
                projectId,
                activeWorkflowRunId: workflowRunId,
                branches: [
                  {
                    workflowRunId,
                    parentWorkflowRunId: null,
                    forkNodeId: null,
                    forkTemplateId: null,
                    templates: [{ templateId }],
                  },
                ],
              }),
            } as unknown as WorkflowWorkingService);
            await service.upsertFromPackaging(projectId, workflowRunId, templateId);
            const output = await tx.effectFinalOutputRun.findFirstOrThrow({
              where: { projectId },
              include: { items: true },
            });
            if (!projectRefreshOnly) {
              await tx.effectFinalOutputRun.update({
                where: { id: output.id },
                data: {
                  status: 'QUEUED',
                },
              });
              await tx.effectFinalOutputItem.updateMany({
                where: { projectId, runId: output.id },
                data: { status: 'QUEUED' },
              });
              const firstClaim = await service.claim(projectId, output.id);
              for (const item of output.items)
                await service.upload(projectId, output.id, firstClaim.attemptToken!, item.id, {
                  path: mp4Path,
                  size: mp4.length,
                });
              await service.finish(projectId, output.id, firstClaim.attemptToken!);
            }
            expect((await service.get(projectId, output.id)).counts.stale).toBe(0);
            const target = output.items.find((item) => item.variantId === variants[0]!.id)!;
            const siblingId = output.items.find((item) => item.variantId === variants[1]!.id)!.id;
            const siblingBefore = await tx.effectFinalOutputItem.findUniqueOrThrow({
              where: { id: siblingId },
            });
            const oldFile = (
              await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: target.id } })
            ).fileObjectId;
            if (removal) {
              const allRemoved = removal === 'all';
              const mixed = removal === 'mixed';
              const baselineOutput = await tx.effectFinalOutputItem.findUniqueOrThrow({
                where: { id: target.id },
              });
              const outboxCount = await tx.jobOutbox.count({ where: { projectId } });
              const oldPackage = packaging.items.find(
                (item) => item.variantId === target.variantId,
              )!;
              if (mixed)
                await working.commitValidatedArtifactsInTransaction(
                  tx,
                  projectId,
                  workflowRunId,
                  'SEGMENT_RENDER',
                  [{ artifactKey: a.artifactKey, input: clipInput(0, 2) }],
                );
              await working.commitValidatedArtifactsInTransaction(
                tx,
                projectId,
                workflowRunId,
                'SEGMENT_RENDER',
                [
                  {
                    artifactKey: `render-batch:${randomUUID()}`,
                    input: {
                      kind: 'STRUCTURED',
                      name: '已保存删除',
                      directory: 'VIDEO_MATERIALS',
                      type: 'VIDEO_MATERIAL',
                      payload: {
                        clips: allRemoved
                          ? []
                          : mixed
                            ? [{ taskId: '0', promptId: 'pr-a' }]
                            : [{ taskId: '1', promptId: 'pr-b' }],
                        removedSources: allRemoved
                          ? [
                              { taskId: '0', promptId: 'pr-a' },
                              { taskId: '1', promptId: 'pr-b' },
                            ]
                          : mixed
                            ? [{ taskId: '1', promptId: 'pr-b' }]
                            : [{ taskId: '0', promptId: 'pr-a' }],
                      },
                    },
                  },
                ],
              );
              const before = await sourceWorkspace();
              await service.updateSourceProjects(projectId, {
                workflowRunId,
                templateId,
                expectedDraftRevision: before.draftRevision,
                variantIds: [target.variantId],
              });
              if (mixed) {
                // Neither a deletion nor its replacement is committed before the shared task succeeds.
                expect((await sourceWorkspace()).draft).toEqual(before.draft);
                expect(
                  (await tx.effectPackagingItem.findUniqueOrThrow({ where: { id: oldPackage.id } }))
                    .checkpoint,
                ).toEqual(oldPackage.checkpoint);
                let claim = await service.claim(projectId, output.id);
                await service.progress(
                  projectId,
                  output.id,
                  claim.attemptToken!,
                  target.id,
                  0,
                  '模拟模型失败',
                );
                await service.finish(projectId, output.id, claim.attemptToken!);
                expect((await sourceWorkspace()).draft).toEqual(before.draft);
                expect(
                  (await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: target.id } }))
                    .fileObjectId,
                ).toBe(oldFile);
                await service.retry(projectId, output.id);
                claim = await service.claim(projectId, output.id);
                const queued = claim.items!.find((item) => item.id === target.id)!
                  .snapshot as unknown as FinalOutputSnapshot;
                if (!projectRefreshOnly)
                  expect(queued.sourceRefresh!.previousOutputSnapshot).toEqual(
                    baselineOutput.snapshot,
                  );
                expect(queued.sourceRefresh!.removedSlotIds).toEqual(['b']);
                expect(queued.sourceRefresh!.slots.map((slot) => slot.slotId)).toEqual(['a']);
                expect(queued.timeline.variant.bindings).toEqual({ a: a.id });
                expect(queued.packaging.voices).toEqual({
                  a: (oldPackage.checkpoint as unknown as PackagingCheckpoint).voices!.a,
                });
                const prepared = await service.refreshTrims(
                  projectId,
                  output.id,
                  claim.attemptToken!,
                  target.id,
                  [{ slotId: 'a', offset: 5 }],
                );
                expect(prepared.snapshot.packaging.script).toEqual([]);
                await service.refreshCheckpoint(
                  projectId,
                  output.id,
                  claim.attemptToken!,
                  target.id,
                  'VOICE',
                  {
                    vision: [{ slotId: 'a', start: 0, end: 4, description: '新画面' }],
                    script: [
                      {
                        id: 'new-a',
                        slotId: 'a',
                        text: '新口播',
                        start: 0,
                        end: 4,
                        factIds: [queued.timeline.facts[0]!.id],
                      },
                    ],
                  },
                );
                await service.refreshAudio(
                  projectId,
                  output.id,
                  claim.attemptToken!,
                  target.id,
                  'voice-new-a',
                  { path: wavPath, size: wav().length },
                  '[48000]',
                  '[{"startFrame":0,"endFrame":48000}]',
                );
                await service.refreshCheckpoint(
                  projectId,
                  output.id,
                  claim.attemptToken!,
                  target.id,
                  'READY',
                  {
                    captionLayoutVersion: 'SEGMENT_V3',
                    captions: [
                      {
                        id: 'new-a-caption',
                        voiceLineId: 'new-a',
                        segmentIndex: 0,
                        segmentCount: 1,
                        text: '新口播',
                        start: 0,
                        end: 2,
                      },
                    ],
                  },
                );
                await service.completeProjectRefresh(
                  projectId,
                  output.id,
                  claim.attemptToken!,
                  target.id,
                );
                await service.completeProjectRefresh(
                  projectId,
                  output.id,
                  claim.attemptToken!,
                  target.id,
                );
                await service.finish(projectId, output.id, claim.attemptToken!);
                const result = (await sourceWorkspace()).draft as unknown as EffectTemplateMixDraft;
                expect(result.templates[0]!.workspace.variants[0]!.bindings).toEqual({ a: a.id });
                expect(result.templates[0]!.workspace.variants[0]!.offsets).toEqual({ a: 5 });
                expect(result.templates[0]!.workspace.variants[0]!.preservedTimelineEnd).toBe(8);
                const saved = await tx.effectFinalOutputItem.findUniqueOrThrow({
                  where: { id: target.id },
                });
                expect(saved.fileObjectId).toBe(oldFile);
                if (!projectRefreshOnly) expect(saved.snapshot).toEqual(baselineOutput.snapshot);
                const cp = (
                  await tx.effectPackagingItem.findUniqueOrThrow({ where: { id: oldPackage.id } })
                ).checkpoint as PackagingCheckpoint;
                expect(Object.keys(cp.voices!)).toEqual(['new-a']);
                expect(cp.music).toEqual(
                  (oldPackage.checkpoint as unknown as PackagingCheckpoint).music,
                );
                expect(
                  await tx.effectPackagingFile.count({
                    where: { projectId, itemId: oldPackage.id, role: 'voice-b' },
                  }),
                ).toBe(0);
                expect(
                  await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: siblingId } }),
                ).toEqual(siblingBefore);
                throw rollback;
              }
              const after = await sourceWorkspace();
              const cleared = (after.draft as unknown as EffectTemplateMixDraft).templates[0]!
                .workspace.variants[0]!;
              expect(cleared.bindings).toEqual(allRemoved ? {} : { b: b.id });
              expect(cleared.intentionallyEmptySlotIds).toEqual(allRemoved ? ['a', 'b'] : ['a']);
              expect(cleared.preservedTimelineEnd).toBe(8);
              expect(cleared.offsets).toEqual(allRemoved ? {} : { b: 1 });
              expect(cleared.audioLanes).toEqual(
                allRemoved ? { music: 1 } : { 'voice:b': 3, music: 1 },
              );
              const changedPackage = await tx.effectPackagingItem.findUniqueOrThrow({
                where: { id: oldPackage.id },
              });
              const cp = changedPackage.checkpoint as unknown as PackagingCheckpoint;
              expect(cp.script!.map((line) => line.id)).toEqual(allRemoved ? [] : ['b']);
              expect(cp.voices!.a).toBeUndefined();
              expect(cp.captions!.map((caption) => caption.id)).toEqual(allRemoved ? [] : ['b']);
              expect(
                await tx.effectPackagingFile.count({
                  where: { projectId, itemId: oldPackage.id, role: 'voice-a' },
                }),
              ).toBe(0);
              expect(
                await tx.effectPackagingFile.count({
                  where: { projectId, itemId: oldPackage.id, role: 'music' },
                }),
              ).toBe(1);
              expect(await tx.fileObject.count({ where: { projectId, id: files[3]!.id } })).toBe(1);
              expect(cp.music).toEqual(
                (oldPackage.checkpoint as unknown as PackagingCheckpoint).music,
              );
              expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(outboxCount);
              expect(await tx.workflowRun.count({ where: { projectId } })).toBe(1);
              const saved = await tx.effectFinalOutputItem.findUniqueOrThrow({
                where: { id: target.id },
              });
              expect(saved.fileObjectId).toBe(oldFile);
              if (!projectRefreshOnly) {
                expect(saved.snapshot).toEqual(baselineOutput.snapshot);
                expect(
                  (await service.get(projectId, output.id)).items.find(
                    (item) => item.id === target.id,
                  )!.stale,
                ).toBe(true);
              } else {
                expect(saved.status).toBe('PENDING_RENDER');
                expect(
                  (saved.snapshot as unknown as FinalOutputSnapshot).timeline.clips.map(
                    (clip) => clip.slotId,
                  ),
                ).toEqual(allRemoved ? [] : ['b']);
                expect((saved.snapshot as unknown as FinalOutputSnapshot).timeline.duration).toBe(
                  8,
                );
              }
              expect(
                await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: siblingId } }),
              ).toEqual(siblingBefore);
              await expect(
                service.updateSourceProjects(projectId, {
                  workflowRunId,
                  templateId,
                  expectedDraftRevision: before.draftRevision,
                  variantIds: [target.variantId],
                }),
              ).rejects.toThrow('已变化');
              if (allRemoved && !projectRefreshOnly) {
                await service.localUpdate(projectId, output.id, { itemIds: [target.id] });
                const claim = await service.claim(projectId, output.id);
                const black = claim.items!.find((item) => item.id === target.id)!
                  .snapshot as unknown as FinalOutputSnapshot;
                expect(black.timeline.clips).toEqual([]);
                expect(black.timeline.duration).toBe(8);
                expect(black.packaging.music).toEqual(cp.music);
                await service.upload(projectId, output.id, claim.attemptToken!, target.id, {
                  path: mp4Path,
                  size: mp4.length,
                });
                await service.finish(projectId, output.id, claim.attemptToken!);
                expect(
                  (await service.get(projectId, output.id)).items.find(
                    (item) => item.id === target.id,
                  )!.stale,
                ).toBe(false);
              }
              throw rollback;
            }
            await working.commitValidatedArtifactsInTransaction(
              tx,
              projectId,
              workflowRunId,
              'SEGMENT_RENDER',
              [{ artifactKey: a.artifactKey, input: clipInput(0, 2) }],
            );
            // The real UI used to call ordinary sync before local-update. A changed source must
            // survive that call untouched so the explicit refresh can freeze its replacement.
            const beforeSync = await tx.effectFinalOutputItem.findUniqueOrThrow({
              where: { id: target.id },
            });
            expect(await service.syncFromDraft(projectId, workflowRunId)).toEqual({
              refreshed: [],
            });
            expect(
              (await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: target.id } }))
                .snapshot,
            ).toEqual(beforeSync.snapshot);
            const listed = await service.get(projectId, output.id);
            if (!projectRefreshOnly)
              expect(listed.items.find((item) => item.id === target.id)!.stale).toBe(true);
            expect(listed.items.find((item) => item.id === siblingId)!.stale).toBe(false);
            const originalPackage = packaging.items.find(
              (item) => item.variantId === target.variantId,
            )!;
            const legacyCheckpoint = structuredClone(
              originalPackage.checkpoint,
            ) as unknown as PackagingCheckpoint;
            delete legacyCheckpoint.narrationLayoutVersion;
            await tx.effectPackagingItem.update({
              where: { id: originalPackage.id },
              data: { checkpoint: json(legacyCheckpoint) },
            });
            await expect(
              service.localUpdate(projectId, output.id, { itemIds: [target.id] }),
            ).rejects.toThrow('旧口播没有槽位来源');
            expect(
              (await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: target.id } }))
                .fileObjectId,
            ).toBe(oldFile);
            await tx.effectPackagingItem.update({
              where: { id: originalPackage.id },
              data: { checkpoint: originalPackage.checkpoint! },
            });
            await service.localUpdate(projectId, output.id, { itemIds: [target.id] });
            await expect(
              service.localUpdate(projectId, output.id, { itemIds: [target.id] }),
            ).rejects.toThrow('正在渲染');
            // Real transactional saves cannot modify the frozen project or its audio, while
            // sibling projects remain editable. Every fixture write rolls back with this test.
            const lockedState = await tx.workflowNodeState.findUniqueOrThrow({
              where: {
                projectId_workflowRunId_nodeId: {
                  projectId,
                  workflowRunId,
                  nodeId: 'TEMPLATE_MIX',
                },
              },
            });
            const lockedDraft = json(lockedState.state) as EffectTemplateMixDraft;
            const editedTarget = json(lockedDraft) as EffectTemplateMixDraft;
            editedTarget.templates[0]!.workspace.variants[0]!.name = '修改更新中成片';
            await expect(
              working.saveNodeState(
                projectId,
                workflowRunId,
                'TEMPLATE_MIX',
                workflowStateHash(editedTarget),
                editedTarget,
                lockedState.revision,
                1,
              ),
            ).rejects.toThrow('局部更新正在进行');
            const audio = await tx.effectPackagingItem.findUniqueOrThrow({
              where: { id: originalPackage.id },
            });
            await expect(
              new EffectPackagingRepository(scopedDb).updateCheckpoint(
                projectId,
                audio.id,
                audio.checkpoint as PackagingCheckpoint,
                audio.updatedAt.toISOString(),
              ),
            ).rejects.toThrow('局部更新正在进行');
            const editedSibling = json(lockedDraft) as EffectTemplateMixDraft;
            editedSibling.templates[0]!.workspace.variants[1]!.name = '可编辑的其他成片';
            const siblingSave = await working.saveNodeState(
              projectId,
              workflowRunId,
              'TEMPLATE_MIX',
              workflowStateHash(editedSibling),
              editedSibling,
              lockedState.revision,
              1,
            );
            expect(siblingSave.conflict).toBe(false);
            await working.saveNodeState(
              projectId,
              workflowRunId,
              'TEMPLATE_MIX',
              workflowStateHash(lockedDraft),
              lockedDraft,
              siblingSave.record.revision,
              1,
            );
            let claim = await service.claim(projectId, output.id);
            const expiredAttempt = claim.attemptToken!;
            await tx.workingArtifact.update({ where: { id: a.id }, data: { revision: 3 } });
            await service.progress(
              projectId,
              output.id,
              expiredAttempt,
              target.id,
              0,
              '素材二次变化',
            );
            await service.finish(projectId, output.id, expiredAttempt);
            expect((await service.get(projectId, output.id)).status).toBe(
              projectRefreshOnly ? 'FAILED' : 'PARTIAL',
            );
            await service.retry(projectId, output.id);
            claim = await service.claim(projectId, output.id);
            await expect(
              service.refreshTrims(projectId, output.id, expiredAttempt, target.id, [
                { slotId: 'a', offset: 5 },
              ]),
            ).rejects.toThrow('租约已失效');
            expect(claim.items!.filter((item) => item.status === 'QUEUED')).toHaveLength(1);
            const queued = claim.items!.find((item) => item.id === target.id)!
              .snapshot as unknown as FinalOutputSnapshot;
            expect(queued.sourceRefresh?.slots[0]?.material.artifactRevision).toBe(3);
            expect(queued.sourceRefresh?.slots.map((row) => row.slotId)).toEqual(['a']);
            const draftBefore = json((await sourceWorkspace()).draft) as EffectTemplateMixDraft;
            expect(draftBefore.templates[0]!.workspace.variants[0]!.offsets.a).toBe(3);
            await expect(
              service.refreshTrims(projectId, output.id, claim.attemptToken!, target.id, [
                { slotId: 'a', offset: 11 },
              ]),
            ).rejects.toThrow('超出素材长度');
            const prepared = await service.refreshTrims(
              projectId,
              output.id,
              claim.attemptToken!,
              target.id,
              [{ slotId: 'a', offset: 5 }],
            );
            expect(prepared.snapshot.timeline.variant.offsets).toEqual({ a: 5, b: 1 });
            expect(prepared.snapshot.packaging.voices?.a).toBeUndefined();
            expect(prepared.snapshot.packaging.voices?.b).toEqual(queued.packaging.voices?.b);
            const newLine = {
              id: 'new-a',
              slotId: 'a',
              text: '新口播',
              start: 0,
              end: 4,
              factIds: [queued.timeline.facts[0]!.id],
            };
            await service.refreshCheckpoint(
              projectId,
              output.id,
              claim.attemptToken!,
              target.id,
              'VOICE',
              {
                script: [newLine, ...prepared.snapshot.packaging.script!],
                vision: [
                  { slotId: 'a', start: 0, end: 4, description: '新镜头' },
                  ...prepared.snapshot.packaging.vision!,
                ],
              },
            );
            const voice = await service.refreshAudio(
              projectId,
              output.id,
              claim.attemptToken!,
              target.id,
              'voice-new-a',
              { path: wavPath, size: wav().length },
              '[48000]',
              '[{"startFrame":0,"endFrame":48000}]',
            );
            expect(
              await service.refreshAudio(
                projectId,
                output.id,
                claim.attemptToken!,
                target.id,
                'voice-new-a',
                { path: wavPath, size: wav().length },
                '[48000]',
                '[{"startFrame":0,"endFrame":48000}]',
              ),
            ).toEqual(voice);
            const staged = (
              await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: target.id } })
            ).snapshot as unknown as FinalOutputSnapshot;
            await service.refreshCheckpoint(
              projectId,
              output.id,
              claim.attemptToken!,
              target.id,
              'READY',
              {
                captionLayoutVersion: 'SEGMENT_V3',
                captions: [
                  {
                    id: 'new-a-caption',
                    voiceLineId: 'new-a',
                    segmentIndex: 0,
                    segmentCount: 1,
                    text: '新口播',
                    start: 0,
                    end: 2,
                  },
                  ...staged.packaging.captions!,
                ],
              },
            );
            // Preparation never changes the user's live draft, old voice or exported video.
            expect(
              (await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: target.id } }))
                .fileObjectId,
            ).toBe(oldFile);
            expect(
              (json((await sourceWorkspace()).draft) as EffectTemplateMixDraft).templates[0]!
                .workspace.variants[0]!.offsets.a,
            ).toBe(3);
            // A changed frozen source blocks late writes; the previous file is still usable.
            await tx.workingArtifact.update({ where: { id: a.id }, data: { revision: 4 } });
            await expect(
              service.content(projectId, output.id, claim.attemptToken!, target.id, files[2]!.id),
            ).rejects.toThrow('素材再次发生变化');
            await tx.workingArtifact.update({ where: { id: a.id }, data: { revision: 3 } });
            const factSource = queued.timeline.facts[0]!;
            await tx.workingArtifact.update({
              where: { id: factSource.artifactId },
              data: {
                revision: factSource.revision + 1,
              },
            });
            await expect(
              service.content(projectId, output.id, claim.attemptToken!, target.id, files[2]!.id),
            ).rejects.toThrow('商品事实或 Prompt 已变化');
            await tx.workingArtifact.update({
              where: { id: factSource.artifactId },
              data: {
                revision: factSource.revision,
              },
            });
            if (projectRefreshOnly) {
              await expect(
                service.upload(projectId, output.id, claim.attemptToken!, target.id, {
                  path: mp4Path,
                  size: mp4.length,
                }),
              ).rejects.toThrow('不能上传成片文件');
              await service.completeProjectRefresh(
                projectId,
                output.id,
                claim.attemptToken!,
                target.id,
              );
              await service.completeProjectRefresh(
                projectId,
                output.id,
                claim.attemptToken!,
                target.id,
              );
            } else {
              failUpload = true;
              await expect(
                service.upload(projectId, output.id, claim.attemptToken!, target.id, {
                  path: mp4Path,
                  size: mp4.length,
                }),
              ).rejects.toThrow('test storage failure');
              failUpload = false;
              await service.upload(projectId, output.id, claim.attemptToken!, target.id, {
                path: mp4Path,
                size: mp4.length,
              });
            }
            await service.finish(projectId, output.id, claim.attemptToken!);
            const result = await service.get(projectId, output.id);
            expect(result.status).toBe(projectRefreshOnly ? 'PENDING_RENDER' : 'COMPLETED');
            expect(result.counts.stale).toBe(0);
            expect(await tx.workflowRun.count({ where: { projectId } })).toBe(1);
            const actualDraft = (await sourceWorkspace())
              .draft as unknown as EffectTemplateMixDraft;
            expect(actualDraft.templates[0]!.workspace.variants[0]!.offsets.a).toBe(5);
            expect(actualDraft.templates[0]!.workspace.variants[0]!.bindingRevisions.a).toBe(3);
            expect(actualDraft.templates[0]!.workspace.variants[0]!.audioLanes).toEqual({
              'voice:new-a': 2,
              'voice:b': 3,
              music: 1,
            });
            expect(
              await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: siblingId } }),
            ).toEqual(siblingBefore);
            const packageId = packaging.items.find(
              (item) => item.variantId === target.variantId,
            )!.id;
            const savedPackage = await tx.effectPackagingItem.findUniqueOrThrow({
              where: { id: packageId },
            });
            const newPackage = savedPackage.checkpoint as PackagingCheckpoint;
            expect(
              (
                savedPackage.snapshot as unknown as FinalOutputSnapshot['timeline']
              ).dependencies.find((dependency) => dependency.artifactId === a.id)?.revision,
            ).toBe(3);
            expect(
              (savedPackage.snapshot as unknown as FinalOutputSnapshot['timeline']).redoSlotIds,
            ).toBeUndefined();
            expect(newPackage.voices?.a).toBeUndefined();
            expect(newPackage.voices?.['new-a']?.fileObjectId).toBe(voice.fileObjectId);
            expect(newPackage.voices?.b).toEqual(queued.packaging.voices?.b);
            expect(newPackage.music).toEqual(queued.packaging.music);
            const saved = await tx.effectFinalOutputItem.findUniqueOrThrow({
              where: { id: target.id },
            });
            if (projectRefreshOnly) {
              expect(saved.fileObjectId).toBeNull();
              expect(saved.assetId).toBeNull();
              expect(saved.status).toBe('PENDING_RENDER');
              expect(
                (saved.snapshot as unknown as FinalOutputSnapshot).projectRefreshOnly,
              ).toBeUndefined();
              expect(
                (saved.snapshot as unknown as FinalOutputSnapshot).sourceRefresh,
              ).toBeUndefined();
              expect(
                await tx.workingArtifact.count({
                  where: { projectId, artifactKey: { startsWith: 'final-delivery:' } },
                }),
              ).toBe(0);
              expect(await tx.asset.count({ where: { projectId, type: 'FINAL_VIDEO' } })).toBe(0);
              throw rollback;
            }
            expect(saved.fileObjectId).not.toBe(oldFile);
            expect(
              (saved.snapshot as unknown as FinalOutputSnapshot).sourceRefresh,
            ).toBeUndefined();
            const delivery = await tx.workingArtifact.findFirstOrThrow({
              where: { projectId, artifactKey: `final-delivery:${templateId}` },
            });
            expect(
              (delivery.payload as { items: { id: string; fileObjectId: string }[] }).items.find(
                (item) => item.id === target.id,
              )!.fileObjectId,
            ).toBe(saved.fileObjectId);

            // Project membership is also an explicit same-branch local update, not a full export.
            const entry = actualDraft.templates[0]!;
            const keptVariant = entry.workspace.variants.find(
              (variant) => variant.id !== target.variantId,
            )!;
            const added = { ...structuredClone(keptVariant), id: randomUUID(), name: '新增成片' };
            entry.workspace.variants = [keptVariant, added];
            await tx.workflowNodeState.update({
              where: {
                projectId_workflowRunId_nodeId: {
                  projectId,
                  workflowRunId,
                  nodeId: 'TEMPLATE_MIX',
                },
              },
              data: { state: json(actualDraft), revision: { increment: 1 } },
            });
            visualInputs.push({
              artifactKey: `timeline-project:${templateId}:${added.id}`,
              input: {
                kind: 'STRUCTURED',
                name: added.name,
                directory: 'EDITING_PROJECTS',
                type: 'TIMELINE_PROJECT',
                payload: { templateId, variant: added },
                dependencies: Object.values(added.bindings).map((id) => ({
                  sourceType: 'WORKING_ARTIFACT',
                  sourceNodeId: 'SEGMENT_RENDER',
                  sourceArtifactId: id,
                  sourceKey: id === a.id ? a.artifactKey : b.artifactKey,
                  sourceRevision:
                    added.bindingRevisions[
                      Object.keys(added.bindings).find((slot) => added.bindings[slot] === id)!
                    ]!,
                })),
              },
            });
            const membership = await service.get(projectId, output.id);
            expect(membership.counts.stale).toBe(2);
            expect(membership.projectChanges).toEqual({
              added: [{ variantId: added.id, name: added.name }],
              removedItemIds: [target.id],
            });
            await service.localUpdate(projectId, output.id, {
              itemIds: [target.id],
              syncProjects: true,
            });
            const changed = await tx.effectFinalOutputItem.findMany({
              where: { projectId, runId: output.id },
            });
            expect(changed).toHaveLength(2);
            expect(changed.find((item) => item.id === siblingId)).toEqual(siblingBefore);
            expect(changed.find((item) => item.variantId === added.id)?.status).toBe('QUEUED');
            expect(
              await tx.fileObject.findUnique({ where: { id: saved.fileObjectId! } }),
            ).not.toBeNull();
            const appendClaim = await service.claim(projectId, output.id);
            const appended = changed.find((item) => item.variantId === added.id)!;
            await service.upload(projectId, output.id, appendClaim.attemptToken!, appended.id, {
              path: mp4Path,
              size: mp4.length,
            });
            await service.finish(projectId, output.id, appendClaim.attemptToken!);
            expect((await service.get(projectId, output.id)).counts.stale).toBe(0);
            expect(await tx.workflowRun.count({ where: { projectId } })).toBe(1);
            const nextDelivery = await tx.workingArtifact.findFirstOrThrow({
              where: {
                projectId,
                artifactKey: `final-delivery:${templateId}`,
              },
            });
            expect(
              (nextDelivery.payload as { items: { id: string }[] }).items.map((item) => item.id),
            ).toEqual(expect.arrayContaining([siblingId, appended.id]));
            expect(
              (nextDelivery.payload as { items: { id: string }[] }).items.some(
                (item) => item.id === target.id,
              ),
            ).toBe(false);

            // Removing one film alone rewrites delivery immediately, keeping the sibling file.
            entry.workspace.variants = [keptVariant];
            await tx.workflowNodeState.update({
              where: {
                projectId_workflowRunId_nodeId: {
                  projectId,
                  workflowRunId,
                  nodeId: 'TEMPLATE_MIX',
                },
              },
              data: { state: json(actualDraft), revision: { increment: 1 } },
            });
            const deletionOutbox = await tx.jobOutbox.findMany({ where: { projectId } });
            await service.localUpdate(projectId, output.id, { itemIds: [appended.id] });
            expect(
              await tx.effectFinalOutputItem.findMany({ where: { projectId, runId: output.id } }),
            ).toEqual([siblingBefore]);
            expect(await tx.jobOutbox.findMany({ where: { projectId } })).toEqual(deletionOutbox);

            entry.workspace.variants = [];
            await tx.workflowNodeState.update({
              where: {
                projectId_workflowRunId_nodeId: {
                  projectId,
                  workflowRunId,
                  nodeId: 'TEMPLATE_MIX',
                },
              },
              data: { state: json(actualDraft), revision: { increment: 1 } },
            });
            const outboxBefore = await tx.jobOutbox.findMany({ where: { projectId } });
            await service.localUpdate(projectId, output.id, { itemIds: [], syncProjects: true });
            expect((await service.get(projectId, output.id)).items).toEqual([]);
            expect(await tx.jobOutbox.findMany({ where: { projectId } })).toEqual(outboxBefore);
            const emptyDelivery = await tx.workingArtifact.findFirstOrThrow({
              where: {
                projectId,
                artifactKey: `final-delivery:${templateId}`,
              },
            });
            expect((emptyDelivery.payload as { items: unknown[] }).items).toEqual([]);
            throw rollback;
          },
          { timeout: 120_000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
      await unlink(mp4Path);
      await unlink(wavPath);
      await rmdir(directory);
    }
  },
  130_000,
);
