import type { EffectPromptBatchResult, EffectPromptItem } from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_PROMPT_SETTINGS } from '@ai-marketing/contracts';
import { ConflictException } from '@nestjs/common';
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
  const artifact = promptArtifact();
  const repository = {
    workflowRun: vi.fn().mockResolvedValue({ id: 'run-a' }),
    product: vi.fn().mockResolvedValue({ id: 'product-a', name: '测试产品' }),
    promptArtifact: vi.fn().mockResolvedValue(artifact),
    sourcePackageArtifact: vi.fn().mockResolvedValue(sourcePackageArtifact),
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
    ...overrides,
  };
  const storage = {
    open: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
  const service = new EffectSegmentRenderService(
    repository as never,
    { get: vi.fn().mockResolvedValue({ id: 'project-a', name: '项目 A' }) } as never,
    {
      get: vi.fn((key: string) => {
        if (key === 'SEEDANCE_MODEL') return 'seedance-model';
        if (key === 'SEEDANCE_REFERENCE_PUBLIC_BASE_URL') return 'https://api.example.test/api';
        if (key === 'SEEDANCE_REFERENCE_SIGNING_SECRET')
          return 'a-secure-signing-secret-with-32-characters';
        return undefined;
      }),
    } as never,
    storage as never,
    {
      findNodeState: vi.fn().mockResolvedValue(null),
      saveNodeState: vi.fn(),
    } as never,
  );
  return { service, repository, storage };
};

describe('EffectSegmentRenderService', () => {
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
    const { service, repository } = serviceWith();
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
});
import { Readable } from 'node:stream';
