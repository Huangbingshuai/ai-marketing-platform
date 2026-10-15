import { resolve } from 'node:path';

import type {
  EffectPromptBatchResult,
  EffectPromptItem,
  EffectPromptRenderCapabilityKey,
} from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_PROMPT_SETTINGS } from '@ai-marketing/contracts';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { EffectSegmentRenderService } from './effect-segment-render.service';
import type { EffectSegmentRenderRepository } from './effect-segment-render.repository';
import { workingArtifactContentHash, type WorkingArtifactUpsertInput } from '../../../platform/workflow/workflow-working.repository';
import {
  compileEffectPromptSharedPrompt,
  defaultEffectPromptRenderProfile,
  recomputePromptQuality,
} from '../prompt-generation/effect-prompt.quality';

const item: EffectPromptItem = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'P001',
  origin: 'AI',
  fragmentType: 'PRODUCT_DISPLAY',
  primaryPurpose: 'PRODUCT_DISPLAY',
  compatiblePurposes: ['PRODUCT_DISPLAY'],
  classificationStatus: 'VERIFIED',
  productRelevance: 95,
  targetDurationSeconds: 5,
  creativeCore: '产品展示',
  dimensions: {
    narrative: '产品入画',
    scene: '家庭厨房',
    persona: '成年女性',
    productRelation: '展示产品切面',
    camera: '低机位近景推近',
    emotion: '温暖自然',
  },
  content: '家庭厨房里，成年女性将产品放到案板中央，低机位近景缓慢推近并保持产品清晰。',
  insightBindings: [],
  manualEdited: false,
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
};

const promptBatch = (): EffectPromptBatchResult =>
  recomputePromptQuality(
    [structuredClone(item)],
    DEFAULT_EFFECT_PROMPT_SETTINGS,
    undefined,
    { ...defaultEffectPromptRenderProfile(), resolution: '1080p' },
    compileEffectPromptSharedPrompt([], '保持产品外观一致。'),
  ) as EffectPromptBatchResult;

const promptArtifact = (payload: EffectPromptBatchResult = promptBatch()) => ({
  id: 'artifact-prompt',
  revision: 3,
  contentHash: 'b'.repeat(64),
  freshness: 'CURRENT',
  availability: 'AVAILABLE',
  payload,
});

const sourcePackageArtifact = {
  id: 'artifact-source',
  revision: 2,
  contentHash: 'c'.repeat(64),
  freshness: 'CURRENT',
  availability: 'AVAILABLE',
  files: [
    {
      id: 'link-image-a',
      role: 'PRODUCT_IMAGE',
      sortOrder: 0,
      fileObject: {
        id: '22222222-2222-4222-8222-222222222222',
        originalFileName: 'main.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        sha256: 'd'.repeat(64),
        status: 'AVAILABLE',
      },
    },
  ],
};

const serviceWith = (overrides: Record<string, unknown> = {}) => {
  const {
    configValues = {},
    settingsNode = null,
    ...repositoryOverrides
  } = overrides as {
    configValues?: Record<string, string | undefined>;
    settingsNode?: {
      revision: number;
      state: {
        ratio: '9:16';
        resolution: '720p';
        capabilityKey: EffectPromptRenderCapabilityKey;
      };
    } | null;
  } & Record<string, unknown>;
  const artifact = promptArtifact();
  const repository = {
    workflowRun: vi.fn().mockResolvedValue({ id: 'run-a' }),
    product: vi.fn().mockResolvedValue({ id: 'product-a', name: '测试产品' }),
    promptArtifact: vi.fn().mockResolvedValue(artifact),
    marketingInsightArtifact: vi.fn().mockResolvedValue({
      payload: { productName: '测试产品' },
    }),
    sourcePackageArtifact: vi.fn().mockResolvedValue(sourcePackageArtifact),
    latestBatch: vi.fn().mockResolvedValue(null),
    workspaceBatch: vi.fn().mockImplementation((...args) => repository.latestBatch(...args)),
    workspaceReadContext: vi.fn(async (_projectId: string, workflowRunId: string, productId: string) =>
      ({ workflowRunId, productId })),
    renderArtifact: vi.fn().mockResolvedValue(null),
    batch: vi.fn().mockResolvedValue(null),
    task: vi.fn().mockResolvedValue(null),
    taskById: vi.fn().mockResolvedValue(null),
    fileObject: vi.fn().mockResolvedValue(null),
    createBatch: vi
      .fn()
      .mockImplementation(
        async (
          projectId: string,
          workflowRunId: string,
          productId: string,
          input: { batchId: string; tasks: Array<Record<string, unknown>> },
        ) => ({
          kind: 'CREATED',
          batch: {
            id: input.batchId,
            projectId,
            workflowRunId,
            productId,
            sourcePromptArtifactId: artifact.id,
            sourcePromptRevision: artifact.revision,
            sourcePromptHash: artifact.contentHash,
            sourceFingerprint: 'fingerprint',
            idempotencyKey: 'request-a',
            requestHash: 'request-hash',
            status: 'QUEUED',
            activeKey: 'ACTIVE',
            revision: 1,
            committedAt: null,
            createdAt: new Date('2026-09-03T00:00:00.000Z'),
            updatedAt: new Date('2026-09-03T00:00:00.000Z'),
            product: { id: productId, name: '测试产品' },
            tasks: input.tasks.map((task) => ({
              ...task,
              projectId,
              workflowRunId,
              productId,
              batchId: input.batchId,
              status: 'QUEUED',
              progress: 0,
              renderVersion: 1,
              retryCount: 0,
              maxAutoRetries: 2,
              attemptCount: 0,
              attemptToken: null,
              leaseExpiresAt: null,
              providerTaskId: null,
              outputFileObjectId: null,
              outputFileName: null,
              outputMimeType: null,
              outputSizeBytes: null,
              outputStorageKey: null,
              outputContentHash: null,
              errorCode: null,
              errorMessage: null,
              startedAt: null,
              completedAt: null,
              createdAt: new Date('2026-09-03T00:00:00.000Z'),
              updatedAt: new Date('2026-09-03T00:00:00.000Z'),
            })),
          },
        }),
      ),
    startRepair: vi.fn().mockResolvedValue({ kind: 'UPDATED' }),
    importMaterials: vi.fn().mockResolvedValue({ kind: 'UPDATED' }),
    deleteMaterials: vi.fn().mockResolvedValue({ kind: 'UPDATED' }),
    operationReceipt: vi.fn().mockResolvedValue(null),
    regenerateTasks: vi.fn().mockResolvedValue({ kind: 'UPDATED' }),
    commitValidatedBatch: vi.fn().mockResolvedValue({ kind: 'COMMITTED', artifacts: [] }),
    ...repositoryOverrides,
  };
  const storage = {
    open: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    signedReadUrl: vi.fn(),
  };
  const workflowWorkingService = {
    beginEffectNodeEdit: vi.fn().mockImplementation(async (_projectId: string, runId: string) => ({
      run: { id: runId },
      productIdMap: {},
      taskIdMap: {},
      created: false,
    })),
    publishEffectNodeEdit: vi.fn().mockResolvedValue({ createdBranch: false }),
    assertEffectNodeWritable: vi.fn().mockResolvedValue(undefined),
  };
  const workingRepository = {
    findNodeState: vi.fn().mockResolvedValue(settingsNode),
    saveNodeState: vi.fn(),
    listArtifacts: vi.fn().mockResolvedValue([]),
  };
  const service = new EffectSegmentRenderService(
    repository as never,
    { get: vi.fn().mockResolvedValue({ id: 'project-a', name: '项目 A' }) } as never,
    {
      get: vi.fn((key: string) => {
        if (key in configValues) return configValues[key];
        if (key === 'SEEDANCE_MODEL') return 'seedance-model';
        if (key === 'SEEDANCE_REFERENCE_PUBLIC_BASE_URL') return 'https://api.example.test/api';
        if (key === 'SEEDANCE_REFERENCE_SIGNING_SECRET')
          return 'a-secure-signing-secret-with-32-characters';
        return undefined;
      }),
    } as never,
    storage as never,
    workingRepository as never,
    workflowWorkingService as never,
  );
  return { service, repository, storage, workflowWorkingService, workingRepository };
};

describe('EffectSegmentRenderService', () => {
  it.each(['QUEUED', 'RUNNING', 'FAILED', 'COMPLETED'])(
    'preserves AI provenance with retained output and no provider ID while %s', async (status) => {
      const { service, repository } = serviceWith();
      await service.start('project-a', 'product-a', {
        workflowRunId: 'run-a', expectedPromptArtifactRevision: 3,
        expectedSettingsRevision: 0, idempotencyKey: 'provenance',
      });
      const { batch } = await repository.createBatch.mock.results[0]!.value;
      Object.assign(batch.tasks[0], {
        status, providerTaskId: null, outputFileObjectId: 'old-output',
        outputFileName: 'P001.mp4', outputMimeType: 'video/mp4',
        outputSizeBytes: 1024, outputContentHash: 'a'.repeat(64),
      });
      repository.batch.mockResolvedValue(batch);
      const presented = await service.batch('project-a', batch.id);
      expect(presented.batch.tasks[0]).toMatchObject({
        origin: 'AI_GENERATED', sourceName: 'P001', output: { fileObjectId: 'old-output' },
      });
      expect(presented.batch.tasks[0]?.independentImport).toBeUndefined();
    },
  );

  it('keeps independent import provenance after an AI replacement obtains a provider ID', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a', expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0, idempotencyKey: 'import-provenance',
    });
    const { batch } = await repository.createBatch.mock.results[0]!.value;
    batch.tasks[0].requestSnapshot.importedMaterial = { schemaVersion: 1, width: 1280, height: 720 };
    Object.assign(batch.tasks[0], {
      status: 'RUNNING', providerTaskId: 'replacement-attempt', outputFileObjectId: 'import-output',
      outputFileName: 'import.mp4', outputMimeType: 'video/mp4',
      outputSizeBytes: 1024, outputContentHash: 'a'.repeat(64),
    });
    repository.batch.mockResolvedValue(batch);
    const presented = await service.batch('project-a', batch.id);
    expect(presented.batch.tasks[0]).toMatchObject({
      origin: 'EXTERNAL_IMPORT', independentImport: true, sourceName: 'import.mp4',
    });
  });

  it.each([
    { requested: 'adaptive', actual: '3:4', accepted: true },
    { requested: '9:16', actual: '3:4', accepted: false },
    { requested: 'adaptive', actual: '0:4', accepted: false },
  ] as const)('validates the completion ratio before storage: $requested -> $actual', async ({ requested, actual, accepted }) => {
    const { service, repository, storage } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'adaptive-complete' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    const task = record.tasks[0];
    Object.assign(task, { status: 'RUNNING', attemptToken: 'attempt',
      providerTaskId: 'existing-provider', outputFileObjectId: null });
    task.requestSnapshot.request.ratio = requested;
    repository.task.mockResolvedValue(task);
    const complete = vi.fn().mockResolvedValue({
      kind: 'COMPLETED', task: { ...task, status: 'COMPLETED', outputFileObjectId: 'stored-video' },
    });
    Object.assign(repository, { complete });
    storage.put.mockImplementation(async ({ stream }) => {
      // Opaque upload fixture: this test exercises API validation/storage ordering, not media encoding.
      for await (const chunk of stream) { void chunk; /* consume the mock upload */ }
      return { key: 'staging/video.mp4', sizeBytes: 1024 };
    });
    const result = service.complete('project-a', task.id, 'attempt', {
      taskVersion: 1, providerTaskId: 'existing-provider', duration: 5,
      actualDuration: 5.04, ratio: actual, resolution: task.requestSnapshot.request.resolution,
    }, [{ fieldname: 'file', originalname: 'P001.mp4', mimetype: 'video/mp4', size: 1024,
      path: resolve(__dirname, 'effect-seedance-request.compiler.spec.ts') }]);
    if (!accepted) {
      await expect(result).rejects.toThrow('Seedance 输出参数与任务快照不一致');
      expect(storage.put).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      return;
    }
    await expect(result).resolves.toEqual({ completed: true, fileObjectId: 'stored-video' });
    expect(storage.put).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]!.slice(0, 5)).toEqual([
      'project-a', task.id, 'attempt', 1, 'existing-provider',
    ]);
    expect(complete.mock.calls[0]![8]).toBe(5.04);
    expect(complete.mock.calls[0]![9]).toBe(actual);
  });

  it.each([{ attempt: 'old-attempt', version: 1 }, { attempt: 'attempt', version: 0 }])(
    'rejects stale completion attempts before storage: %j', async ({ attempt, version }) => {
      const { service, storage } = serviceWith({ task: vi.fn().mockResolvedValue({
        status: 'RUNNING', renderVersion: 1, attemptToken: 'attempt',
      }) });
      await expect(service.complete('project-a', 'task', attempt, {
        taskVersion: version, providerTaskId: 'existing-provider', ratio: '3:4',
      }, [])).rejects.toThrow('视频渲染任务租约或版本已失效');
      expect(storage.put).not.toHaveBeenCalled();
    },
  );

  const completedPool = async () => {
    const fixture = serviceWith();
    await fixture.service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'net-initial' });
    const record = (await fixture.repository.createBatch.mock.results[0]!.value).batch;
    record.status = 'COMPLETED'; record.committedAt = new Date();
    Object.assign(record.tasks[0], { status: 'COMPLETED', repairStatus: null,
      outputFileObjectId: 'old-file', outputStorageKey: 'old.mp4', outputFileName: 'old.mp4',
      outputMimeType: 'video/mp4', outputSizeBytes: 100, outputContentHash: 'd'.repeat(64) });
    fixture.repository.batch.mockResolvedValue(record);
    return { ...fixture, record };
  };
  it.each(['body', 'metadata', 'addition'] as const)('returns a no-op when an unconsumed %s edit is reverted, before opening a draft', async (kind) => {
    const { service, repository, workflowWorkingService, record } = await completedPool();
    const edited = promptBatch();
    if (kind === 'body') edited.items[0]!.content += ' 修改';
    if (kind === 'metadata') edited.items[0]!.creativeCore += ' 修改';
    if (kind === 'addition') edited.items.push({ ...edited.items[0]!, id: 'added', code: 'P002' });
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(edited), revision: 4 });
    const before = (await service.batch('project-a', record.id)).batch;
    expect(before.stale).toBe(true);
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(), revision: 5 });
    const calls = workflowWorkingService.beginEffectNodeEdit.mock.calls.length;
    const result = await service.refresh('project-a', record.id, { expectedBatchRevision: record.revision,
      expectedPromptArtifactRevision: 4, expectedDifferenceSignature: before.refreshSignature!, idempotencyKey: 'net-noop' });
    expect(result).toMatchObject({ noChanges: true, batch: { stale: false, refreshScope: 'NONE' } });
    expect(workflowWorkingService.beginEffectNodeEdit).toHaveBeenCalledTimes(calls);
    expect(repository.regenerateTasks).not.toHaveBeenCalled();
  });
  it('reconfirms changed fee/scope, but ignores revision-only changes with the same confirmed difference', async () => {
    const { service, repository, record, workflowWorkingService } = await completedPool();
    const edited = promptBatch(); edited.items[0]!.content += ' 最新正文';
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(edited), revision: 4 });
    const before = (await service.batch('project-a', record.id)).batch;
    const request = { expectedBatchRevision: record.revision, expectedPromptArtifactRevision: 4,
      expectedDifferenceSignature: before.refreshSignature!, idempotencyKey: 'net-signature' };
    const metadata = promptBatch(); metadata.items[0]!.creativeCore += ' 修改';
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(metadata), revision: 5 });
    const calls = workflowWorkingService.beginEffectNodeEdit.mock.calls.length;
    await expect(service.refresh('project-a', record.id, request)).rejects.toThrow('费用范围已变化');
    expect(workflowWorkingService.beginEffectNodeEdit).toHaveBeenCalledTimes(calls);
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(edited), revision: 6 });
    await service.refresh('project-a', record.id, request);
    const inputs = repository.regenerateTasks.mock.calls[0]![5];
    expect(inputs.sourcePrompt.revision).toBe(6);
    expect(inputs.taskSnapshots[record.tasks[0].id].promptText).toBe(edited.items[0]!.content);
    expect(inputs.taskSnapshots[record.tasks[0].id].refreshContext.sourcePrompt.revision).toBe(6);
  });
  it('saves a successful frozen result with residual Prompt changes using its consumed source, not the latest revision', async () => {
    const { service, repository, record } = await completedPool();
    record.committedAt = null;
    const snapshot = record.tasks[0].requestSnapshot;
    snapshot.refreshContext = { schemaVersion: 1, confirmationSignature: 'frozen', sourcePrompt: snapshot.sourcePrompt };
    const edited = promptBatch(); edited.items[0]!.content += ' 再次修改';
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(edited), revision: 5 });
    const view = (await service.batch('project-a', record.id)).batch;
    expect(view).toMatchObject({ stale: true, canSaveFrozenResults: true });
    expect((await service.validate('project-a', record.id, record.revision)).valid).toBe(true);
    const commit = repository.commitValidatedBatch.mock.calls[0]!;
    expect(commit[3].revision).toBe(3);
    const clip = commit[5].find((input: { artifactKey: string }) => input.artifactKey.startsWith('render-clip:'));
    expect(clip.input.dependencies[0].sourceRevision).toBe(3);
    expect(clip.input.payload.adoptedPrompt.sourcePrompt.revision).toBe(3);
    expect(clip.input.payload.promptText).toBe(item.content);
  });
  it.each(['protocol', 'manual'] as const)('never auto-publishes a finished local update (%s)', async (kind) => {
    const { service, repository, record } = await completedPool();
    record.committedAt = null;
    if (kind === 'protocol') record.tasks[0].requestSnapshot.refreshContext = {
      schemaVersion: 1, confirmationSignature: 'frozen', sourcePrompt: record.tasks[0].requestSnapshot.sourcePrompt,
    };
    else repository.workflowRun.mockResolvedValue({ id: record.workflowRunId,
      editSessionNodeId: 'SEGMENT_RENDER', editSessionPurpose: 'MANUAL' });
    await (service as unknown as { autoCommitCompletedBatch(projectId: string, batchId: string): Promise<void> })
      .autoCommitCompletedBatch('project-a', record.id);
    expect(repository.commitValidatedBatch).not.toHaveBeenCalled();
  });
  const automaticPool = async () => {
    const fixture = await completedPool();
    const { record, repository } = fixture;
    record.committedAt = null;
    Object.assign(record.tasks[0], { operationKind: 'GENERATE' });
    record.tasks[0].requestSnapshot.refreshContext = { schemaVersion: 1,
      confirmationSignature: 'confirmed', sourcePrompt: record.tasks[0].requestSnapshot.sourcePrompt };
    const run = { id: record.workflowRunId, parentWorkflowRunId: 'original-run',
      branchPublishedAt: null, editSessionNodeId: 'SEGMENT_RENDER' as string | null,
      editSessionPurpose: 'MANUAL' as string | null, editIdMap: { autoCommitPromptRefresh: record.id } };
    repository.workflowRun.mockResolvedValue(run);
    repository.latestBatch.mockResolvedValue(record);
    repository.commitValidatedBatch.mockImplementation(async () => {
      record.committedAt = new Date();
      run.editSessionNodeId = null;
      run.editSessionPurpose = null;
      return { kind: 'COMMITTED', artifacts: [] };
    });
    return { ...fixture, run };
  };
  it('projects only this operation\'s task IDs across polling, completion and a second update', async () => {
    const { service, repository, record } = await completedPool();
    const first = record.tasks[0];
    record.tasks.push({ ...first, id: 'second-task', promptId: 'second-prompt' });
    const view = () => service.batch('project-a', record.id);
    repository.workflowRun.mockResolvedValue({ id: record.workflowRunId,
      editIdMap: { renderProgress: { batchId: record.id, taskIds: [first.id, 'foreign-task'] } } });
    expect((await view()).batch.progressTaskIds).toEqual([first.id]);
    record.tasks[1].status = 'QUEUED';
    record.status = 'RUNNING';
    repository.workflowRun.mockResolvedValue({ id: record.workflowRunId,
      editIdMap: { renderProgress: { batchId: record.id, taskIds: ['second-task'] } } });
    expect((await view()).batch.progressTaskIds).toEqual(['second-task']);
    repository.workflowRun.mockResolvedValue({ id: record.workflowRunId,
      editIdMap: { renderProgress: { batchId: 'another-batch', taskIds: [first.id] } } });
    expect((await view()).batch.progressTaskIds).toEqual([first.id, 'second-task']);
    repository.workflowRun.mockResolvedValue({ id: record.workflowRunId,
      editIdMap: { renderProgress: { batchId: record.id, taskIds: [] } } });
    expect((await view()).batch.progressTaskIds).toEqual([]);
    record.tasks[1].errorCode = 'MATERIAL_DELETED';
    repository.workflowRun.mockResolvedValue({ id: record.workflowRunId,
      editIdMap: { renderProgress: { batchId: record.id, taskIds: [first.id],
        synchronizedTaskIds: [], removedTaskIds: ['second-task', 'foreign-task'] } } });
    expect((await view()).batch).toMatchObject({
      progressTaskIds: [first.id], progressSynchronizedCount: 0, progressRemovedCount: 1,
    });
  });
  it.each(['callback', 'batch', 'workspace'] as const)('automatically adopts local results on %s and recovers missed commits without generating tasks', async (entry) => {
    const { service, repository, record } = await automaticPool();
    if (entry === 'callback') await (service as unknown as {
      autoCommitCompletedBatch(projectId: string, batchId: string): Promise<void>;
    }).autoCommitCompletedBatch('project-a', record.id);
    else if (entry === 'batch') await service.batch('project-a', record.id);
    else await service.workspace('project-a', record.workflowRunId, record.productId);
    const result = await service.batch('project-a', record.id);
    expect(result.batch).toMatchObject({ autoCommitPending: false, committedWorkflowRunId: 'original-run' });
    expect(repository.commitValidatedBatch).toHaveBeenCalledOnce();
    expect(repository.regenerateTasks).not.toHaveBeenCalled();
    expect(repository.createBatch).toHaveBeenCalledOnce();
  });
  it('adopts the frozen successful video but keeps a later Prompt edit pending', async () => {
    const { service, repository, record } = await automaticPool();
    const latest = promptBatch(); latest.items[0]!.content += ' 第二次修改';
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(latest), revision: 5 });
    const result = await service.batch('project-a', record.id);
    expect(result.batch).toMatchObject({ stale: true, refreshScope: 'SELECTIVE',
      committedWorkflowRunId: 'original-run' });
    expect(repository.commitValidatedBatch.mock.calls[0]![3].revision).toBe(3);
    expect(result.batch.tasks[0]!.needsUpdate).toBe(true);
  });
  it.each(['failed', 'running', 'repair', 'missing'] as const)('does not auto-adopt an incomplete local update: %s', async (kind) => {
    const { service, repository, record } = await automaticPool();
    if (kind === 'failed') { record.status = 'PARTIAL'; record.tasks[0].status = 'FAILED'; }
    if (kind === 'running') { record.status = 'RUNNING'; record.tasks[0].status = 'RUNNING'; }
    if (kind === 'repair') record.tasks[0].repairStatus = 'PENDING_ADOPTION';
    if (kind === 'missing') record.tasks[0].outputFileObjectId = null;
    await service.batch('project-a', record.id);
    expect(repository.commitValidatedBatch).not.toHaveBeenCalled();
  });
  it('keeps automatic updates isolated from imports and other manual changes', async () => {
    const { service, repository, record } = await automaticPool();
    await expect(service.deleteMaterials('project-a', record.id, [record.tasks[0].id], record.revision, 'manual-delete'))
      .rejects.toThrow('局部更新尚未完成');
    expect(repository.deleteMaterials).not.toHaveBeenCalled();
    await expect(service.regenerate('project-a', record.id, [record.tasks[0].id], record.revision, 'manual-retry'))
      .rejects.toThrow('局部更新尚未完成');
    expect(repository.regenerateTasks).not.toHaveBeenCalled();
  });
  it('does not auto-save an already open human editing session through local update', async () => {
    const { service, repository, record } = await completedPool();
    const latest = promptBatch(); latest.items[0]!.content += ' 最新正文';
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(latest), revision: 4 });
    repository.workflowRun.mockResolvedValue({ id: record.workflowRunId,
      editSessionNodeId: 'SEGMENT_RENDER', editSessionPurpose: 'MANUAL', editIdMap: {} });
    await expect(service.refresh('project-a', record.id, { expectedBatchRevision: record.revision,
      expectedPromptArtifactRevision: 4, idempotencyKey: 'manual-local' }))
      .rejects.toThrow('请先保存或取消当前人工编辑');
    expect(repository.regenerateTasks).not.toHaveBeenCalled();
    expect(repository.commitValidatedBatch).not.toHaveBeenCalled();
  });
  it('rejects a concurrent manual change made after creating the local-update edit workspace', async () => {
    const { service, repository, record, workflowWorkingService } = await completedPool();
    const latest = promptBatch(); latest.items[0]!.content += ' 最新正文';
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(latest), revision: 4 });
    workflowWorkingService.beginEffectNodeEdit.mockResolvedValue({ run: { id: 'new-edit' },
      productIdMap: {}, taskIdMap: {}, created: true });
    repository.latestBatch.mockResolvedValue({ ...record, workflowRunId: 'new-edit', revision: record.revision + 1 });
    await expect(service.refresh('project-a', record.id, { expectedBatchRevision: record.revision,
      expectedPromptArtifactRevision: 4, idempotencyKey: 'concurrent-manual' }))
      .rejects.toThrow('素材在更新准备期间已被编辑');
    expect(repository.regenerateTasks).not.toHaveBeenCalled();
  });
  it.each(['METADATA', 'REMOVE'] as const)('automatically commits free %s updates without waiting for a Worker callback', async (kind) => {
    const { service, repository, record, workflowWorkingService } = await completedPool();
    const latest = promptBatch();
    if (kind === 'REMOVE') latest.items = [];
    else latest.items[0]!.creativeCore += ' 新创意';
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(latest), revision: 4 });
    workflowWorkingService.beginEffectNodeEdit.mockResolvedValue({
      run: { id: record.workflowRunId }, productIdMap: {}, taskIdMap: {}, created: true,
    });
    repository.regenerateTasks.mockImplementation(async (...args: unknown[]) => {
      const input = args[5] as Parameters<EffectSegmentRenderRepository['regenerateTasks']>[5];
      expect(input.autoCommitPromptRefresh).toBe(true);
      expect(input.refreshContext!.sourcePrompt.revision).toBe(4);
      const task = record.tasks[0];
      if (kind === 'REMOVE') Object.assign(task, { status: 'FAILED', errorCode: 'MATERIAL_DELETED', outputFileObjectId: null,
        requestSnapshot: { ...task.requestSnapshot, removedBy: 'PROMPT', refreshContext: input.refreshContext } });
      else task.requestSnapshot = input.metadataSnapshots![task.id];
      Object.assign(task, { operationKind: 'GENERATE' });
      record.committedAt = null;
      record.sourcePromptRevision = input.sourcePrompt.revision;
      record.sourcePromptHash = input.sourcePrompt.contentHash;
      repository.workflowRun.mockResolvedValue({ id: record.workflowRunId, editSessionNodeId: 'SEGMENT_RENDER',
        editSessionPurpose: 'MANUAL', editIdMap: { autoCommitPromptRefresh: record.id } });
      return { kind: 'UPDATED' };
    });
    await service.refresh('project-a', record.id, { expectedBatchRevision: record.revision,
      expectedPromptArtifactRevision: 4, idempotencyKey: 'automatic-free' });
    expect(repository.regenerateTasks.mock.calls[0]![2]).toEqual([]);
    expect(repository.regenerateTasks.mock.calls[0]![5].addedTasks).toEqual([]);
    expect(repository.commitValidatedBatch).toHaveBeenCalledOnce();
  });
  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])('keeps confirmed pools navigable (explicit deletion list=%s, legacy import metadata=%s)', async (explicitEmpty, legacyImport) => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'legacy-next' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    record.status = 'COMPLETED';
    record.committedAt = new Date();
    if (legacyImport) {
      record.tasks[0].requestSnapshot.importedMaterial = { schemaVersion: 1 };
      record.tasks[0].generationRequestSnapshot = structuredClone(record.tasks[0].requestSnapshot);
      repository.promptArtifact.mockResolvedValue(promptArtifact({ ...promptBatch(), items: [] }));
    }
    Object.assign(record.tasks[0], { status: 'COMPLETED', repairStatus: null,
      outputFileObjectId: 'clip-file', outputStorageKey: 'staging/clip.mp4',
      outputFileName: 'P001.mp4', outputMimeType: 'video/mp4', outputSizeBytes: 100,
      outputContentHash: 'd'.repeat(64) });
    const inputs = (service as unknown as {
      artifactInputs: (record: unknown) => Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }>;
    }).artifactInputs(record);
    const pool = inputs.find(({ artifactKey }) => artifactKey.startsWith('render-batch:'))!;
    const payload = { ...(pool.input.payload as Record<string, unknown>) };
    if (legacyImport) {
      payload.clips = (payload.clips as Array<Record<string, unknown>>).map((clip) => {
        const legacyClip = { ...clip };
        delete legacyClip.creativeCore;
        delete legacyClip.dimensions;
        return legacyClip;
      });
    }
    if (explicitEmpty) payload.removedSources = [];
    else delete payload.removedSources;
    const confirmed = { artifactKey: pool.artifactKey, revision: 3, freshness: 'CURRENT',
      availability: 'AVAILABLE', payload,
      contentHash: workingArtifactContentHash({ ...pool.input, payload }) };
    repository.renderArtifact.mockResolvedValue(confirmed);
    repository.batch.mockResolvedValue(record);

    expect((await service.batch('project-a', record.id)).batch).toMatchObject({
      stale: false, commitStatus: 'COMMITTED', workingArtifactRevision: 3,
    });
    expect(repository.commitValidatedBatch).not.toHaveBeenCalled();

    if (legacyImport) {
      const originalCreativeCore = record.tasks[0].requestSnapshot.creativeCore;
      record.tasks[0].requestSnapshot.creativeCore = '实际编辑过的创意主线';
      expect((await service.batch('project-a', record.id)).batch.commitStatus).toBe('DRAFT_CHANGED');
      record.tasks[0].requestSnapshot.creativeCore = originalCreativeCore;
      record.committedAt = null;
      expect((await service.batch('project-a', record.id)).batch.commitStatus).toBe('DRAFT_CHANGED');
      record.committedAt = new Date();
    }

    // The compatibility path must still detect genuine media edits and deletions.
    record.tasks[0].outputContentHash = 'e'.repeat(64);
    expect((await service.batch('project-a', record.id)).batch.commitStatus).toBe('DRAFT_CHANGED');
    record.tasks[0].outputContentHash = 'd'.repeat(64);
    Object.assign(record.tasks[0], { status: 'FAILED', errorCode: 'MATERIAL_DELETED' });
    expect((await service.batch('project-a', record.id)).batch.commitStatus).toBe('DRAFT_CHANGED');
    expect(repository.commitValidatedBatch).not.toHaveBeenCalled();
  });

  it.each([false, true])('fills legacy creative metadata only from the consumed Prompt version (changed=%s)', async (changed) => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'legacy-creative' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    delete record.tasks[0].requestSnapshot.creativeCore;
    delete record.tasks[0].requestSnapshot.dimensions;
    repository.batch.mockResolvedValue(record);
    if (changed) repository.promptArtifact.mockResolvedValue({ ...promptArtifact(), revision: 4 });
    const view = (await service.batch('project-a', record.id)).batch.tasks[0]!;
    expect(view.creativeCore).toBe(changed ? undefined : item.creativeCore);
    expect(view.dimensions).toEqual(changed ? undefined : item.dimensions);
  });

  it.each([4, 15, 16, 30])('uses explicitly configured manual %s-second Prompt items without changing the batch slot limit', async (duration) => {
    const next = promptBatch();
    next.items[0] = { ...next.items[0]!, origin: 'MANUAL', targetDurationSeconds: duration };
    const { service, repository } = serviceWith({ promptArtifact: vi.fn().mockResolvedValue(promptArtifact(next)) });
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'manual-duration',
      ...(duration > 15 ? { promptSettings: [{ promptId: next.items[0]!.id, settings: {
        ...next.renderProfile, capabilityKey: 'SEEDANCE_1_5_PRO' as const,
      } }] } : {}),
    });
    const snapshot = repository.createBatch.mock.calls[0]![3].tasks[0].requestSnapshot;
    expect(snapshot.request.duration).toBe(duration);
    expect(snapshot.promptDurationMaxSeconds).toBe(next.settings.defaultDurationSeconds);
    expect(snapshot.renderSettings.capabilityKey).toBe(duration > 15 ? 'SEEDANCE_1_5_PRO' : next.renderProfile.capabilityKey);
  });

  it('treats an optional null override list as absent without failing task preparation', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a', expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0, idempotencyKey: 'nullable-overrides', promptSettings: null as never });
    expect(repository.createBatch).toHaveBeenCalledTimes(1);
  });

  it('rejects long Prompt conflicts before opening an edit or creating any paid task', async () => {
    const next = promptBatch();
    next.items[0] = { ...next.items[0]!, origin: 'MANUAL', targetDurationSeconds: 21 };
    const { service, repository, workflowWorkingService } = serviceWith({ promptArtifact: vi.fn().mockResolvedValue(promptArtifact(next)) });
    await expect(service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'conflicting' })).rejects.toThrow('请单独配置');
    expect(workflowWorkingService.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(repository.createBatch).not.toHaveBeenCalled();
  });

  it('freezes different settings for multiple long Prompts without changing compatible defaults', async () => {
    const next = promptBatch();
    next.renderProfile.resolution = '4k';
    const longItems = [21, 24, 30].map((duration, index) => ({ ...structuredClone(item),
      id: `99999999-9999-4999-8999-99999999999${index}`, code: `P00${index + 2}`,
      origin: 'MANUAL' as const, targetDurationSeconds: duration }));
    next.items.push(...longItems);
    const { service, repository, workingRepository } = serviceWith({ promptArtifact: vi.fn().mockResolvedValue(promptArtifact(next)) });
    const promptSettings = longItems.map((entry, index) => ({ promptId: entry.id, settings: {
      capabilityKey: 'SEEDANCE_1_5_PRO' as const, ratio: index === 1 ? '1:1' as const : '9:16' as const,
      resolution: index === 1 ? '720p' as const : '1080p' as const,
    } }));
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'multi-long', promptSettings });
    const tasks = repository.createBatch.mock.calls[0]![3].tasks;
    expect(tasks[0].requestSnapshot.renderSettings).toMatchObject({ capabilityKey: 'SEEDANCE_2_0', resolution: '4k' });
    promptSettings.forEach((entry, index) => expect(tasks[index + 1].requestSnapshot.renderSettings).toEqual(entry.settings));
    expect(workingRepository.saveNodeState).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'duplicate', 'unsupported'] as const)('rejects %s per-Prompt settings before creating an edit', async (kind) => {
    const { service, workflowWorkingService } = serviceWith();
    const settings = { capabilityKey: 'SEEDANCE_1_0' as const, ratio: '9:16' as const, resolution: kind === 'unsupported' ? '4k' as const : '720p' as const };
    const override = { promptId: kind === 'unknown' ? 'other-project-prompt' : item.id, settings };
    await expect(service.start('project-a', 'product-a', { workflowRunId: 'run-a', expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0, idempotencyKey: kind, promptSettings: kind === 'duplicate' ? [override, override] : [override] })).rejects.toThrow();
    expect(workflowWorkingService.beginEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('keeps the displayed defaults even if an isolated child has no saved settings', async () => {
    const { service, repository, workflowWorkingService, workingRepository } = serviceWith();
    workingRepository.findNodeState.mockImplementation(async (_project: string, runId: string) => runId === 'run-a'
      ? { revision: 7, state: { capabilityKey: 'SEEDANCE_1_0', ratio: 'adaptive', resolution: '480p' } } : null);
    workflowWorkingService.beginEffectNodeEdit.mockResolvedValue({ run: { id: 'child' }, productIdMap: { 'product-a': 'child-product' }, taskIdMap: {}, created: true });
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a', expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 7, idempotencyKey: 'frozen-defaults' });
    expect(repository.createBatch.mock.calls[0]![3].tasks[0].requestSnapshot.renderSettings).toEqual({
      capabilityKey: 'SEEDANCE_1_0', ratio: 'adaptive', resolution: '480p',
    });
  });

  it.each(['METADATA', 'REMOVE'] as const)('refreshes %s without paid task snapshots, including deletion of the last Prompt', async (kind) => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'free-initial' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    record.tasks[0].status = 'COMPLETED';
    record.status = 'COMPLETED';
    repository.batch.mockResolvedValue(record);
    const next = promptBatch();
    if (kind === 'REMOVE') next.items = [];
    else next.items[0]!.creativeCore = '更新创意';
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(next), revision: 4 });
    const view = (await service.batch('project-a', record.id)).batch;
    expect(view.refreshScope).toBe('SELECTIVE');
    expect(view.tasks[0]!.updateKind).toBe(kind);
    await service.refresh('project-a', record.id, { expectedBatchRevision: 1,
      expectedPromptArtifactRevision: 4, idempotencyKey: 'free-refresh' });
    const call = repository.regenerateTasks.mock.calls[0]!;
    expect(call[2]).toEqual([]);
    expect(call[5].taskSnapshots).toEqual({});
    expect(call[5].addedTasks).toEqual([]);
    if (kind === 'REMOVE') expect(call[5].removedTaskIds).toEqual([record.tasks[0].id]);
    else expect(Object.keys(call[5].metadataSnapshots)).toEqual([record.tasks[0].id]);
  });

  it('single-card refresh excludes unrelated additions and removals, while top refresh processes all differences', async () => {
    const initial = promptBatch();
    initial.items.push({ ...structuredClone(initial.items[0]!), id: '22222222-2222-4222-8222-222222222222', code: 'P002' });
    const { service, repository } = serviceWith({ promptArtifact: vi.fn().mockResolvedValue(promptArtifact(initial)) });
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'mixed-initial' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    record.status = 'COMPLETED';
    record.tasks.forEach((task: { status: string }) => { task.status = 'COMPLETED'; });
    repository.batch.mockResolvedValue(record);
    const next = promptBatch();
    next.items[0]!.content += ' 新正文';
    next.items.push({ ...structuredClone(next.items[0]!), id: '33333333-3333-4333-8333-333333333333', code: 'P003' });
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(next), revision: 4 });
    await service.refresh('project-a', record.id, { expectedBatchRevision: 1,
      expectedPromptArtifactRevision: 4, taskIds: [record.tasks[0].id], idempotencyKey: 'single-refresh' });
    const selected = repository.regenerateTasks.mock.calls[0]!;
    expect(selected[2]).toEqual([record.tasks[0].id]);
    expect(selected[5].addedTasks).toEqual([]);
    expect(selected[5].removedTaskIds).toEqual([]);
    await service.refresh('project-a', record.id, { expectedBatchRevision: 1,
      expectedPromptArtifactRevision: 4, idempotencyKey: 'all-refresh' });
    const all = repository.regenerateTasks.mock.calls[1]!;
    expect(all[2]).toEqual([record.tasks[0].id]);
    expect(all[5].addedTasks).toHaveLength(1);
    expect(all[5].removedTaskIds).toEqual([record.tasks[1].id]);
  });

  it('does not re-add manually deleted material or force a full refresh', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'deleted-initial' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    record.tasks[0].status = 'FAILED';
    record.tasks[0].errorCode = 'MATERIAL_DELETED';
    repository.batch.mockResolvedValue(record);
    const view = (await service.batch('project-a', record.id)).batch;
    expect(view.pendingPromptIds).toEqual([]);
    expect(view.pendingRemovedTaskIds).toEqual([]);
    expect(view.refreshScope).toBe('NONE');
  });

  it('keeps a failed generation abnormal without marking the material as pending update', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'failed-without-update',
    });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    Object.assign(record.tasks[0], {
      status: 'FAILED',
      errorCode: 'PROVIDER_FAILURE',
      errorMessage: '视频生成失败',
    });
    record.status = 'FAILED';
    repository.batch.mockResolvedValue(record);

    const view = (await service.batch('project-a', record.id)).batch;

    expect(view.stale).toBe(false);
    expect(view.refreshScope).toBe('NONE');
    expect(view.tasks[0]).toMatchObject({
      status: 'FAILED',
      abnormal: true,
      needsUpdate: false,
    });
    expect(view.tasks[0]).not.toHaveProperty('updateKind');
  });
  it.each([
    [6.04, 496, 'doubao-seedance-2-0-fast-260128', '720p'],
    [15, 496, 'doubao-seedance-2-0-fast-260128', '720p'],
    [15.041667, 496, 'doubao-seedance-2-5-260628', '720p'],
    [20, 496, 'doubao-seedance-2-5-260628', '720p'],
    [30, 496, 'doubao-seedance-2-5-260628', '720p'],
    [6, 1080, 'doubao-seedance-2-5-260628', '1080p'],
    [15, 2160, 'doubao-seedance-2-0-260128', '4k'],
    [30, 2160, 'doubao-seedance-2-5-260628', '1080p'],
  ] as const)(
    'regenerates imported %s-second clips from their confirmed prompt with duration-based model routing',
    async (duration, shortSide, expectedModel, expectedResolution) => {
      const { service, repository } = serviceWith({
        configValues: { SEEDANCE_MODEL_2_0: 'doubao-seedance-2-0-260128' },
        settingsNode: {
          revision: 1,
          state: { ratio: '9:16', resolution: '720p', capabilityKey: 'SEEDANCE_2_0_FAST' },
        },
      });
      await service.start('project-a', 'product-a', {
        workflowRunId: 'run-a',
        expectedPromptArtifactRevision: 3,
        expectedSettingsRevision: 1,
        idempotencyKey: 'start-import-source',
      });
      const created = await repository.createBatch.mock.results[0]!.value;
      const task = created.batch.tasks[0];
      const snapshot = {
        ...task.requestSnapshot,
        promptId: 'independent-draft-id',
        promptCode: 'I-21',
        promptText:
          '【视频概览】紫苏梅子酱拌意面。\n【逐秒镜头】展现挂酱效果。\n【结束画面】意面挂酱近景。',
        importedMaterial: {
          schemaVersion: 1,
          width: shortSide,
          height: (shortSide * 16) / 9,
          promptDurationMaxSeconds: 10,
        },
        request: { ...task.requestSnapshot.request, duration },
      };
      Object.assign(task, {
        promptId: snapshot.promptId,
        status: 'COMPLETED',
        operationKind: 'GENERATE',
        repairStatus: null,
        providerTaskId: null,
        requestSnapshot: snapshot,
        generationRequestSnapshot: snapshot,
      });
      repository.batch.mockResolvedValue(created.batch);
      await service.regenerate('project-a', created.batch.id, [task.id], 1, 'retry-import');
      const result = repository.regenerateTasks.mock.calls[0]![5].taskSnapshots[task.id];
      expect(result.promptId).toBe('independent-draft-id');
      expect(result.promptText).toBe(snapshot.promptText);
      expect(result.request.content[0].text).toContain(snapshot.promptText);
      expect(result.importedMaterial).toEqual(snapshot.importedMaterial);
      expect(result.inputImages).toHaveLength(1);
      expect(result.request.duration).toBe(Math.round(duration));
      expect(result.request.model).toBe(expectedModel);
      expect(result.request.resolution).toBe(expectedResolution);
    },
  );

  it.each([6.04, 15, 15.041667, 30])(
    'repairs imported %s-second clips via TOS without obsolete public proxy configuration',
    async (duration) => {
      const { service, repository } = serviceWith({
        configValues: {
          STORAGE_DRIVER: 'tos',
          SEEDANCE_MODEL_2_0: 'doubao-seedance-2-0-260128',
          SEEDANCE_REFERENCE_PUBLIC_BASE_URL: undefined,
          SEEDANCE_REFERENCE_SIGNING_SECRET: undefined,
        },
        settingsNode: {
          revision: 1,
          state: { ratio: '9:16', resolution: '720p', capabilityKey: 'SEEDANCE_2_0' },
        },
      });
      await service.start('project-a', 'product-a', {
        workflowRunId: 'run-a',
        expectedPromptArtifactRevision: 3,
        expectedSettingsRevision: 1,
        idempotencyKey: 'start-import-source',
      });
      const created = await repository.createBatch.mock.results[0]!.value;
      const task = created.batch.tasks[0];
      const snapshot = {
        ...task.requestSnapshot,
        importedMaterial: { schemaVersion: 1, width: 496, height: 864 },
        request: { ...task.requestSnapshot.request, duration },
      };
      Object.assign(task, {
        status: 'COMPLETED',
        operationKind: 'GENERATE',
        activeOutputVersion: 1,
        repairStatus: null,
        requestSnapshot: snapshot,
        generationRequestSnapshot: snapshot,
        providerTaskId: null,
        outputFileObjectId: 'file-import',
        outputFileName: 'import.mp4',
        outputMimeType: 'video/mp4',
        outputSizeBytes: 1024,
        outputContentHash: 'e'.repeat(64),
      });
      repository.batch.mockResolvedValue(created.batch);
      await service.startRepair('project-a', created.batch.id, task.id, {
        expectedBatchRevision: 1,
        expectedSourceVersion: 1,
        startMs: 0,
        endMs: Math.floor(duration * 1000),
        instruction: '修改画面瑕疵',
        idempotencyKey: 'repair-import',
      });
      const result = repository.startRepair.mock.calls[0]![8];
      expect(result.inputVideo.durationSeconds).toBe(duration);
      expect(result.request.model).toBe(
        duration > 15 ? 'doubao-seedance-2-5-260628' : 'doubao-seedance-2-0-260128',
      );
      expect(result.repair.providerMode).toBe(duration > 15 ? 'VIDEO_EDIT' : 'VIDEO_REFERENCE');
      expect(result.request.duration).toBe(duration > 15 ? duration : Math.round(duration));
    },
  );
  it('commits an independent import with its own description without staling the upstream Prompt', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'import-fixture',
    });
    const { batch } = await repository.createBatch.mock.results[0]!.value;
    const original = batch.tasks[0];
    Object.assign(original, {
      status: 'COMPLETED',
      repairStatus: null,
      providerTaskId: 'provider-generated',
      outputFileObjectId: 'original-file',
      outputStorageKey: 'staging/original.mp4',
      outputFileName: 'P001.mp4',
      outputMimeType: 'video/mp4',
      outputSizeBytes: 1024,
      outputContentHash: 'a'.repeat(64),
      generationRequestSnapshot: original.requestSnapshot,
    });
    original.requestSnapshot.outputRatio = '121:211';
    const importedSnapshot = {
      ...original.requestSnapshot,
      promptText: '用户确认的独立素材描述',
      promptId: 'independent-prompt',
      promptCode: 'I-002',
      promptContentHash: 'i'.repeat(64),
      importedMaterial: { schemaVersion: 1, width: 1280, height: 720, promptDurationMaxSeconds: 5 },
      request: { ...original.requestSnapshot.request, duration: 30 },
    };
    batch.tasks.push({
      ...original,
      id: 'independent-task',
      promptId: importedSnapshot.promptId,
      renderCode: 'R-002',
      providerTaskId: null,
      requestSnapshot: importedSnapshot,
      generationRequestSnapshot: importedSnapshot,
      outputFileObjectId: 'import-file',
      outputStorageKey: 'staging/import.mp4',
      outputFileName: 'import.mp4',
    });
    repository.batch.mockResolvedValue(batch);
    const presented = await service.batch('project-a', batch.id);
    expect(presented.batch).toMatchObject({ stale: false, refreshScope: 'NONE' });
    expect(presented.batch.tasks[0]).toMatchObject({
      mediaAspectRatio: '9:16',
      mediaResolution: '1080p',
      mediaShortSidePixels: 1080,
    });
    expect(presented.batch.tasks[1]).toMatchObject({
      durationSeconds: 30,
      independentImport: true,
      mediaAspectRatio: '16:9',
      mediaResolution: '720p',
      mediaShortSidePixels: 720,
      needsUpdate: false,
      promptText: '用户确认的独立素材描述',
      origin: 'EXTERNAL_IMPORT',
    });
    const validated = await service.validate('project-a', batch.id, batch.revision);
    expect(validated.valid).toBe(true);
    const outputs = repository.commitValidatedBatch.mock.calls.at(-1)![5];
    const clip = outputs.find(
      (item: { artifactKey: string }) => item.artifactKey === 'render-clip:independent-task',
    );
    expect(clip.input.payload).toMatchObject({
      durationSeconds: 30,
      origin: 'EXTERNAL_IMPORT',
      promptText: '用户确认的独立素材描述',
    });
    expect(
      clip.input.dependencies.some(
        (item: { sourceNodeId: string }) => item.sourceNodeId === 'PROMPT_GENERATION',
      ),
    ).toBe(false);
    expect(
      outputs.find((item: { artifactKey: string }) => item.artifactKey.startsWith('render-batch:'))
        .input.payload.promptDurationMaxSeconds,
    ).toBe(5);
  });
  it('signs TOS reference files without public API configuration and rejects invalid frozen sources', async () => {
    const video = {
      fileObjectId: 'file-a',
      contentHash: 'e'.repeat(64),
      sizeBytes: 1024,
      mimeType: 'video/mp4',
    };
    const task = {
      id: 'task-a',
      projectId: 'project-a',
      workflowRunId: 'run-a',
      status: 'RUNNING',
      operationKind: 'REPAIR',
      renderVersion: 2,
      activeOutputVersion: 1,
      attemptToken: 'attempt-a',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      outputFileObjectId: video.fileObjectId,
      outputContentHash: video.contentHash,
      requestSnapshot: { operation: 'REPAIR', inputVideo: video, repair: { sourceVersion: 1 } },
    };
    const file = {
      id: video.fileObjectId,
      sha256: video.contentHash,
      sizeBytes: video.sizeBytes,
      mimeType: video.mimeType,
      storageKey: 'projects/project-a/source.mp4',
    };
    const { service, repository, storage } = serviceWith({
      configValues: {
        STORAGE_DRIVER: 'tos',
        SEEDANCE_REFERENCE_PUBLIC_BASE_URL: undefined,
        SEEDANCE_REFERENCE_SIGNING_SECRET: undefined,
      },
      task: vi.fn().mockResolvedValue(task),
      fileObject: vi.fn().mockResolvedValue(file),
    });
    storage.signedReadUrl.mockResolvedValue(
      'https://private-bucket.example.test/source.mp4?signed=fixture',
    );
    const signed = await service.referenceVideoUrl('project-a', task.id, 'attempt-a', 2);
    expect(signed.url).toContain('private-bucket');
    expect(Date.parse(signed.expiresAt) - Date.now()).toBeGreaterThan(1_790_000);
    expect(repository.fileObject).toHaveBeenCalledWith('project-a', 'run-a', video.fileObjectId);
    expect(storage.signedReadUrl).toHaveBeenCalledWith(file.storageKey, 1800, video.sizeBytes);
    expect(storage.open).not.toHaveBeenCalled();
    for (const broken of [
      null,
      { ...file, sha256: 'f'.repeat(64) },
      { ...file, sizeBytes: 999 },
      { ...file, mimeType: 'text/plain' },
    ]) {
      repository.fileObject.mockResolvedValue(broken);
      await expect(
        service.referenceVideoUrl('project-a', task.id, 'attempt-a', 2),
      ).rejects.toBeInstanceOf(ConflictException);
    }
    for (const patch of [
      { attemptToken: 'other-attempt' },
      { leaseExpiresAt: new Date(0) },
      { renderVersion: 3 },
      { status: 'COMPLETED' },
      { outputContentHash: 'f'.repeat(64) },
      { activeOutputVersion: 2 },
    ]) {
      repository.task.mockResolvedValue({ ...task, ...patch });
      await expect(
        service.referenceVideoUrl('project-a', task.id, 'attempt-a', 2),
      ).rejects.toBeInstanceOf(ConflictException);
    }
    expect(storage.signedReadUrl).toHaveBeenCalledTimes(1);
  });
  it('creates a paid rerender in an unpublished child rather than mutating its parent run', async () => {
    const { service, repository, workflowWorkingService } = serviceWith();
    workflowWorkingService.beginEffectNodeEdit.mockResolvedValue({
      run: { id: 'run-child' },
      productIdMap: { 'product-a': 'product-child' },
      taskIdMap: {},
      created: true,
    });

    const result = await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'rerender-child',
    });

    expect(repository.createBatch).toHaveBeenCalledWith(
      'project-a',
      'run-child',
      'product-child',
      expect.anything(),
    );
    expect(result.batch.workflowRunId).toBe('run-child');
  });

  it('builds a full rerender only from the latest confirmed Prompt in the child run', async () => {
    const latest = promptBatch();
    latest.items.push({
      ...structuredClone(latest.items[0]!),
      id: '33333333-3333-4333-8333-333333333333',
      code: 'P002',
      content: '最新分支中的第二条已确认 Prompt。',
    });
    const latestArtifact = {
      ...promptArtifact(latest),
      id: 'artifact-prompt-latest',
      revision: 7,
      contentHash: '7'.repeat(64),
    };
    const { service, repository, workflowWorkingService } = serviceWith({
      promptArtifact: vi.fn().mockResolvedValue(latestArtifact),
    });
    workflowWorkingService.beginEffectNodeEdit.mockResolvedValue({
      run: { id: 'run-child' },
      productIdMap: { 'product-a': 'product-child' },
      taskIdMap: {},
      created: true,
    });

    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-parent',
      expectedPromptArtifactRevision: 7,
      expectedSettingsRevision: 0,
      idempotencyKey: 'latest-prompt-only',
    });

    expect(repository.promptArtifact).toHaveBeenCalledWith(
      'project-a',
      'run-child',
      'product-child',
    );
    const input = repository.createBatch.mock.calls[0]![3];
    expect(input.promptArtifact).toEqual({
      id: latestArtifact.id,
      revision: latestArtifact.revision,
      contentHash: latestArtifact.contentHash,
    });
    expect(input.tasks.map((task: { promptId: string }) => task.promptId)).toEqual(
      latest.items.map(({ id }) => id),
    );
    expect(
      input.tasks.every(
        (task: { requestSnapshot: { importedMaterial?: unknown } }) =>
          task.requestSnapshot.importedMaterial === undefined,
      ),
    ).toBe(true);
  });

  it('auto-commits a complete fresh batch through the atomic repository boundary', async () => {
    const { service, repository, workflowWorkingService } = serviceWith({
      commitValidatedBatch: vi.fn().mockResolvedValue({ kind: 'COMMITTED', artifacts: [] }),
    });
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'auto-commit-batch',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    Object.assign(created.batch, { status: 'COMPLETED' });
    Object.assign(created.batch.tasks[0], {
      status: 'COMPLETED',
      operationKind: 'GENERATE',
      repairStatus: null,
      outputFileObjectId: '33333333-3333-4333-8333-333333333333',
      outputStorageKey: 'staging/clip.mp4',
      outputFileName: 'P001.mp4',
      outputMimeType: 'video/mp4',
      outputSizeBytes: 1024,
      outputContentHash: 'e'.repeat(64),
    });
    repository.batch.mockResolvedValue(created.batch);

    await (
      service as unknown as {
        autoCommitCompletedBatch(projectId: string, batchId: string): Promise<void>;
      }
    ).autoCommitCompletedBatch('project-a', created.batch.id);

    expect(repository.commitValidatedBatch).toHaveBeenCalledOnce();
    expect(workflowWorkingService.publishEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('rejects direct material edits on a published render run', async () => {
    const { service, repository, workflowWorkingService } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'published-edit-guard',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    repository.batch.mockResolvedValue(created.batch);
    workflowWorkingService.assertEffectNodeWritable.mockRejectedValueOnce(
      new ConflictException('已确认版本不可直接修改'),
    );

    await expect(
      service.deleteMaterials(
        'project-a',
        created.batch.id,
        [created.batch.tasks[0].id],
        1,
        'delete-denied',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.deleteMaterials).not.toHaveBeenCalled();
  });

  it('resumes a committed auto batch publication after a duplicate Worker callback', async () => {
    const { service, repository, workflowWorkingService } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'resume-auto-publication',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    created.batch.workflowRunId = 'run-child';
    created.batch.committedAt = new Date('2026-09-03T00:01:00.000Z');
    repository.batch.mockResolvedValue(created.batch);
    repository.workflowRun.mockResolvedValue({
      id: 'run-child',
      parentWorkflowRunId: 'run-a',
      branchPublishedAt: null,
      editSessionNodeId: 'SEGMENT_RENDER',
    });

    await (
      service as unknown as {
        autoCommitCompletedBatch(projectId: string, batchId: string): Promise<void>;
      }
    ).autoCommitCompletedBatch('project-a', created.batch.id);

    expect(repository.commitValidatedBatch).not.toHaveBeenCalled();
    expect(workflowWorkingService.publishEffectNodeEdit).toHaveBeenCalledWith(
      'project-a',
      'run-child',
      'SEGMENT_RENDER',
    );
  });

  it('recovers publication on batch polling without a repeated Worker callback', async () => {
    const { service, repository, workflowWorkingService } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'recover-on-batch-read',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    created.batch.workflowRunId = 'run-child';
    created.batch.committedAt = new Date('2026-09-03T00:01:00.000Z');
    repository.batch.mockResolvedValue(created.batch);
    repository.latestBatch.mockResolvedValue(created.batch);
    repository.workflowRun.mockResolvedValue({
      id: 'run-child',
      parentWorkflowRunId: 'run-a',
      branchPublishedAt: null,
      editSessionNodeId: 'SEGMENT_RENDER',
    });
    workflowWorkingService.publishEffectNodeEdit.mockRejectedValueOnce(new Error('transient'));

    await expect(service.batch('project-a', created.batch.id)).rejects.toThrow('transient');
    await service.workspace('project-a', 'run-child', 'product-a');

    expect(workflowWorkingService.publishEffectNodeEdit).toHaveBeenCalledTimes(2);
    expect(repository.commitValidatedBatch).not.toHaveBeenCalled();
  });

  it('does not publish an inherited committed batch while its child is still being edited', async () => {
    const { service, repository, workflowWorkingService } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'inherited-batch-read',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    created.batch.workflowRunId = 'run-child';
    created.batch.committedAt = new Date('2026-09-02T00:01:00.000Z');
    repository.batch.mockResolvedValue(created.batch);
    repository.latestBatch.mockResolvedValue(created.batch);

    await service.batch('project-a', created.batch.id);
    await service.workspace('project-a', 'run-child', 'product-a');

    expect(workflowWorkingService.publishEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('rejects ambiguous external-import mappings before storing files', async () => {
    const { service, storage } = serviceWith();

    await expect(
      service.importMaterials(
        'project-a',
        '55555555-5555-4555-8555-555555555555',
        {
          expectedBatchRevision: 1,
          idempotencyKey: 'import-a',
          mappings: JSON.stringify([
            { fileIndex: 0, taskId: '11111111-1111-4111-8111-111111111111' },
            { fileIndex: 0, taskId: '22222222-2222-4222-8222-222222222222' },
          ]),
        },
        [
          {
            fieldname: 'files',
            path: 'unused.mp4',
            originalname: 'P001.mp4',
            mimetype: 'video/mp4',
            size: 1024,
          },
          {
            fieldname: 'files',
            path: 'unused-2.mp4',
            originalname: 'P002.mp4',
            mimetype: 'video/mp4',
            size: 1024,
          },
        ],
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('deletes completed outputs through the revision-checked repository operation', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-delete-source',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    repository.batch.mockResolvedValue(created.batch);

    const result = await service.deleteMaterials(
      'project-a',
      created.batch.id,
      [created.batch.tasks[0].id],
      1,
      'delete-a',
    );

    expect(repository.deleteMaterials).toHaveBeenCalledWith(
      'project-a',
      created.batch.id,
      [created.batch.tasks[0].id],
      1,
      'delete-a',
    );
    expect(result.replayed).toBe(false);
  });

  it('streams a ZIP manifest for the selected task range', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-export-source',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    repository.batch.mockResolvedValue(created.batch);

    const exported = await service.exportMaterials(
      'project-a',
      created.batch.id,
      [created.batch.tasks[0].id],
      ['MANIFEST_JSON'],
      1,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of exported.stream) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks).subarray(0, 2).toString()).toBe('PK');
    expect(exported.fileName).toContain('测试产品-视频素材-');
  });

  it('returns the confirmed Prompt count required by the real render workspace', async () => {
    const { service } = serviceWith();

    const result = await service.workspace('project-a', 'run-a', 'product-a');

    expect(result).toMatchObject({
      promptReady: true,
      promptCount: 1,
      promptArtifactRevision: 3,
      promptRenderInputs: [{ promptId: item.id, promptCode: item.code, promptText: item.content }],
      batch: null,
    });
  });

  it('does not offer unconfirmed Prompt content for configuration review', async () => {
    const { service } = serviceWith({ promptArtifact: vi.fn().mockResolvedValue({
      ...promptArtifact(), freshness: 'STALE',
    }) });
    const result = await service.workspace('project-a', 'run-a', 'product-a');
    expect(result.promptReady).toBe(false);
    expect(result.promptRenderInputs).toEqual([]);
  });

  it('uses the confirmed extraction product name in the batch and preview tasks', async () => {
    const { service } = serviceWith({
      marketingInsightArtifact: vi.fn().mockResolvedValue({
        payload: { productName: '紫苏梅子酱' },
      }),
    });

    const result = await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-extracted-name',
    });

    expect(result.batch.productName).toBe('紫苏梅子酱');
    expect(result.batch.tasks.map(({ productName }) => productName)).toEqual(['紫苏梅子酱']);
  });

  it('freezes one render task per confirmed Prompt and appends the shared prompt once', async () => {
    const { service, repository } = serviceWith();

    const result = await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-a',
    });

    expect(result.replayed).toBe(false);
    expect(result.batch.tasks).toHaveLength(1);
    expect(repository.createBatch).toHaveBeenCalledOnce();
    const input = repository.createBatch.mock.calls[0]![3];
    expect(input.tasks[0].requestSnapshot).toMatchObject({
      promptId: item.id,
      promptCode: 'P001',
      request: { model: 'seedance-model', duration: 5, ratio: '9:16', resolution: '1080p' },
      inputImages: [
        expect.objectContaining({
          fileObjectId: '22222222-2222-4222-8222-222222222222',
          originalFileName: 'main.png',
        }),
      ],
    });
    expect(
      input.tasks[0].requestSnapshot.request.content[0].text.match(/保持产品外观一致/gu),
    ).toHaveLength(1);
    expect(input.tasks[0].requestSnapshot.request.content[0].text).not.toContain('创意主线：');
  });

  it.each([
    ['SEEDANCE_1_5_PRO', 'doubao-seedance-2-5-260628'],
    ['SEEDANCE_2_0', 'doubao-seedance-2-0-260128'],
    ['SEEDANCE_1_0', 'doubao-seedance-2-0-mini-260615'],
    ['SEEDANCE_2_0_FAST', 'doubao-seedance-2-0-fast-260128'],
  ] satisfies ReadonlyArray<readonly [EffectPromptRenderCapabilityKey, string]>)(
    'maps capability %s to its real Seedance model without requiring another API key',
    async (capabilityKey, expectedModel) => {
      const { service, repository } = serviceWith({
        configValues: capabilityKey === 'SEEDANCE_2_0' ? { SEEDANCE_MODEL: undefined } : {},
        settingsNode: {
          revision: 1,
          state: { ratio: '9:16', resolution: '720p', capabilityKey },
        },
      });

      await service.start('project-a', 'product-a', {
        workflowRunId: 'run-a',
        expectedPromptArtifactRevision: 3,
        expectedSettingsRevision: 1,
        idempotencyKey: `request-default-model-${capabilityKey}`,
      });

      const input = repository.createBatch.mock.calls[0]![3];
      expect(input.tasks[0].requestSnapshot.request.model).toBe(expectedModel);
    },
  );

  it('rejects a stale Prompt revision before creating jobs', async () => {
    const { service, repository } = serviceWith();

    await expect(
      service.start('project-a', 'product-a', {
        workflowRunId: 'run-a',
        expectedPromptArtifactRevision: 2,
        expectedSettingsRevision: 0,
        idempotencyKey: 'request-a',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.createBatch).not.toHaveBeenCalled();
  });

  it('marks only changed Prompt slots for selective rerendering', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-selective-refresh',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    repository.batch.mockResolvedValue(created.batch);
    repository.renderArtifact.mockResolvedValue({
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
    });
    const updated = promptBatch();
    updated.items[0]!.content += ' Prompt 更新。';
    repository.promptArtifact.mockResolvedValue({
      ...promptArtifact(updated),
      revision: 4,
      contentHash: 'e'.repeat(64),
    });

    const result = await service.batch('project-a', created.batch.id);

    expect(result.batch.refreshScope).toBe('SELECTIVE');
    expect(
      result.batch.tasks.filter(({ needsUpdate }) => needsUpdate).map(({ promptId }) => promptId),
    ).toEqual([item.id]);
  });

  it('compares the shared source pool with saved Prompts in the viewing branch, not its owner', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'scoped-view' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    record.tasks[0].status = 'COMPLETED';
    repository.batch.mockResolvedValue(record);
    repository.workspaceBatch.mockResolvedValue(record);
    const changed = promptBatch();
    changed.items[0]!.content += '最终修改。';
    changed.items.push({ ...structuredClone(item), id: '99999999-9999-4999-8999-999999999999' });
    repository.promptArtifact.mockImplementation(async (_project, run) =>
      run === 'view-run' ? { ...promptArtifact(changed), revision: 4 } : promptArtifact());
    const result = await service.workspace('project-a', 'view-run', 'view-product');
    expect(result.batch?.id).toBe(record.id);
    expect(result.batch?.refreshScope).toBe('SELECTIVE');
    expect(result.batch?.latestPromptRevision).toBe(4);
    expect(result.batch?.tasks[0]?.needsUpdate).toBe(true);
    expect(result.batch?.pendingPromptIds).toEqual([changed.items[1]!.id]);
    expect((await service.batch('project-a', record.id)).batch.stale).toBe(false);
    changed.items = [];
    const removed = await service.workspace('project-a', 'view-run', 'view-product');
    expect(removed.batch?.pendingRemovedTaskIds).toEqual([record.tasks[0].id]);
    repository.promptArtifact.mockResolvedValue(promptArtifact());
    expect((await service.workspace('project-a', 'view-run', 'view-product')).batch?.stale).toBe(false);
  });

  it('shows confirmed videos and Prompt differences while an upstream Prompt edit is still unsaved', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'upstream-edit-read' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    record.tasks[0].status = 'COMPLETED';
    repository.batch.mockResolvedValue(record);
    repository.workspaceBatch.mockResolvedValue(record);
    repository.workspaceReadContext.mockResolvedValue({ workflowRunId: 'run-a', productId: 'product-a' });
    repository.promptArtifact.mockImplementation(async (_project, run) =>
      run === 'prompt-edit' ? null : promptArtifact());
    const result = await service.workspace('project-a', 'prompt-edit', 'draft-product');
    expect(result).toMatchObject({ workflowRunId: 'prompt-edit', productId: 'draft-product', promptReady: true });
    expect(result.batch?.id).toBe(record.id);
    expect(result.batch?.stale).toBe(false);
    expect(repository.workspaceBatch).toHaveBeenLastCalledWith('project-a', 'run-a', 'product-a');
    expect(repository.promptArtifact).not.toHaveBeenCalledWith('project-a', 'prompt-edit', 'draft-product');
  });

  it('prepares a shared-pool refresh in the viewing branch and freezes its saved Prompt', async () => {
    const { service, repository, workflowWorkingService } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'scoped-refresh' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    record.tasks[0].status = 'COMPLETED';
    const target = { ...record, id: 'edit-batch', workflowRunId: 'edit-run', productId: 'edit-product' };
    repository.batch.mockImplementation(async (_project, id) => id === target.id ? target : record);
    repository.workspaceBatch.mockResolvedValue(record);
    repository.latestBatch.mockResolvedValue(target);
    workflowWorkingService.beginEffectNodeEdit.mockResolvedValue({ run: { id: 'edit-run' },
      productIdMap: { 'view-product': 'edit-product' }, taskIdMap: {}, created: true });
    const latest = promptBatch(); latest.items[0]!.content += '最终保存的修改。';
    repository.promptArtifact.mockImplementation(async (_project, run) => run === 'run-a'
      ? promptArtifact() : { ...promptArtifact(latest), revision: 4 });
    await service.refresh('project-a', record.id, { expectedBatchRevision: 1,
      expectedPromptArtifactRevision: 4, idempotencyKey: 'scoped-operation',
      settingsContext: { workflowRunId: 'view-run', productId: 'view-product', expectedSettingsRevision: 0 } });
    expect(workflowWorkingService.beginEffectNodeEdit).toHaveBeenLastCalledWith('project-a', 'view-run', 'SEGMENT_RENDER', 'MANUAL');
    expect(repository.latestBatch).toHaveBeenCalledWith('project-a', 'edit-run', 'edit-product');
    const operation = repository.regenerateTasks.mock.calls[0]!;
    expect(operation[1]).toBe('edit-batch');
    expect(operation[5].taskSnapshots[record.tasks[0].id].promptText).toBe(latest.items[0]!.content);
    expect(operation[5].taskSnapshots[record.tasks[0].id].sourcePrompt.revision).toBe(4);
  });

  it('detects additions without invalidating unchanged tasks and appends only the new Prompt', async () => {
    const { service, repository, workflowWorkingService } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'initial',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    const record = created.batch;
    record.tasks.forEach((task: { status: string }) => {
      task.status = 'COMPLETED';
    });
    repository.batch.mockResolvedValue(record);
    const next = promptBatch();
    next.items.push({ ...item, id: '99999999-9999-4999-8999-999999999999', code: 'P002' });
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(next), revision: 4 });
    const view = (await service.batch('project-a', record.id)).batch;
    expect(view.stale).toBe(true);
    expect(view.refreshScope).toBe('SELECTIVE');
    expect(view.pendingPromptIds).toEqual([next.items[1]!.id]);
    expect(view.tasks.every((task) => !task.needsUpdate)).toBe(true);
    await service.refresh('project-a', record.id, {
      expectedBatchRevision: 1,
      expectedPromptArtifactRevision: 4,
      idempotencyKey: 'append',
    });
    expect(workflowWorkingService.beginEffectNodeEdit).toHaveBeenLastCalledWith(
      'project-a',
      'run-a',
      'SEGMENT_RENDER',
      'MANUAL',
    );
    const call = repository.regenerateTasks.mock.calls[0]!;
    expect(call[2]).toEqual([]);
    expect(call[5].addedTasks).toHaveLength(1);
    expect(call[5].addedTasks[0]).toMatchObject({
      promptId: next.items[1]!.id,
      renderCode: 'R-002',
    });
    expect(call[5].addedTasks[0].requestSnapshot.sourcePrompt.revision).toBe(4);
    expect(repository.createBatch).toHaveBeenCalledTimes(1);
  });

  it('uses current defaults only for added Prompts and keeps existing clip settings through an isolated refresh', async () => {
    const { service, repository, workflowWorkingService, workingRepository } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a', expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0, idempotencyKey: 'initial-defaults' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    record.tasks[0].status = 'COMPLETED';
    const child = { ...record, id: 'child-batch', workflowRunId: 'child', productId: 'child-product' };
    repository.batch.mockImplementation(async (_project, id) => id === child.id ? child : record);
    repository.latestBatch.mockResolvedValue(child);
    repository.workspaceBatch.mockResolvedValue(record);
    workflowWorkingService.beginEffectNodeEdit.mockResolvedValue({ run: { id: 'child' }, productIdMap: { 'product-a': 'child-product' }, taskIdMap: {}, created: true });
    const defaults = { capabilityKey: 'SEEDANCE_1_0', ratio: 'adaptive', resolution: '480p' };
    workingRepository.findNodeState.mockImplementation(async (_project, run) => run === 'run-a' ? { revision: 7, state: defaults } : null);
    const next = promptBatch();
    next.items[0]!.content += '镜头稍微推近。';
    next.items.push({ ...structuredClone(item), id: '99999999-9999-4999-8999-999999999999', code: 'P002' });
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(next), revision: 4 });
    await service.refresh('project-a', record.id, { expectedBatchRevision: 1, expectedPromptArtifactRevision: 4,
      idempotencyKey: 'isolated-defaults', settingsContext: { workflowRunId: 'run-a', productId: 'product-a', expectedSettingsRevision: 7 } });
    const operation = repository.regenerateTasks.mock.calls[0]![5];
    expect(operation.addedTasks[0].requestSnapshot.renderSettings).toEqual(defaults);
    expect(operation.taskSnapshots[record.tasks[0].id].renderSettings).toEqual(record.tasks[0].requestSnapshot.renderSettings);
    expect(workingRepository.saveNodeState).not.toHaveBeenCalled();
  });

  it('freezes individual overrides for multiple long additions during a local refresh', async () => {
    const { service, repository, workingRepository } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a', expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0, idempotencyKey: 'initial-long-additions' });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    record.tasks[0].status = 'COMPLETED';
    repository.batch.mockResolvedValue(record);
    const next = promptBatch();
    const additions = [21, 24, 30].map((duration, index) => ({ ...structuredClone(item),
      id: `${index + 2}9999999-9999-4999-8999-999999999999`, code: `P00${index + 2}`,
      origin: 'MANUAL' as const, targetDurationSeconds: duration }));
    next.items.push(...additions);
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(next), revision: 4 });
    const promptSettings = additions.map(({ id }, index) => ({ promptId: id, settings: {
      capabilityKey: 'SEEDANCE_1_5_PRO' as const, ratio: '9:16' as const,
      resolution: index === 1 ? '720p' as const : '1080p' as const,
    } }));
    await service.refresh('project-a', record.id, { expectedBatchRevision: 1, expectedPromptArtifactRevision: 4,
      idempotencyKey: 'refresh-long-additions', promptSettings });
    const operation = repository.regenerateTasks.mock.calls[0]![5];
    expect(operation.addedTasks).toHaveLength(3);
    operation.addedTasks.forEach((task: { requestSnapshot: { renderSettings: unknown } }, index: number) =>
      expect(task.requestSnapshot.renderSettings).toEqual(promptSettings[index]!.settings));
    expect(workingRepository.saveNodeState).not.toHaveBeenCalled();
  });

  it.each(['stale', 'changed-during-prepare', 'wrong-workspace'] as const)(
    'rejects %s defaults during refresh without enqueueing tasks', async (reason) => {
      const { service, repository, workingRepository, workflowWorkingService } = serviceWith();
      await service.start('project-a', 'product-a', { workflowRunId: 'run-a', expectedPromptArtifactRevision: 3,
        expectedSettingsRevision: 0, idempotencyKey: 'initial-revision-guard' });
      const record = (await repository.createBatch.mock.results[0]!.value).batch;
      record.tasks[0].status = 'COMPLETED';
      repository.batch.mockResolvedValue(record);
      repository.workspaceBatch.mockResolvedValue(reason === 'wrong-workspace' ? { id: 'other-batch' } : record);
      const next = promptBatch();
      next.items.push({ ...structuredClone(item), id: '99999999-9999-4999-8999-999999999999', code: 'P002' });
      repository.promptArtifact.mockResolvedValue({ ...promptArtifact(next), revision: 4 });
      const defaults = { revision: 7, state: { capabilityKey: 'SEEDANCE_2_0', ratio: '9:16', resolution: '720p' } };
      workingRepository.findNodeState.mockResolvedValue(defaults);
      if (reason === 'changed-during-prepare') {
        workflowWorkingService.beginEffectNodeEdit.mockImplementationOnce(async () => {
          workingRepository.findNodeState.mockResolvedValue({ ...defaults, revision: 8 });
          return { run: { id: 'run-a' }, productIdMap: {}, taskIdMap: {}, created: false };
        });
      }
      await expect(service.refresh('project-a', record.id, { expectedBatchRevision: 1, expectedPromptArtifactRevision: 4,
        idempotencyKey: `guard-${reason}`, settingsContext: { workflowRunId: 'run-a', productId: 'product-a',
          expectedSettingsRevision: reason === 'stale' ? 6 : 7 } })).rejects.toBeInstanceOf(ConflictException);
      expect(repository.regenerateTasks).not.toHaveBeenCalled();
    },
  );

  it('does not rerender semantic metadata and rejects stale refresh inputs before opening an edit', async () => {
    const { service, repository, workflowWorkingService } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'initial-metadata',
    });
    const record = (await repository.createBatch.mock.results[0]!.value).batch;
    repository.batch.mockResolvedValue(record);
    const next = promptBatch();
    next.items[0]!.creativeCore = '修改创意说明';
    next.items[0]!.dimensions.camera = '修改镜头说明';
    repository.promptArtifact.mockResolvedValue({ ...promptArtifact(next), revision: 4 });
    const view = (await service.batch('project-a', record.id)).batch;
    expect(view.refreshScope).toBe('SELECTIVE');
    expect(view.tasks[0]).toMatchObject({ needsUpdate: true, updateKind: 'METADATA' });
    const callsBefore = workflowWorkingService.beginEffectNodeEdit.mock.calls.length;
    await expect(
      service.refresh('project-a', record.id, {
        expectedBatchRevision: 1,
        expectedPromptArtifactRevision: 3,
        idempotencyKey: 'stale',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(workflowWorkingService.beginEffectNodeEdit).toHaveBeenCalledTimes(callsBefore);
    expect(repository.regenerateTasks).not.toHaveBeenCalled();
  });

  it('lets a batch that already matches the current Prompt be validated while its copies are uncommitted', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-uncommitted',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    repository.batch.mockResolvedValue(created.batch);
    // A rerender delivers new clips but does not commit them: their working copies stay STALE until
    // the user validates. That pending commit must not read as "the Prompt moved on", otherwise the
    // rerender entry point is the only enabled action and it can never be validated.
    repository.renderArtifact.mockResolvedValue({
      freshness: 'STALE',
      availability: 'AVAILABLE',
    });

    const result = await service.batch('project-a', created.batch.id);

    expect(result.batch.stale).toBe(false);
    expect(result.batch.refreshScope).toBe('NONE');
    expect(result.batch.commitStatus).toBe('DRAFT_CHANGED');
  });

  it('saves explicit AI and import deletions including an empty pool, without treating supplier failure as deletion', async () => {
    const { service, repository } = serviceWith();
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'delete-save' });
    const { batch } = await repository.createBatch.mock.results[0]!.value;
    Object.assign(batch.tasks[0], { status: 'FAILED', errorCode: 'MATERIAL_DELETED', repairStatus: null });
    batch.tasks.push({ ...batch.tasks[0], id: 'deleted-import', promptId: 'import-prompt',
      requestSnapshot: { ...batch.tasks[0].requestSnapshot, importedMaterial: { schemaVersion: 1 } } });
    repository.batch.mockResolvedValue(batch);
    const presented = await service.batch('project-a', batch.id);
    expect(presented.batch.tasks).toEqual([]);
    expect(presented.batch.pendingPromptIds).toEqual([]);
    expect(presented.batch.summary).toEqual({ total: 0, completed: 0, running: 0, failed: 0 });
    expect((await service.validate('project-a', batch.id, batch.revision)).valid).toBe(true);
    const inputs = repository.commitValidatedBatch.mock.calls.at(-1)![5];
    const pool = inputs.find((row: { artifactKey: string }) => row.artifactKey.startsWith('render-batch:'));
    expect(pool.input.payload.clips).toEqual([]);
    expect(pool.input.payload.removedSources).toEqual([
      { taskId: batch.tasks[0].id, promptId: batch.tasks[0].promptId },
      { taskId: 'deleted-import', promptId: 'import-prompt' },
    ]);
    batch.tasks[0].errorCode = 'PROVIDER_FAILURE';
    expect((await service.validate('project-a', batch.id, batch.revision)).valid).toBe(false);
  });

  it('reports a commit clash as a retryable conflict instead of an internal error', async () => {
    const { service, repository } = serviceWith({
      commitValidatedBatch: vi.fn().mockResolvedValue({ kind: 'CONFLICT' }),
    });
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-conflict',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    Object.assign(created.batch.tasks[0], {
      status: 'COMPLETED',
      repairStatus: null,
      outputFileObjectId: '33333333-3333-4333-8333-333333333333',
      outputStorageKey: 'staging/clip.mp4',
      outputFileName: 'P001.mp4',
      outputMimeType: 'video/mp4',
      outputSizeBytes: 1024,
      outputContentHash: 'e'.repeat(64),
    });
    repository.batch.mockResolvedValue(created.batch);

    await expect(
      service.validate('project-a', created.batch.id, created.batch.revision),
    ).rejects.toThrow('校验提交遇到并发写入，请稍后重试');
  });

  it('creates fifty independent tasks while freezing the same complete image set for every Prompt', async () => {
    const many = promptBatch();
    many.items = Array.from({ length: 50 }, (_, index) => ({
      ...item,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      code: `P${String(index + 1).padStart(3, '0')}`,
      content: `${item.content} 片段 ${index + 1}。`,
    }));
    const { service, repository } = serviceWith({
      promptArtifact: vi.fn().mockResolvedValue(promptArtifact(many)),
    });

    const result = await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-50',
    });

    expect(result.batch.tasks).toHaveLength(50);
    const input = repository.createBatch.mock.calls[0]![3];
    expect(new Set(input.tasks.map((task: { promptId: string }) => task.promptId)).size).toBe(50);
    expect(
      input.tasks.every(
        (task: { requestSnapshot: { inputImages: unknown[] } }) =>
          task.requestSnapshot.inputImages === input.inputImages,
      ),
    ).toBe(true);
  });

  it('keeps legacy batches readable but marks snapshots without product images as stale', async () => {
    const { service, repository } = serviceWith();

    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-legacy',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    delete created.batch.tasks[0].requestSnapshot.sourcePackage;
    delete created.batch.tasks[0].requestSnapshot.inputImages;
    repository.batch.mockResolvedValue(created.batch);

    const result = await service.batch('project-a', created.batch.id);

    expect(result.batch.stale).toBe(true);
    expect(result.batch.tasks).toHaveLength(1);
  });

  it('creates a repair task from the active video without reusing generation images or Prompt', async () => {
    const { service, repository } = serviceWith({
      configValues: {
        SEEDANCE_REFERENCE_PUBLIC_BASE_URL: undefined,
        SEEDANCE_REFERENCE_SIGNING_SECRET: undefined,
      },
    });
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-repair-source',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    const task = created.batch.tasks[0];
    Object.assign(task, {
      status: 'COMPLETED',
      operationKind: 'GENERATE',
      activeOutputVersion: 1,
      generationRequestSnapshot: task.requestSnapshot,
      repairStatus: null,
      providerTaskId: 'provider-source-task',
      outputFileObjectId: '33333333-3333-4333-8333-333333333333',
      outputStorageKey: 'staging/source.mp4',
      outputFileName: 'P001.mp4',
      outputMimeType: 'video/mp4',
      outputSizeBytes: 1024,
      outputContentHash: 'e'.repeat(64),
    });
    repository.batch.mockResolvedValue(created.batch);

    await service.startRepair('project-a', created.batch.id, task.id, {
      expectedBatchRevision: 1,
      expectedSourceVersion: 1,
      startMs: 1200,
      endMs: 2600,
      instruction: '移除台面上的黑色污点',
      idempotencyKey: 'request-repair',
    });

    expect(repository.startRepair).toHaveBeenCalledOnce();
    const repairSnapshot = repository.startRepair.mock.calls[0]![8];
    expect(repairSnapshot).toMatchObject({
      operation: 'REPAIR',
      inputImages: [],
      inputVideo: {
        fileObjectId: '33333333-3333-4333-8333-333333333333',
        providerTaskId: 'provider-source-task',
        durationSeconds: 5,
      },
      repair: {
        sourceVersion: 1,
        startMs: 1200,
        endMs: 2600,
        instruction: '移除台面上的黑色污点',
      },
    });
    expect(repairSnapshot.request.content[0].text).toContain('[1.200s-2.600s]');
    expect(repairSnapshot.request.model).toBe('doubao-seedance-2-5-260628');
    expect(repairSnapshot.request.content[0].text).not.toContain(item.content);
  });

  it('signs the frozen reference video and supports authenticated byte ranges', async () => {
    const { service, repository, storage } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-reference-source',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    const task = created.batch.tasks[0];
    Object.assign(task, {
      status: 'COMPLETED',
      operationKind: 'GENERATE',
      activeOutputVersion: 1,
      generationRequestSnapshot: task.requestSnapshot,
      repairStatus: null,
      outputFileObjectId: '33333333-3333-4333-8333-333333333333',
      outputStorageKey: 'staging/source.mp4',
      outputFileName: 'P001.mp4',
      outputMimeType: 'video/mp4',
      outputSizeBytes: 1024,
      outputContentHash: 'e'.repeat(64),
    });
    repository.batch.mockResolvedValue(created.batch);
    await service.startRepair('project-a', created.batch.id, task.id, {
      expectedBatchRevision: 1,
      expectedSourceVersion: 1,
      startMs: 1000,
      endMs: 2000,
      instruction: '修复污点',
      idempotencyKey: 'request-reference-url',
    });
    const snapshot = repository.startRepair.mock.calls[0]![8];
    Object.assign(task, {
      status: 'RUNNING',
      operationKind: 'REPAIR',
      renderVersion: 2,
      requestSnapshot: snapshot,
      attemptToken: 'attempt-a',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    repository.task = vi.fn().mockResolvedValue(task);
    repository.taskById = vi.fn().mockResolvedValue(task);
    repository.fileObject = vi.fn().mockResolvedValue({
      id: task.outputFileObjectId,
      originalFileName: task.outputFileName,
      mimeType: task.outputMimeType,
      sizeBytes: task.outputSizeBytes,
      sha256: task.outputContentHash,
      storageKey: task.outputStorageKey,
    });
    storage.open.mockResolvedValue({
      stream: Readable.from([Buffer.alloc(10)]),
      sizeBytes: 1024,
      start: 10,
      end: 19,
      contentLength: 10,
    });

    const signed = await service.referenceVideoUrl('project-a', task.id, 'attempt-a', 2);
    const url = new URL(signed.url);
    const expires = Number(url.searchParams.get('expires'));
    const signature = url.searchParams.get('signature')!;
    await expect(
      service.providerReferenceVideo(
        task.id,
        task.outputFileObjectId,
        2,
        expires,
        signature + 'tampered',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const content = await service.providerReferenceVideo(
      task.id,
      task.outputFileObjectId,
      2,
      expires,
      signature,
      'bytes=10-19',
    );
    expect(url.pathname).toBe(
      `/api/provider-inputs/effect-segment-render/${task.id}/${task.outputFileObjectId}`,
    );
    expect(content).toMatchObject({ partial: true, start: 10, end: 19, contentLength: 10 });
    expect(storage.open).toHaveBeenCalledWith('staging/source.mp4', { start: 10, end: 19 });
  });

  it('serves a versioned poster without opening the video body', async () => {
    const { service, repository, storage } = serviceWith();
    await service.start('project-a', 'product-a', {
      workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3,
      expectedSettingsRevision: 0,
      idempotencyKey: 'request-poster-source',
    });
    const created = await repository.createBatch.mock.results[0]!.value;
    const task = created.batch.tasks[0];
    Object.assign(task, {
      status: 'COMPLETED',
      activeOutputVersion: 1,
      outputFileObjectId: '33333333-3333-4333-8333-333333333333',
      outputFileName: 'P001.mp4',
      outputMimeType: 'video/mp4',
      outputSizeBytes: 1024,
      outputContentHash: 'e'.repeat(64),
      outputPoster: {
        fileObjectId: '44444444-4444-4444-8444-444444444444',
        originalFileName: 'P001-poster.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 128,
        contentHash: 'f'.repeat(64),
        version: 1,
      },
    });
    repository.task.mockResolvedValue(task);
    repository.fileObject.mockResolvedValue({
      id: task.outputPoster.fileObjectId,
      originalFileName: task.outputPoster.originalFileName,
      mimeType: task.outputPoster.mimeType,
      sizeBytes: task.outputPoster.sizeBytes,
      sha256: task.outputPoster.contentHash,
      storageKey: 'staging/P001-poster.jpg',
    });
    storage.open.mockResolvedValue({
      stream: Readable.from([Buffer.alloc(128)]),
      sizeBytes: 128,
      start: 0,
      end: 127,
      contentLength: 128,
    });

    const content = await service.taskContent(
      'project-a',
      created.batch.id,
      task.id,
      'ACTIVE',
      'POSTER',
      1,
    );

    expect(content).toMatchObject({
      mimeType: 'image/jpeg',
      contentHash: 'f'.repeat(64),
      partial: false,
    });
    expect(storage.open).toHaveBeenCalledWith('staging/P001-poster.jpg', undefined);
    await expect(
      service.taskContent('project-a', created.batch.id, task.id, 'ACTIVE', 'POSTER', 2),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
import { Readable } from 'node:stream';
