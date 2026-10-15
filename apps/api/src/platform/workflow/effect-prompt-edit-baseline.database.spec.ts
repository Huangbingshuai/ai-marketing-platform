import { randomUUID, createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  type EffectPromptBatchResult,
  type EffectPromptItem,
  type EffectSegmentRenderRequestSnapshot,
} from '@ai-marketing/contracts';
import type { Prisma, WorkingArtifact } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { WorkflowWorkingRepository } from './workflow-working.repository';
import { workflowStateHash } from './workflow-state-hash';
import { EffectPromptRepository } from '../../workflows/effect/prompt-generation/effect-prompt.repository';
import { recomputePromptQuality } from '../../workflows/effect/prompt-generation/effect-prompt.quality';
import { renderPromptUpdateKind } from '../../workflows/effect/segment-render/effect-segment-render-prompt-update';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => value as Prisma.InputJsonValue;
const item = (code: string, content = code): EffectPromptItem => ({
  id: randomUUID(),
  code,
  content,
  origin: 'MANUAL',
  fragmentType: 'PRODUCT_DISPLAY',
  primaryPurpose: 'PRODUCT_DISPLAY',
  compatiblePurposes: ['PRODUCT_DISPLAY'],
  classificationStatus: 'VERIFIED',
  productRelevance: 90,
  targetDurationSeconds: 5,
  creativeCore: '',
  dimensions: {
    narrative: '',
    scene: '',
    persona: '',
    productRelation: '',
    camera: '',
    emotion: '',
  },
  insightBindings: [],
  manualEdited: false,
  createdAt: new Date(1000).toISOString(),
  updatedAt: new Date(1000).toISOString(),
});

async function fixture(tx: Prisma.TransactionClient) {
  const projectId = randomUUID();
  await tx.project.create({ data: { id: projectId, name: '编辑基线回滚测试' } });
  const root = await tx.workflowRun.create({
    data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
  });
  const owner = await tx.workflowRun.create({
    data: {
      projectId,
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      parentWorkflowRunId: root.id,
      forkNodeId: 'TEMPLATE_MIX',
      branchPublishedAt: new Date(),
      activeKey: null,
    },
  });
  const base = [item('P001'), item('P002'), item('P003')];
  const adopted = [
    { ...base[0]!, content: 'confirmed improvement' },
    base[1]!,
    base[2]!,
    item('P004'),
  ];
  const settings = { ...DEFAULT_EFFECT_PROMPT_SETTINGS, targetCount: 3, defaultDurationSeconds: 5 };
  const artifacts: WorkingArtifact[] = [];
  const products = [];
  for (const [run, items, revision] of [
    [root, base, 11],
    [owner, adopted, 13],
  ] as const) {
    const workspace = await tx.effectImportWorkspace.create({
      data: { projectId, workflowRunId: run.id },
    });
    const draft = await tx.effectImportDraft.create({
      data: {
        projectId,
        workspaceId: workspace.id,
        mode: 'SINGLE',
        globalConfig: {},
        validationIssues: [],
      },
    });
    const product = await tx.effectImportProduct.create({
      data: { projectId, workflowRunId: run.id, draftId: draft.id, configOverride: {} },
    });
    products.push(product);
    const fields = {
      projectId,
      workflowRunId: run.id,
      kind: 'STRUCTURED' as const,
      name: 'fixture',
      directory: 'PROMPTS' as const,
      type: 'PROMPT' as const,
    };
    const insight = await tx.workingArtifact.create({
      data: {
        ...fields,
        nodeId: 'INFORMATION_EXTRACTION',
        artifactKey: `marketing-insight:${product.id}`,
        contentHash: hash(`insight:${run.id}`),
        payload: { productName: '测试商品', sellingPoints: ['确认卖点'] },
      },
    });
    await tx.workflowNodeState.create({
      data: {
        projectId,
        workflowRunId: run.id,
        nodeId: `PROMPT_GENERATION:${product.id}`,
        schemaVersion: 1,
        contentHash: workflowStateHash(settings),
        executionInputHash: workflowStateHash(settings),
        state: settings,
      },
    });
    const batch = recomputePromptQuality([...items], settings);
    const promptRun = await tx.effectPromptRun.create({
      data: {
        projectId,
        workflowRunId: run.id,
        productId: product.id,
        operation: 'BATCH_GENERATE',
        idempotencyKey: randomUUID(),
        requestHash: hash('request'),
        sourceFingerprint: hash('source'),
        settingsHash: workflowStateHash(settings),
        inputSnapshot: {
          insightArtifact: {
            id: insight.id,
            revision: insight.revision,
            contentHash: insight.contentHash,
            result: insight.payload,
          },
        },
        status: 'COMPLETED',
        progress: 100,
      },
    });
    const result = await tx.effectPromptResult.create({
      data: {
        projectId,
        workflowRunId: run.id,
        productId: product.id,
        runId: promptRun.id,
        generatedResult: json(batch),
        draftResult: json(batch),
        qualityStatus: batch.qualityStatus,
        manualOverrides: { added: [], edited: {}, deleted: [] },
        sourceFingerprint: hash('source'),
        settingsHash: workflowStateHash(settings),
      },
    });
    const artifact = await tx.workingArtifact.create({
      data: {
        ...fields,
        nodeId: 'PROMPT_GENERATION',
        artifactKey: `prompt-batch:${product.id}`,
        contentHash: workflowStateHash(batch),
        payload: json(batch),
        revision,
        sourceArtifactId: result.id,
        sourceRunId: promptRun.id,
        updatedAt: new Date(revision * 1000),
        metadata: run.id === root.id ? { branchSource: { artifactId: randomUUID() } } : {},
      },
    });
    artifacts.push(artifact);
    await tx.workingArtifactDependency.create({
      data: {
        projectId,
        workflowRunId: run.id,
        dependentArtifactId: artifact.id,
        sourceType: 'WORKING_ARTIFACT',
        sourceNodeId: 'INFORMATION_EXTRACTION',
        sourceArtifactId: insight.id,
        sourceKey: insight.artifactKey,
        sourceRevision: insight.revision,
        sourceHash: insight.contentHash,
      },
    });
  }
  const source = artifacts[1]!;
  // A newer completed domain result is not confirmed by the artifact. It must never
  // replace the explicit result when the editor is cloned.
  const committedResult = await tx.effectPromptResult.findUniqueOrThrow({
    where: { id: source.sourceArtifactId! },
    include: { run: true },
  });
  const unconfirmedRun = await tx.effectPromptRun.create({
    data: {
      projectId,
      workflowRunId: owner.id,
      productId: products[1]!.id,
      operation: 'BATCH_GENERATE',
      idempotencyKey: randomUUID(),
      requestHash: hash('unconfirmed'),
      sourceFingerprint: committedResult.sourceFingerprint,
      settingsHash: committedResult.settingsHash,
      inputSnapshot: json(committedResult.run.inputSnapshot),
      status: 'COMPLETED',
      progress: 100,
    },
  });
  const unconfirmed = {
    ...(source.payload as unknown as EffectPromptBatchResult),
    items: [item('P099', 'unconfirmed draft')],
  };
  await tx.effectPromptResult.create({
    data: {
      projectId,
      workflowRunId: owner.id,
      productId: products[1]!.id,
      runId: unconfirmedRun.id,
      sourceFingerprint: committedResult.sourceFingerprint,
      settingsHash: committedResult.settingsHash,
      qualityStatus: committedResult.qualityStatus,
      generatedResult: json(unconfirmed),
      draftResult: json(unconfirmed),
      manualOverrides: { added: [], edited: {}, deleted: [] },
    },
  });
  await tx.workingArtifact.create({
    data: {
      projectId,
      workflowRunId: root.id,
      nodeId: 'SEGMENT_RENDER',
      artifactKey: `render-batch:${products[0]!.id}`,
      kind: 'STRUCTURED',
      name: 'fixture render',
      directory: 'VIDEO_MATERIALS',
      type: 'VIDEO_MATERIAL',
      contentHash: hash('render'),
      payload: {
        clips: [],
        sourcePrompt: {
          artifactId: source.id,
          revision: source.revision,
          contentHash: source.contentHash,
        },
      },
    },
  });
  const scoped = new Proxy(tx, {
    get(target, key) {
      return key === '$transaction'
        ? (fn: (client: Prisma.TransactionClient) => unknown) => fn(tx)
        : Reflect.get(target, key);
    },
  }) as unknown as PrismaService;
  const working = new WorkflowWorkingRepository(scoped);
  const repository = new EffectPromptRepository(scoped, working);
  const open = async () => {
    const edit = await working.beginEffectNodeEditInTransaction(
      tx,
      projectId,
      root.id,
      'PROMPT_GENERATION',
    );
    expect(edit?.created).toBe(true);
    const artifact = await tx.workingArtifact.findFirstOrThrow({
      where: { projectId, workflowRunId: edit!.runId, nodeId: 'PROMPT_GENERATION' },
      include: { dependencies: true },
    });
    const result = await tx.effectPromptResult.findUniqueOrThrow({
      where: { id: artifact.sourceArtifactId! },
    });
    return { edit: edit!, artifact, result };
  };
  const save = async (editor: Awaited<ReturnType<typeof open>>, items: EffectPromptItem[]) => {
    const batch = { ...(editor.artifact.payload as unknown as EffectPromptBatchResult), items };
    await tx.effectPromptResult.update({
      where: { id: editor.result.id },
      data: { draftResult: json(batch), revision: { increment: 1 } },
    });
    return repository.commitValidatedResult(
      projectId,
      editor.result.id,
      editor.result.revision + 1,
      {
        kind: 'STRUCTURED',
        name: 'fixture',
        directory: 'PROMPTS',
        type: 'PROMPT',
        payload: batch,
        metadata: { productId: editor.result.productId },
        sourceRunId: editor.result.runId,
        sourceArtifactId: editor.result.id,
        dependencies: editor.artifact.dependencies,
      },
    );
  };
  const diff = async () => {
    const current = await tx.workingArtifact.findUniqueOrThrow({ where: { id: artifacts[0]!.id } });
    const latest = current.payload as unknown as EffectPromptBatchResult;
    const batch = source.payload as unknown as EffectPromptBatchResult;
    const kinds = batch.items
      .map((entry) =>
        renderPromptUpdateKind(
          {
            promptId: entry.id,
            promptContentHash: hash(entry.content),
            sharedPromptHash:
              batch.sharedPrompt?.contentHash ?? batch.renderProfile.sharedConstraints.contentHash,
            request: { duration: entry.targetDurationSeconds },
            primaryPurpose: entry.primaryPurpose,
            compatiblePurposes: entry.compatiblePurposes,
            creativeCore: entry.creativeCore,
            dimensions: entry.dimensions,
          } as EffectSegmentRenderRequestSnapshot,
          latest,
        ),
      )
      .filter(Boolean)
      .sort();
    const additions = latest.items.filter(
      ({ id }) => !batch.items.some((entry) => entry.id === id),
    );
    return { kinds, additions, latest };
  };
  return { projectId, root, source, target: artifacts[0]!, adopted, open, save, diff };
}

it
  .skipIf(process.env.EFFECT_SOURCE_POOL_DATABASE_TEST !== '1')
  .each(['cumulative', 'source', 'target', 'unchanged', 'legacy-stale'] as const)(
  'preserves the adopted editing baseline and prevents rollback (%s)',
  async (scenario) => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('PROMPT_EDIT_BASELINE_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const f = await fixture(tx);
            const editor = await f.open();
            const copied = (editor.artifact.payload as unknown as EffectPromptBatchResult).items;
            expect(copied).toEqual((f.source.payload as unknown as EffectPromptBatchResult).items);
            const next = copied
              .filter(({ code }) => code !== 'P003')
              .map((entry) => (entry.code === 'P002' ? { ...entry, content: 'user edit' } : entry));
            next.push(item('P005'));
            if (scenario === 'unchanged') {
              expect(await f.save(editor, copied)).toMatchObject({
                kind: 'COMMITTED',
                workflowRunId: f.root.id,
                artifact: { unchanged: true },
              });
              expect(
                (await tx.workingArtifact.findUniqueOrThrow({ where: { id: f.target.id } }))
                  .revision,
              ).toBe(f.target.revision);
            } else if (scenario === 'legacy-stale') {
              const stale = f.target.payload as unknown as EffectPromptBatchResult;
              await tx.workingArtifact.update({
                where: { id: editor.artifact.id },
                data: { payload: json(stale) },
              });
              // Simulate a session opened by the old release, without the new source fence.
              const run = await tx.workflowRun.findUniqueOrThrow({
                where: { id: editor.edit.runId },
              });
              const map = run.editIdMap as Record<string, Prisma.JsonValue>;
              delete map.promptEditBaseline;
              await tx.workflowRun.update({
                where: { id: run.id },
                data: { editIdMap: json(map) },
              });
              await expect(f.save(editor, next)).rejects.toThrow('编辑来源已改变');
            } else if (scenario !== 'cumulative') {
              const changed = scenario === 'source' ? f.source : f.target;
              await tx.workingArtifact.update({
                where: { id: changed.id },
                data: {
                  revision: { increment: 1 },
                  contentHash: hash('concurrent commit'),
                },
              });
              await expect(f.save(editor, next)).rejects.toThrow('编辑来源已改变');
              expect(
                (await tx.workingArtifact.findUniqueOrThrow({ where: { id: f.target.id } }))
                  .payload,
              ).toEqual(f.target.payload);
              expect(
                (await tx.workflowRun.findUniqueOrThrow({ where: { id: editor.edit.runId } }))
                  .editSessionNodeId,
              ).toBe('PROMPT_GENERATION');
            } else {
              expect(await f.save(editor, next)).toMatchObject({
                kind: 'COMMITTED',
                workflowRunId: f.root.id,
              });
              expect(await f.diff()).toMatchObject({
                kinds: ['REMOVE', 'RENDER'],
                additions: [{ code: 'P005' }],
              });
              const second = await f.open();
              const current = (second.artifact.payload as unknown as EffectPromptBatchResult).items;
              expect(current.find(({ code }) => code === 'P001')?.content).toBe(
                'confirmed improvement',
              );
              expect(current.find(({ code }) => code === 'P004')).toBeDefined();
              expect(await f.save(second, [...current, item('P006')])).toMatchObject({
                kind: 'COMMITTED',
                workflowRunId: f.root.id,
              });
              const combined = await f.diff();
              expect(combined.kinds).toEqual(['REMOVE', 'RENDER']);
              expect(combined.additions.map(({ code }) => code)).toEqual(['P005', 'P006']);
              const third = await f.open();
              const cancelled = (third.artifact.payload as unknown as EffectPromptBatchResult).items
                .filter(({ code }) => code !== 'P005')
                .map((entry) => (entry.code === 'P002' ? { ...entry, content: 'P002' } : entry));
              expect(await f.save(third, cancelled)).toMatchObject({
                kind: 'COMMITTED',
                workflowRunId: f.root.id,
              });
              const net = await f.diff();
              expect(net.kinds).toEqual(['REMOVE']);
              expect(net.additions.map(({ code }) => code)).toEqual(['P006']);
            }
            expect(await tx.jobOutbox.count({ where: { projectId: f.projectId } })).toBe(0);
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
