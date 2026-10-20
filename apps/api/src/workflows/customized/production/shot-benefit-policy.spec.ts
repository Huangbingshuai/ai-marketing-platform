import { describe, expect, it, vi } from 'vitest';
import type { ProductionInput } from '@ai-marketing/contracts';
import type { PrismaService } from '../../../database/prisma.service';
import type { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ProductionRepository } from './production.repository';

function harness(previous: Record<string, unknown> | null = null) {
  const document = { assets: [], shots: [] };
  const source = { id: 'script', revision: 1, contentHash: 'script' };
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    id: 'created',
    status: 'QUEUED',
    output: null,
  }));
  const tx = {
    $queryRaw: vi.fn(),
    customizedProductionTask: {
      findUnique: vi.fn().mockResolvedValue(previous),
      findFirst: vi.fn().mockResolvedValue(null),
      create,
    },
  };
  const db = { $transaction: (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) };
  const repo = new ProductionRepository(
    db as unknown as PrismaService,
    {} as WorkflowWorkingRepository,
  );
  const target = repo as unknown as {
    read: (...args: unknown[]) => Promise<unknown>;
    artifacts: (...args: unknown[]) => Promise<unknown>;
    enqueue: (...args: unknown[]) => Promise<unknown>;
  };
  vi.spyOn(target, 'read').mockResolvedValue({
    draftRevision: 1,
    sourceReady: true,
    source: { artifactId: 'script' },
    script: { name: '受控故事', synopsis: '人物拿杯出门。' },
    document,
  });
  vi.spyOn(target, 'artifacts').mockResolvedValue([
    source,
    {
      id: 'catalog',
      artifactKey: 'customized-asset-catalog',
      freshness: 'CURRENT',
      payload: { assets: [] },
      contentHash: workflowStateHash({ assets: [] }),
      revision: 1,
    },
    {
      id: 'brief',
      artifactKey: 'customized-brief',
      freshness: 'CURRENT',
      payload: { productName: '受控产品' },
      contentHash: 'brief',
      revision: 1,
    },
  ]);
  const enqueue = vi.spyOn(target, 'enqueue').mockResolvedValue({});
  const start = () =>
    repo.start(
      'project',
      'run',
      1,
      'SHOTS',
      'same-key',
      null,
      { creative: 'controlled', detail: 'controlled' },
      null,
      undefined,
      { version: 2 },
    );
  return { start, create, enqueue };
}

describe('new SHOTS benefit policy snapshot', () => {
  it('freezes the additional policy in a new task without changing the existing shot strategy', async () => {
    const h = harness();
    await h.start();
    expect(h.create).toHaveBeenCalledTimes(1);
    const input = h.create.mock.calls[0]![0].data.inputSnapshot as ProductionInput;
    expect(input).toMatchObject({
      operation: 'SHOTS',
      shotWorkflowVersion: 2,
      strategyVersion: '2026-10-19-capacity-clips.7',
      shotBenefitPolicyVersion: 1,
      shotDurationStepMs: 1000,
    });
    expect(input.promptWorkflowVersion).toBeUndefined();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
  it('returns an idempotent historical task without backfilling the policy or creating another task', async () => {
    const previous = {
      id: 'historical',
      workflowRunId: 'run',
      operation: 'SHOTS',
      shotId: null,
      status: 'QUEUED',
      steps: [],
      output: null,
      inputSnapshot: {
        operation: 'SHOTS',
        document: { assets: [], shots: [] },
        strategyVersion: '2026-10-19-capacity-clips.7',
      },
    };
    const frozen = structuredClone(previous);
    const h = harness(previous);
    expect((await h.start()).id).toBe('historical');
    expect(previous).toEqual(frozen);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
