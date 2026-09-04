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

const serviceWith = (overrides: Record<string, unknown> = {}) => {
  const artifact = promptArtifact();
  const repository = {
    workflowRun: vi.fn().mockResolvedValue({ id: 'run-a' }),
    product: vi.fn().mockResolvedValue({ id: 'product-a', name: '测试产品' }),
    promptArtifact: vi.fn().mockResolvedValue(artifact),
    renderArtifact: vi.fn().mockResolvedValue(null),
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
    ...overrides,
  };
  const service = new EffectSegmentRenderService(
    repository as never,
    { get: vi.fn().mockResolvedValue({ id: 'project-a', name: '项目 A' }) } as never,
    { get: vi.fn().mockReturnValue('seedance-model') } as never,
    {} as never,
    {
      findNodeState: vi.fn().mockResolvedValue(null),
      saveNodeState: vi.fn(),
    } as never,
  );
  return { service, repository };
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
    });
    expect(
      input.tasks[0].requestSnapshot.request.content[0].text.match(/保持产品外观一致/gu),
    ).toHaveLength(1);
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
});
