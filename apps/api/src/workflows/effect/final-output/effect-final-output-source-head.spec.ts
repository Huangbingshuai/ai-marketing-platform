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
  const source = { id: 'copy', revision: 1, freshness: 'CURRENT', availability: 'AVAILABLE',
    payload: { promptId: 'prompt', fileObjectId: 'old-video', contentHash: 'video-hash' } };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    workflowNodeState: {
      findUnique: vi.fn().mockResolvedValue({ state: { templates: [
        { id: 't', workspace: { variants: [variant] } },
      ] } }),
      update: vi.fn(),
    },
    workingArtifact: { findMany: vi.fn().mockResolvedValue([source]) },
    effectPackagingItem: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const heads = vi.spyOn(WorkflowWorkingRepository.prototype, 'listArtifacts').mockResolvedValue([
    { ...source, id: 'head', revision: 2, metadata: { branchSourceOwner: owner },
      payload: { ...source.payload, fileObjectId: file } } as never,
  ]);
  const service = new EffectFinalOutputService(tx as unknown as PrismaService,
    {} as EffectTemplateMixService, {} as WorkflowWorkingRepository, {} as StoragePort,
    {} as WorkflowWorkingService) as unknown as {
      assertRefreshCurrent(tx: unknown, project: string, snapshot: FinalOutputSnapshot): Promise<void>;
      commitSourceRefresh(tx: unknown, project: string, snapshot: FinalOutputSnapshot): Promise<void>;
    };
  const snapshot = {
    sourceRefresh: { ready: true, workflowRunId: 'mix', templateId: 't', baselineVariant: variant },
    timeline: { variant, clips: [{ slotId: 'end', fileObjectId: 'old-video', contentHash: 'video-hash' }],
      dependencies: [] },
  } as unknown as FinalOutputSnapshot;
  return { tx, heads, service, snapshot };
}

describe('local source refresh authoritative heads', () => {
  it('rejects an old CURRENT fork copy before further refresh work', async () => {
    const { tx, heads, service, snapshot } = fixture();
    await expect(service.assertRefreshCurrent(tx, 'p', snapshot)).rejects.toThrow('不能回退到旧素材');
    expect(heads).toHaveBeenCalledWith('p', { workflowRunId: 'mix', nodeId: 'SEGMENT_RENDER' });
  });
  it('rejects that copy before writing the draft or confirmed result', async () => {
    const { tx, service, snapshot } = fixture();
    await expect(service.commitSourceRefresh(tx, 'p', snapshot)).rejects.toThrow('不能回退到旧素材');
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
