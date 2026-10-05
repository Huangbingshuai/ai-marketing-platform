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
import { packagingSnapshot, visualHash } from '../template-mix/effect-packaging.domain';
import { EffectFinalOutputService } from './effect-final-output.service';

const json = (value: unknown) => JSON.parse(JSON.stringify(value));
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
it.skipIf(process.env.EFFECT_OUTPUT_DATABASE_TEST !== '1')(
  'source refresh selects fresh trims, stages audio, atomically replaces same-branch delivery and preserves siblings',
  async () => {
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
                      activeSource: true,
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
            expect((await service.get(projectId, output.id)).counts.stale).toBe(0);
            const target = output.items.find((item) => item.variantId === variants[0]!.id)!;
            const siblingId = output.items.find((item) => item.variantId === variants[1]!.id)!.id;
            const siblingBefore = await tx.effectFinalOutputItem.findUniqueOrThrow({
              where: { id: siblingId },
            });
            const oldFile = (
              await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: target.id } })
            ).fileObjectId;
            await working.commitValidatedArtifactsInTransaction(
              tx,
              projectId,
              workflowRunId,
              'SEGMENT_RENDER',
              [{ artifactKey: a.artifactKey, input: clipInput(0, 2) }],
            );
            const listed = await service.get(projectId, output.id);
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
            expect((await service.get(projectId, output.id)).status).toBe('PARTIAL');
            await service.retry(projectId, output.id);
            claim = await service.claim(projectId, output.id);
            await expect(
              service.refreshTrims(projectId, output.id, expiredAttempt, target.id, [
                { slotId: 'a', offset: 5 },
              ]),
            ).rejects.toThrow('租约已失效');
            expect(claim.items!.filter((item) => item.status !== 'COMPLETED')).toHaveLength(1);
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
            await service.finish(projectId, output.id, claim.attemptToken!);
            const result = await service.get(projectId, output.id);
            expect(result.status).toBe('COMPLETED');
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
            const keptVariant = entry.workspace.variants.find((variant) => variant.id !== target.variantId)!;
            const added = { ...structuredClone(keptVariant), id: randomUUID(), name: '新增成片' };
            entry.workspace.variants = [keptVariant, added];
            await tx.workflowNodeState.update({ where: { projectId_workflowRunId_nodeId: {
              projectId, workflowRunId, nodeId: 'TEMPLATE_MIX',
            } }, data: { state: json(actualDraft), revision: { increment: 1 } } });
            visualInputs.push({ artifactKey: `timeline-project:${templateId}:${added.id}`, input: {
              kind: 'STRUCTURED', name: added.name, directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT',
              payload: { templateId, variant: added },
              dependencies: Object.values(added.bindings).map((id) => ({ sourceType: 'WORKING_ARTIFACT',
                sourceNodeId: 'SEGMENT_RENDER', sourceArtifactId: id,
                sourceKey: id === a.id ? a.artifactKey : b.artifactKey,
                sourceRevision: added.bindingRevisions[Object.keys(added.bindings).find((slot) => added.bindings[slot] === id)!]!,
              })),
            } });
            const membership = await service.get(projectId, output.id);
            expect(membership.counts.stale).toBe(2);
            expect(membership.projectChanges).toEqual({
              added: [{ variantId: added.id, name: added.name }], removedItemIds: [target.id],
            });
            await service.localUpdate(projectId, output.id, { itemIds: [target.id], syncProjects: true });
            const changed = await tx.effectFinalOutputItem.findMany({ where: { projectId, runId: output.id } });
            expect(changed).toHaveLength(2);
            expect(changed.find((item) => item.id === siblingId)).toEqual(siblingBefore);
            expect(changed.find((item) => item.variantId === added.id)?.status).toBe('QUEUED');
            expect(await tx.fileObject.findUnique({ where: { id: saved.fileObjectId! } })).not.toBeNull();
            const appendClaim = await service.claim(projectId, output.id);
            const appended = changed.find((item) => item.variantId === added.id)!;
            await service.upload(projectId, output.id, appendClaim.attemptToken!, appended.id, {
              path: mp4Path, size: mp4.length,
            });
            await service.finish(projectId, output.id, appendClaim.attemptToken!);
            expect((await service.get(projectId, output.id)).counts.stale).toBe(0);
            expect(await tx.workflowRun.count({ where: { projectId } })).toBe(1);
            const nextDelivery = await tx.workingArtifact.findFirstOrThrow({ where: {
              projectId, artifactKey: `final-delivery:${templateId}`,
            } });
            expect((nextDelivery.payload as { items: { id: string }[] }).items.map((item) => item.id))
              .toEqual(expect.arrayContaining([siblingId, appended.id]));
            expect((nextDelivery.payload as { items: { id: string }[] }).items.some((item) => item.id === target.id)).toBe(false);

            // Removing one film alone rewrites delivery immediately, keeping the sibling file.
            entry.workspace.variants = [keptVariant];
            await tx.workflowNodeState.update({ where: { projectId_workflowRunId_nodeId: {
              projectId, workflowRunId, nodeId: 'TEMPLATE_MIX',
            } }, data: { state: json(actualDraft), revision: { increment: 1 } } });
            const deletionOutbox = await tx.jobOutbox.findMany({ where: { projectId } });
            await service.localUpdate(projectId, output.id, { itemIds: [appended.id] });
            expect(await tx.effectFinalOutputItem.findMany({ where: { projectId, runId: output.id } }))
              .toEqual([siblingBefore]);
            expect(await tx.jobOutbox.findMany({ where: { projectId } })).toEqual(deletionOutbox);

            entry.workspace.variants = [];
            await tx.workflowNodeState.update({ where: { projectId_workflowRunId_nodeId: {
              projectId, workflowRunId, nodeId: 'TEMPLATE_MIX',
            } }, data: { state: json(actualDraft), revision: { increment: 1 } } });
            const outboxBefore = await tx.jobOutbox.findMany({ where: { projectId } });
            await service.localUpdate(projectId, output.id, { itemIds: [], syncProjects: true });
            expect((await service.get(projectId, output.id)).items).toEqual([]);
            expect(await tx.jobOutbox.findMany({ where: { projectId } })).toEqual(outboxBefore);
            const emptyDelivery = await tx.workingArtifact.findFirstOrThrow({ where: {
              projectId, artifactKey: `final-delivery:${templateId}`,
            } });
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
