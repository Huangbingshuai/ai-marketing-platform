import type {
  EffectPromptBatchResult,
  EffectPromptItem,
  EffectPromptRenderCapabilityKey,
} from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_PROMPT_SETTINGS } from '@ai-marketing/contracts';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { EffectSegmentRenderService } from './effect-segment-render.service';
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
    [item],
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
    {
      findNodeState: vi.fn().mockResolvedValue(settingsNode),
      saveNodeState: vi.fn(),
      listArtifacts: vi.fn().mockResolvedValue([]),
    } as never,
    workflowWorkingService as never,
  );
  return { service, repository, storage, workflowWorkingService };
};

describe('EffectSegmentRenderService', () => {
  it.each([4, 15, 16, 30])('routes manual %s-second Prompt items without changing the batch slot limit', async (duration) => {
    const next = promptBatch();
    next.items[0] = { ...next.items[0]!, origin: 'MANUAL', targetDurationSeconds: duration };
    const { service, repository } = serviceWith({ promptArtifact: vi.fn().mockResolvedValue(promptArtifact(next)) });
    await service.start('project-a', 'product-a', { workflowRunId: 'run-a',
      expectedPromptArtifactRevision: 3, expectedSettingsRevision: 0, idempotencyKey: 'manual-duration' });
    const snapshot = repository.createBatch.mock.calls[0]![3].tasks[0].requestSnapshot;
    expect(snapshot.request.duration).toBe(duration);
    expect(snapshot.promptDurationMaxSeconds).toBe(next.settings.defaultDurationSeconds);
    expect(snapshot.renderSettings.capabilityKey).toBe(duration > 15 ? 'SEEDANCE_1_5_PRO' : next.renderProfile.capabilityKey);
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
      outputFileObjectId: 'original-file',
      outputStorageKey: 'staging/original.mp4',
      outputFileName: 'P001.mp4',
      outputMimeType: 'video/mp4',
      outputSizeBytes: 1024,
      outputContentHash: 'a'.repeat(64),
      generationRequestSnapshot: original.requestSnapshot,
    });
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
    expect(presented.batch.tasks[1]).toMatchObject({
      durationSeconds: 30,
      independentImport: true,
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
      batch: null,
    });
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
    expect(result.batch.commitStatus).toBe('STALE');
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
