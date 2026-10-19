import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../../../packages/contracts/fixtures/customized-asset-image-ownership.json';
import type { ProductionAsset } from '@ai-marketing/contracts';
import type { PrismaService } from '../../../database/prisma.service';
import type { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ProductionRepository } from './production.repository';

function harness(assets = structuredClone(fixture.assets) as ProductionAsset[]) {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    id: 'task',
    status: 'QUEUED',
    output: null,
  }));
  const enqueue = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    customizedProductionTask: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create,
    },
    jobOutbox: { create: vi.fn() },
    assetVersion: { findFirst: vi.fn() },
  };
  const db = { $transaction: (fn: (v: typeof tx) => Promise<unknown>) => fn(tx) };
  const repo = new ProductionRepository(
    db as unknown as PrismaService,
    {} as WorkflowWorkingRepository,
  );
  const target = repo as unknown as {
    read: (...args: unknown[]) => Promise<unknown>;
    artifacts: (...args: unknown[]) => Promise<unknown>;
    enqueue: (...args: unknown[]) => Promise<unknown>;
  };
  vi.spyOn(target, 'read').mockImplementation(async (_tx, p, r) => {
    if (p !== 'project' || r !== 'run') throw new Error('invalid scope');
    return {
      draftRevision: 1,
      sourceReady: true,
      source: { artifactId: 'script' },
      script: { name: '受控故事' },
      document: { assets, shots: [] },
    };
  });
  vi.spyOn(target, 'artifacts').mockResolvedValue([
    { id: 'script', artifactKey: 'customized-script:script', revision: 1, contentHash: 'script' },
    {
      id: 'catalog',
      artifactKey: 'customized-asset-catalog',
      freshness: 'CURRENT',
      payload: { assets },
      revision: 1,
      contentHash: workflowStateHash({ assets }),
    },
    {
      id: 'brief',
      artifactKey: 'customized-brief',
      freshness: 'CURRENT',
      revision: 1,
      contentHash: 'brief',
      payload: { productName: '受控产品' },
    },
  ]);
  vi.spyOn(target, 'enqueue').mockImplementation(enqueue);
  const start = (assetIds: string[], p = 'project', r = 'run') =>
    repo.start(p, r, 1, 'IMAGE', 'key', null, { creative: 'test', detail: 'test' }, null, {
      model: 'doubao-seedream-5-0-pro-260628',
      resolution: '2K',
      ratio: '1:1',
      assetIds,
    });
  return { create, enqueue, tx, start };
}
describe('IMAGE task ownership gate before paid work', () => {
  it.each([{ ids: ['detail-a'] }, { ids: fixture.assets.map((a) => a.id) }])(
    'rejects explicit detail or mixed selections as a whole without task/outbox creation',
    async ({ ids }) => {
      const h = harness();
      await expect(h.start(ids)).rejects.toThrow('无需独立制图');
      expect(h.create).not.toHaveBeenCalled();
      expect(h.enqueue).not.toHaveBeenCalled();
      expect(h.tx.jobOutbox.create).not.toHaveBeenCalled();
      expect(h.tx.assetVersion.findFirst).not.toHaveBeenCalled();
    },
  );
  it('allows ten explicit independent objects in one frozen task', async () => {
    const h = harness();
    const task = await h.start(fixture.eligibleIds);
    expect(task.imageSettings?.assetIds).toEqual(fixture.eligibleIds);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['other-project', 'run'],
    ['project', 'other-run'],
  ])('rejects a foreign scope before creating tasks', async (p, r) => {
    const h = harness();
    await expect(h.start(fixture.eligibleIds, p, r)).rejects.toThrow('scope');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
