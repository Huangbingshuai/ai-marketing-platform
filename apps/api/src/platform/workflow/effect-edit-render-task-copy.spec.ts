import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/client';
import { insertEffectRenderBranchTasks } from './effect-edit-session';

const originalArtifact = '11111111-1111-4111-8111-111111111111';
const clonedArtifact = '22222222-2222-4222-8222-222222222222';
const originalHash = 'a'.repeat(64);
const clonedHash = 'b'.repeat(64);
const rows = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `task-${index}`, projectId: 'project', workflowRunId: 'child', productId: 'cloned-product',
  batchId: 'cloned-batch', promptId: `prompt-${index}`, renderCode: `R-${index}`,
  status: index % 2 ? 'COMPLETED' : 'FAILED', progress: index % 2 ? 100 : 0,
  renderVersion: 4, activeOutputVersion: 3, attemptCount: 2, retryCount: 1,
  outputFileObjectId: 'unchanged-file', outputContentHash: 'media-fingerprint',
  providerTaskId: 'historical-provider-task', repairStatus: 'READY',
  repairCandidateFileObjectId: 'unchanged-candidate',
  requestSnapshot: { artifactId: originalArtifact, contentHash: originalHash,
    productId: 'cloned-product', options: { duration: 15 } },
  generationRequestSnapshot: { dependency: originalArtifact, sourceHash: originalHash },
}) as unknown as Prisma.EffectSegmentRenderTaskCreateManyInput);

describe('batched render task copies inside an isolated branch transaction', () => {
  it('writes every final frozen snapshot once while preserving versions, files and task state', async () => {
    const input = rows(37);
    const before = structuredClone(input);
    const createMany = vi.fn().mockResolvedValue({ count: 37 });
    await insertEffectRenderBranchTasks({ effectSegmentRenderTask: { createMany } } as never,
      input, { [originalArtifact]: clonedArtifact, [originalHash]: clonedHash });
    expect(createMany).toHaveBeenCalledOnce();
    expect(createMany.mock.calls[0]![0].data).toEqual(input.map((row) => ({
      ...row,
      requestSnapshot: { artifactId: clonedArtifact, contentHash: clonedHash,
        productId: 'cloned-product', options: { duration: 15 } },
      generationRequestSnapshot: { dependency: clonedArtifact, sourceHash: clonedHash },
    })));
    expect(input).toEqual(before);
  });
  it('does not create tasks when the branch policy starts with an empty render pool', async () => {
    const createMany = vi.fn();
    await insertEffectRenderBranchTasks({ effectSegmentRenderTask: { createMany } } as never, [], {});
    expect(createMany).not.toHaveBeenCalled();
  });
  it('propagates an insert failure so the caller transaction cannot publish a partial branch', async () => {
    const createMany = vi.fn().mockRejectedValue(new Error('transaction failed'));
    await expect(insertEffectRenderBranchTasks({ effectSegmentRenderTask: { createMany } } as never,
      rows(2), {})).rejects.toThrow('transaction failed');
    expect(createMany).toHaveBeenCalledOnce();
  });
});
