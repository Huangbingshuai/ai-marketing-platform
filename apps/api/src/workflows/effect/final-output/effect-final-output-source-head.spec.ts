import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FinalOutputSnapshot } from '@ai-marketing/contracts';
import type { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import type { EffectTemplateMixService } from '../template-mix/effect-template-mix.service';
import { EffectFinalOutputService } from './effect-final-output.service';

afterEach(() => vi.restoreAllMocks());

function fixture(file = 'latest-video', owner = true) {
  const variant = { id: 'v', bindings: { end: 'copy' }, bindingRevisions: { end: 1 } };
  const source = {
    id: 'copy',
    revision: 1,
    freshness: 'CURRENT',
    availability: 'AVAILABLE',
    payload: { promptId: 'prompt', fileObjectId: 'old-video', contentHash: 'video-hash' },
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    workflowNodeState: {
      findUnique: vi.fn().mockResolvedValue({
        state: { templates: [{ id: 't', workspace: { variants: [variant] } }] },
      }),
      update: vi.fn(),
    },
    workingArtifact: { findMany: vi.fn().mockResolvedValue([source]) },
    effectPackagingItem: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const heads = vi.spyOn(WorkflowWorkingRepository.prototype, 'listArtifacts').mockResolvedValue([
    {
      ...source,
      id: 'head',
      revision: 2,
      metadata: { branchSourceOwner: owner },
      payload: { ...source.payload, fileObjectId: file },
    } as never,
  ]);
  const service = new EffectFinalOutputService(
    tx as unknown as PrismaService,
    {} as EffectTemplateMixService,
    {} as WorkflowWorkingRepository,
    {} as StoragePort,
    {} as WorkflowWorkingService,
  ) as unknown as {
    assertRefreshCurrent(
      tx: unknown,
      project: string,
      snapshot: FinalOutputSnapshot,
    ): Promise<void>;
    commitSourceRefresh(tx: unknown, project: string, snapshot: FinalOutputSnapshot): Promise<void>;
  };
  const snapshot = {
    sourceRefresh: { ready: true, workflowRunId: 'mix', templateId: 't', baselineVariant: variant },
    timeline: {
      variant,
      clips: [{ slotId: 'end', fileObjectId: 'old-video', contentHash: 'video-hash' }],
      dependencies: [],
    },
  } as unknown as FinalOutputSnapshot;
  return { tx, heads, service, snapshot };
}

describe('local source refresh authoritative heads', () => {
  it('rejects an old CURRENT fork copy before further refresh work', async () => {
    const { tx, heads, service, snapshot } = fixture();
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).rejects.toThrow(
      '不能回退到旧素材',
    );
    expect(heads).toHaveBeenCalledWith('p', { workflowRunId: 'mix', nodeId: 'SEGMENT_RENDER' });
  });
  it('rejects that copy before writing the draft or confirmed result', async () => {
    const { tx, service, snapshot } = fixture();
    await expect(service.commitSourceRefresh(tx, 'p', snapshot)).rejects.toThrow(
      '不能回退到旧素材',
    );
    expect(tx.workflowNodeState.update).not.toHaveBeenCalled();
  });
  it('allows copied IDs for the same physical media', async () => {
    const { tx, service, snapshot } = fixture('old-video');
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).resolves.toBeUndefined();
  });
  it('does not mistake a historical non-owner copy for the current source head', async () => {
    const { tx, service, snapshot } = fixture('different-history-video', false);
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).resolves.toBeUndefined();
  });
});

describe('local source refresh adopted packaging fence', () => {
  function packagedFixture() {
    const context = fixture('old-video');
    const checkpoint = { voices: {}, captions: [], music: { fileObjectId: 'music', volume: 0.4 } };
    Object.assign(context.snapshot.sourceRefresh!, {
      packagingItemId: 'saved',
      baselinePackaging: checkpoint,
    });
    const saved = {
      id: 'saved',
      variantId: 'v',
      status: 'COMPLETED',
      snapshot: {},
      checkpoint: structuredClone(checkpoint),
    };
    return { ...context, saved };
  }

  it.each(['FAILED', 'CANCELLED', 'QUEUED', 'RUNNING'])(
    'does not mistake an uncommitted %s attempt for a changed package',
    async (status) => {
      const { tx, service, snapshot, saved } = packagedFixture();
      tx.effectPackagingItem.findMany.mockResolvedValue([
        {
          ...saved,
          id: 'attempt',
          status,
          snapshot: { operation: 'BATCH_PACKAGE' },
          checkpoint: {},
        },
        saved,
      ] as never);
      await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).resolves.toBeUndefined();
      expect(tx.effectPackagingItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            projectId: 'p',
            variantId: 'v',
            run: { workflowRunId: 'mix', templateId: { in: ['t'] } },
          },
        }),
      );
    },
  );

  it('ignores supplier-only metadata but still rejects a real saved audio edit', async () => {
    const { tx, service, snapshot, saved } = packagedFixture();
    Object.assign(saved.checkpoint, {
      musicTaskId: 'supplier-task',
      musicSubmissionPending: false,
    });
    tx.effectPackagingItem.findMany.mockResolvedValue([saved] as never);
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).resolves.toBeUndefined();
    saved.checkpoint.music.volume = 0.7;
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).rejects.toThrow('包装已被修改');
  });

  it('rejects a newer successful commit even with identical content', async () => {
    const { tx, service, snapshot, saved } = packagedFixture();
    tx.effectPackagingItem.findMany.mockResolvedValue([
      { ...saved, id: 'new-commit' },
      saved,
    ] as never);
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).rejects.toThrow('包装已被修改');
  });

  it('keeps the legacy unfinished-package barrier instead of silently reviving old content', async () => {
    const { tx, service, snapshot, saved } = packagedFixture();
    tx.effectPackagingItem.findMany.mockResolvedValue([
      { ...saved, id: 'legacy', status: 'FAILED' },
      saved,
    ] as never);
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).rejects.toThrow('包装已被修改');
    delete snapshot.sourceRefresh!.packagingItemId;
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).rejects.toThrow('包装已被修改');
  });

  it('allows an unpackaged baseline with only an uncommitted attempt, but rejects its later success', async () => {
    const { tx, service, snapshot, saved } = packagedFixture();
    delete snapshot.sourceRefresh!.packagingItemId;
    const attempt = { ...saved, snapshot: { operation: 'SINGLE_PACKAGE' }, status: 'FAILED' };
    tx.effectPackagingItem.findMany.mockResolvedValue([attempt] as never);
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).resolves.toBeUndefined();
    attempt.status = 'COMPLETED';
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).rejects.toThrow('包装已被修改');
  });
});
