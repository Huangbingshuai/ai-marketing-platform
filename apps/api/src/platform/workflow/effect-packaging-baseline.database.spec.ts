import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import type {
  EffectTemplateMixWorkspaceData,
  FinalOutputSnapshot,
  PackagingCheckpoint,
} from '@ai-marketing/contracts';
import { effectTemplateMixSourceChanges } from '@ai-marketing/contracts';
import { PrismaService } from '../../database/prisma.service';
import { WorkflowWorkingRepository } from './workflow-working.repository';
import { EffectFinalOutputService } from '../../workflows/effect/final-output/effect-final-output.service';
import { workflowStateHash } from './workflow-state-hash';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enabled = process.env.EFFECT_PACKAGING_BASELINE_DATABASE_TEST === '1';
const database = () =>
  new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));

it.skipIf(!enabled)(
  'copies the confirmed packaging baseline into a background child and rolls back every write',
  async () => {
    const db = database();
    const repository = new WorkflowWorkingRepository(db);
    const rollback = new Error('PACKAGING_BASELINE_TEST_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const source = await tx.workingArtifact.findFirstOrThrow({
              where: {
                nodeId: 'TEMPLATE_MIX',
                availability: 'AVAILABLE',
                artifactKey: { startsWith: 'timeline-package:' },
                workflowRun: {
                  workflow: 'EFFECT',
                  workflowSpace: 'EFFECT',
                  branchPublishedAt: { not: null },
                },
              },
              orderBy: { updatedAt: 'desc' },
            });
            const templateId = source.artifactKey.split(':')[1]!;
            const before = await tx.workflowNodeState.findUniqueOrThrow({
              where: {
                projectId_workflowRunId_nodeId: {
                  projectId: source.projectId,
                  workflowRunId: source.workflowRunId,
                  nodeId: 'TEMPLATE_MIX',
                },
              },
            });
            await tx.workflowRun.updateMany({
              where: {
                projectId: source.projectId,
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                activeKey: 'ACTIVE',
              },
              data: { activeKey: null },
            });
            await tx.workflowRun.update({
              where: { id: source.workflowRunId },
              data: { activeKey: 'ACTIVE' },
            });
            const begun = await repository.beginEffectNodeEditInTransaction(
              tx,
              source.projectId,
              source.workflowRunId,
              'TEMPLATE_MIX',
              'BATCH',
              { always: true, keepParentActive: true, preservePackagingBaseline: true, templateId },
            );
            expect(begun?.created).toBe(true);
            const child = await tx.workflowRun.findUniqueOrThrow({ where: { id: begun!.runId } });
            expect(child.branchPublishedAt).toBeNull();
            expect(child.activeKey).toBeNull();
            const outputItems = await tx.effectFinalOutputItem.findMany({
              where: { projectId: source.projectId, run: { workflowRunId: child.id } },
            });
            expect(outputItems.length).toBeGreaterThan(0);
            expect(
              outputItems.every((item) => item.status === 'PENDING_RENDER' && !item.fileObjectId),
            ).toBe(true);
            const copied = await tx.workingArtifact.findFirstOrThrow({
              where: {
                projectId: source.projectId,
                workflowRunId: child.id,
                artifactKey: source.artifactKey,
              },
              include: { dependencies: true, files: true },
            });
            expect(copied.id).not.toBe(source.id);
            expect(copied.revision).toBe(source.revision);
            expect(
              (copied.metadata as { branchSource?: { artifactId?: string } }).branchSource
                ?.artifactId,
            ).toBe(source.id);
            const pictures = await tx.workingArtifact.findMany({
              where: {
                projectId: source.projectId,
                workflowRunId: child.id,
                artifactKey: { startsWith: `timeline-project:${templateId}:` },
              },
            });
            expect(pictures.length).toBeGreaterThan(0);
            expect(
              copied.dependencies.some((dependency) =>
                pictures.some(
                  (picture) =>
                    picture.id === dependency.sourceArtifactId &&
                    picture.contentHash === dependency.sourceHash,
                ),
              ),
            ).toBe(true);
            const otherTemplates = await tx.workingArtifact.count({
              where: {
                projectId: source.projectId,
                workflowRunId: child.id,
                nodeId: 'TEMPLATE_MIX',
                NOT: {
                  OR: [
                    { artifactKey: `mix-template:${templateId}` },
                    { artifactKey: { startsWith: `timeline-project:${templateId}:` } },
                    { artifactKey: { startsWith: `timeline-package:${templateId}:` } },
                  ],
                },
              },
            });
            expect(otherTemplates).toBe(0);
            const after = await tx.workflowNodeState.findUniqueOrThrow({
              where: { id: before.id },
            });
            expect(workflowStateHash(after.state)).toBe(workflowStateHash(before.state));
            expect(after.revision).toBe(before.revision);
            throw rollback;
          },
          { timeout: 120_000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  120_000,
);

const sourceUpdateScope = {
  projectId: process.env.EFFECT_PACKAGING_BASELINE_PROJECT_ID,
  workflowRunId: process.env.EFFECT_PACKAGING_BASELINE_RUN_ID,
  templateId: process.env.EFFECT_PACKAGING_BASELINE_TEMPLATE_ID,
};
it.skipIf(
  !enabled ||
    !process.env.EFFECT_PACKAGING_BASELINE_API_URL ||
    Object.values(sourceUpdateScope).some((value) => !value),
)(
  'creates the full current-template source update with retained failed packages and rolls back the outbox',
  async () => {
    const db = database();
    const { projectId, workflowRunId, templateId } = sourceUpdateScope as Record<
      keyof typeof sourceUpdateScope,
      string
    >;
    const base = process.env.EFFECT_PACKAGING_BASELINE_API_URL!;
    const workspaceResponse = await fetch(
      `${base}/projects/${projectId}/workflows/effect/template-mix?workflowRunId=${workflowRunId}`,
    );
    expect(workspaceResponse.ok).toBe(true);
    const workspace = ((await workspaceResponse.json()) as { data: EffectTemplateMixWorkspaceData })
      .data;
    const treeResponse = await fetch(`${base}/projects/${projectId}/workflow-runs/effect/branches`);
    expect(treeResponse.ok).toBe(true);
    const tree = ((await treeResponse.json()) as { data: unknown }).data;
    const affected = workspace.draft.templates
      .find((entry) => entry.id === templateId)!
      .workspace.variants.filter(
        (variant) => effectTemplateMixSourceChanges(variant, workspace.materials).length,
      );
    expect(affected.length).toBeGreaterThan(0);
    const rollback = new Error('PACKAGING_SOURCE_UPDATE_ROLLBACK');
    const temporary = await mkdtemp(join(tmpdir(), 'effect-refresh-test-'));
    const audioPath = join(temporary, 'fixture.wav');
    const wav = Buffer.alloc(44 + 48_000);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24_000, 24);
    wav.writeUInt32LE(48_000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(48_000, 40);
    await writeFile(audioPath, wav);
    try {
      const before = await db.effectFinalOutputRun.findFirstOrThrow({
        where: { projectId, workflowRunId, templateId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { items: true },
      });
      const beforeHash = workflowStateHash(before);
      await db
        .$transaction(
          async (tx) => {
            // All service transactions join this rollback-only transaction. No Outbox is visible to
            // dispatchers and no provider/Worker API is called. Read projections come from the live API.
            const transactionalDb = new Proxy(tx, {
              get(target, property) {
                if (property === '$transaction')
                  return (callback: (client: typeof tx) => unknown) => callback(tx);
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }) as unknown as PrismaService;
            const repository = new WorkflowWorkingRepository(transactionalDb);
            const service = new EffectFinalOutputService(
              transactionalDb,
              {
                workspace: async () => structuredClone(workspace),
                hasSuccessfulPackaging: async () =>
                  Boolean(
                    await tx.effectPackagingItem.count({
                      where: {
                        projectId,
                        status: 'COMPLETED',
                        run: { workflowRunId, templateId },
                      },
                    }),
                  ),
              } as never,
              repository,
              {
                // Synthetic one-second PCM fixture, not TTS output. Consume the stream but
                // never touch object storage; its DB FileObject and all results roll back.
                put: async ({ stream }: { stream: AsyncIterable<Buffer> }) => {
                  const chunks: Buffer[] = [];
                  for await (const chunk of stream) chunks.push(chunk);
                  expect(Buffer.concat(chunks)).toEqual(wav);
                  return { key: `rollback-only/${crypto.randomUUID()}.wav` };
                },
                delete: async () => undefined,
              } as never,
              { getEffectBranchTree: async () => tree } as never,
            );
            const retainedFailureCount = await tx.effectPackagingItem.count({
              where: {
                projectId,
                variantId: { in: affected.map((variant) => variant.id) },
                status: 'FAILED',
                snapshot: { path: ['operation'], equals: 'BATCH_PACKAGE' },
                run: { workflowRunId, templateId },
              },
            });
            // Return-shape projection is unrelated to acceptance; preserve the full creation transaction.
            const get = vi.spyOn(service, 'get').mockResolvedValue({ id: before.id } as never);
            const request = {
              workflowRunId,
              templateId,
              expectedDraftRevision: workspace.draftRevision!,
              variantIds: affected.map((variant) => variant.id),
              appendNewMaterials: true,
              operationId: crypto.randomUUID(),
            };
            await service.updateSourceProjects(projectId, request);
            expect(get).toHaveBeenCalledWith(projectId, before.id);
            const after = await tx.effectFinalOutputRun.findUniqueOrThrow({
              where: { id: before.id },
              include: { items: true },
            });
            expect(after.items).toHaveLength(before.items.length);
            const changed = after.items.filter((item) =>
              affected.some((variant) => variant.id === item.variantId),
            );
            expect(changed).toHaveLength(affected.length);
            for (const item of changed) {
              const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
              expect(snapshot.sourceOperation?.id).toBe(request.operationId);
              expect(snapshot.sourceOperation?.addedMaterialIds).toEqual(
                workspace.pendingAddedMaterialIds?.[templateId] ?? [],
              );
              if (item.status === 'QUEUED') {
                expect(snapshot.sourceRefresh?.protocol).toBe('FROZEN_RENDER_V1');
                expect(snapshot.sourceRefresh?.baselineVariant.id).toBe(item.variantId);
              } else expect(item.status).toBe('PENDING_RENDER');
            }
            if (after.status === 'QUEUED')
              expect(
                await tx.jobOutbox.count({
                  where: {
                    projectId,
                    aggregateId: before.id,
                    status: 'PENDING',
                  },
                }),
              ).toBe(1);
            await service.updateSourceProjects(projectId, request);
            expect(
              workflowStateHash(
                await tx.effectFinalOutputRun.findUniqueOrThrow({
                  where: { id: before.id },
                  include: { items: true },
                }),
              ),
            ).toBe(workflowStateHash(after));
            const claim = await service.claim(projectId, before.id);
            expect(claim.terminal).toBe(false);
            expect(
              claim
                .items!.filter((item) => ['QUEUED', 'RUNNING'].includes(item.status))
                .map((item) => item.id)
                .sort(),
            ).toEqual(
              changed
                .filter((item) => item.status === 'QUEUED')
                .map((item) => item.id)
                .sort(),
            );
            // Exercise the real frozen-source/packaging fences and idempotent trim write.
            // No model, paid request, encoding or external storage mutation is involved.
            for (const item of changed.filter((item) => item.status === 'QUEUED')) {
              const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
              const trimmed = await service.refreshTrims(
                projectId,
                before.id,
                claim.attemptToken!,
                item.id,
                snapshot.sourceRefresh!.slots.map((slot) => ({ slotId: slot.slotId, offset: 0 })),
              );
              expect(trimmed.snapshot.packaging.voiceRecovery).toBeUndefined();
              expect(trimmed.snapshot.packaging.recovery).toBeUndefined();
              const pending = {
                voiceRecovery: {
                  current: { startedAt: new Date().toISOString(), pending: true, attempts: 1 },
                },
                recovery: { startedAt: new Date().toISOString(), attempts: { VOICE: 1 } },
              };
              await service.refreshCheckpoint(
                projectId,
                before.id,
                claim.attemptToken!,
                item.id,
                'VISION',
                pending,
              );
              const replayed = await service.refreshTrims(
                projectId,
                before.id,
                claim.attemptToken!,
                item.id,
                snapshot.sourceRefresh!.slots.map((slot) => ({ slotId: slot.slotId, offset: 0 })),
              );
              expect(replayed.snapshot.packaging.voiceRecovery).toEqual(pending.voiceRecovery);
              expect(replayed.snapshot.packaging.recovery).toEqual(pending.recovery);
              const cp = structuredClone(replayed.snapshot.packaging);
              const clips = replayed.snapshot.timeline.clips.filter((clip) =>
                snapshot.sourceRefresh!.slots.some((slot) => slot.slotId === clip.slotId),
              );
              const newLines = clips.map((clip, index) => ({
                id: `verify-${index}`,
                slotId: clip.slotId,
                text: '验收',
                start: clip.start,
                end: clip.start + clip.duration,
                factIds: [replayed.snapshot.timeline.facts[0]!.id],
              }));
              cp.vision = [
                ...(cp.vision ?? []),
                ...clips.map((clip) => ({
                  slotId: clip.slotId,
                  start: clip.start,
                  end: clip.start + clip.duration,
                  description: '回滚测试夹具，非模型审片',
                })),
              ].sort((a, b) => a.start - b.start);
              cp.script = [...(cp.script ?? []), ...newLines].sort((a, b) => a.start - b.start);
              await service.refreshCheckpoint(
                projectId,
                before.id,
                claim.attemptToken!,
                item.id,
                'VOICE',
                cp,
              );
              for (const line of newLines) {
                const audio = await service.refreshAudio(
                  projectId,
                  before.id,
                  claim.attemptToken!,
                  item.id,
                  `voice-${line.id}`,
                  { path: audioPath, size: wav.length },
                  '[24000]',
                  '[{"startFrame":0,"endFrame":24000}]',
                );
                // An upload response lost in transit returns the same durable file on retry.
                expect(
                  await service.refreshAudio(
                    projectId,
                    before.id,
                    claim.attemptToken!,
                    item.id,
                    `voice-${line.id}`,
                    { path: audioPath, size: wav.length },
                    '[24000]',
                    '[{"startFrame":0,"endFrame":24000}]',
                  ),
                ).toEqual(audio);
                (cp.voices ??= {})[line.id] = {
                  fileObjectId: audio.fileObjectId,
                  start: line.start,
                  duration: 1,
                  volume: 1,
                  segmentFrames: [24000],
                  speechRanges: [{ startFrame: 0, endFrame: 24000 }],
                };
                (cp.captions ??= []).push({
                  id: `${line.id}-caption`,
                  voiceLineId: line.id,
                  text: line.text,
                  start: line.start,
                  end: line.start + 1,
                  segmentIndex: 0,
                  segmentCount: 1,
                });
              }
              cp.captions?.sort((a, b) => a.start - b.start);
              await service.refreshCheckpoint(
                projectId,
                before.id,
                claim.attemptToken!,
                item.id,
                'READY',
                cp,
              );
              await service.completeProjectRefresh(
                projectId,
                before.id,
                claim.attemptToken!,
                item.id,
              );
              const committed = await tx.effectFinalOutputItem.findUniqueOrThrow({
                where: { id: item.id },
              });
              expect(committed.status).toBe('PENDING_RENDER');
              expect(
                (committed.snapshot as unknown as FinalOutputSnapshot).sourceRefresh,
              ).toBeUndefined();
              expect(committed.fileObjectId).toBeNull();
              expect(
                await service.completeProjectRefresh(
                  projectId,
                  before.id,
                  claim.attemptToken!,
                  item.id,
                ),
              ).toEqual({ accepted: true });
            }
            await service.finish(projectId, before.id, claim.attemptToken!);
            const finished = await tx.effectFinalOutputRun.findUniqueOrThrow({
              where: { id: before.id },
              include: { items: true },
            });
            expect(finished.status).toBe('PENDING_RENDER');
            expect(finished.items.every((item) => item.status === 'PENDING_RENDER')).toBe(true);
            console.info('Rollback-only source update verified', {
              affected: affected.length,
              retainedFailureCount,
              pendingAdded: workspace.pendingAddedMaterialIds?.[templateId]?.length ?? 0,
              queued: changed.filter((item) => item.status === 'QUEUED').length,
              updated: changed.filter((item) => item.status === 'PENDING_RENDER').length,
            });
            throw rollback;
          },
          { timeout: 120_000 },
        )
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
      expect(
        workflowStateHash(
          await db.effectFinalOutputRun.findUniqueOrThrow({
            where: { id: before.id },
            include: { items: true },
          }),
        ),
      ).toBe(beforeHash);
    } finally {
      await db.$disconnect();
      await unlink(audioPath);
      await rmdir(temporary);
    }
  },
  120_000,
);

it.skipIf(!enabled)(
  'reads the exact retained ancestor artifacts of an existing failed packaging child without mutation',
  async () => {
    const db = database();
    const service = new EffectFinalOutputService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const internal = service as unknown as {
      retainedPackagingArtifacts: (...args: unknown[]) => Promise<{ id: string }[]>;
      rewriteFilm: (...args: unknown[]) => Promise<void>;
      current: (...args: unknown[]) => Promise<void>;
    };
    const rollback = new Error('PACKAGING_BASELINE_READ_TEST_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const failures = await tx.effectPackagingItem.findMany({
              where: {
                status: 'FAILED',
                snapshot: { path: ['operation'], equals: 'BATCH_PACKAGE' },
              },
              include: { run: true },
              orderBy: { completedAt: 'desc' },
              take: 30,
            });
            let recovered = 0;
            let rewritten = 0;
            for (const failed of failures) {
              const { projectId, variantId } = failed;
              const { templateId, workflowRunId } = failed.run;
              const item = await tx.effectFinalOutputItem.findFirst({
                where: { projectId, variantId, run: { workflowRunId, templateId } },
                orderBy: [{ run: { createdAt: 'desc' } }, { id: 'desc' }],
              });
              if (!item || (item.snapshot as unknown as FinalOutputSnapshot).unpackaged) continue;
              const local = await tx.workingArtifact.findMany({
                where: {
                  projectId,
                  workflowRunId,
                  artifactKey: `timeline-package:${templateId}:${variantId}`,
                },
              });
              if (local.length) continue;
              const baseline = await tx.effectPackagingItem.findFirst({
                where: {
                  projectId,
                  variantId,
                  status: 'COMPLETED',
                  run: { workflowRunId, templateId },
                },
                orderBy: [{ run: { createdAt: 'desc' } }, { id: 'desc' }],
              });
              if (!baseline) continue;
              const before = workflowStateHash(item.snapshot);
              const rows = await internal.retainedPackagingArtifacts(
                tx,
                templateId,
                item,
                baseline.checkpoint as PackagingCheckpoint,
                [],
              );
              expect(rows).toHaveLength(2);
              const dependencies = (item.snapshot as unknown as FinalOutputSnapshot).dependencies;
              expect(
                rows.every((row) =>
                  dependencies.some((dependency) => dependency.artifactId === row.id),
                ),
              ).toBe(true);
              expect(
                workflowStateHash(
                  (await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: item.id } }))
                    .snapshot,
                ),
              ).toBe(before);
              // Optional real HTTP read exercises the same saved workspace the browser is using.
              // Film rewrites below remain inside this rollback-only transaction; no task is started.
              if (process.env.EFFECT_PACKAGING_BASELINE_API_URL) {
                const response = await fetch(
                  `${process.env.EFFECT_PACKAGING_BASELINE_API_URL}/projects/${projectId}/workflows/effect/template-mix?workflowRunId=${workflowRunId}`,
                );
                expect(response.ok).toBe(true);
                const workspace = (
                  (await response.json()) as { data: EffectTemplateMixWorkspaceData }
                ).data;
                const variant = workspace.draft.templates
                  .find((entry: { id: string }) => entry.id === templateId)
                  ?.workspace.variants.find((entry: { id: string }) => entry.id === variantId);
                expect(variant).toBeDefined();
                if (
                  variant &&
                  !effectTemplateMixSourceChanges(variant, workspace.materials).length
                ) {
                  const artifacts = await new WorkflowWorkingRepository(db).listArtifacts(
                    projectId,
                    { workflowRunId },
                  );
                  await internal.rewriteFilm(
                    tx,
                    templateId,
                    item,
                    variant,
                    workspace,
                    artifacts,
                    'PENDING_RENDER',
                    baseline.checkpoint,
                  );
                  const refreshed = await tx.effectFinalOutputItem.findUniqueOrThrow({
                    where: { id: item.id },
                  });
                  await internal.current(tx, projectId, refreshed.snapshot);
                  rewritten++;
                }
              }
              recovered++;
            }
            expect(recovered).toBeGreaterThan(0);
            if (process.env.EFFECT_PACKAGING_BASELINE_API_URL) expect(rewritten).toBeGreaterThan(0);
            throw rollback;
          },
          { timeout: 120_000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  120_000,
);
