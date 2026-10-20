import { describe, expect, it, vi } from 'vitest';
import type { ProductionStep } from '@ai-marketing/contracts';
import type { PrismaService } from '../../../database/prisma.service';
import type { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { ProductionRepository } from './production.repository';
import { beginPromptMechanicalRecovery } from './prompt-mechanical-recovery';

const steps: ProductionStep[] = [{ id: 'REVIEW', status: 'FAILED', title: '审校', content: '' }];
const failed = () => ({
  value: { content: '受控提示词，不能丢失' },
  audit: { findings: [{ id: 'A1', severity: 'ERROR' }] },
  auditCorrected: { findings: [{ id: 'A1', severity: 'ERROR', evidence: ['corrected-field'] }] },
  corrections: { audit: 1, revised: 1 },
  mechanicalErrors: { audit: 'invalid field', auditCorrected: 'invalid quotation' },
  mechanicalIssueSets: {
    audit: ['invalid field', 'invalid quotation'],
    auditCorrected: ['invalid quotation'],
  },
  failureReason: 'INVALID_CANDIDATE',
  providerTaskId: 'existing-provider-sentinel',
});

function harness(operation = 'PROMPT', status = 'FAILED') {
  const row = {
    id: 'task',
    projectId: 'project',
    workflowRunId: 'run',
    operation,
    status,
    steps: structuredClone(steps),
    output: failed(),
    inputSnapshot: { document: { assets: [], shots: [] } },
    attemptToken: 'old-token',
    leaseExpiresAt: new Date(Date.now() + 60000),
    attemptCount: 2,
  };
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
    Object.assign(row, data),
  );
  const tx = {
    $queryRaw: vi.fn(),
    customizedProductionTask: {
      findFirst: vi.fn(async () => row),
      update,
      count: vi.fn(async () => 0),
    },
  };
  const db = { $transaction: (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) };
  const repo = new ProductionRepository(
    db as unknown as PrismaService,
    {} as WorkflowWorkingRepository,
  );
  const target = repo as unknown as {
    scope(...args: unknown[]): Promise<unknown>;
    valid(...args: unknown[]): Promise<void>;
    enqueue(...args: unknown[]): Promise<void>;
  };
  vi.spyOn(target, 'scope').mockResolvedValue({});
  const valid = vi.spyOn(target, 'valid').mockResolvedValue();
  const enqueue = vi.spyOn(target, 'enqueue').mockResolvedValue();
  return { repo, row, update, valid, enqueue, tx };
}

describe('explicit mechanical Prompt recovery', () => {
  it('archives each failed phase and grants exactly one new phase correction without changing the input', () => {
    const output = failed(),
      original = structuredClone(output);
    const first = beginPromptMechanicalRecovery('PROMPT', 'FAILED', steps, output)!;
    expect(output).toEqual(original);
    expect(first.value).toEqual(output.value);
    expect(first.providerTaskId).toBe(output.providerTaskId);
    expect(first.audit).toEqual(output.auditCorrected);
    expect(first.auditCorrected).toBeUndefined();
    expect(first.corrections).toEqual({ audit: 0, revised: 1 });
    const metadata = first.mechanicalRecovery as { epoch: number; history: unknown[] };
    expect(metadata.epoch).toBe(1);
    expect(metadata.history[0]).toMatchObject({
      candidate: output.audit,
      correctedCandidate: output.auditCorrected,
      correctionCount: 1,
    });
    const nextFailure = {
      ...first,
      auditCorrected: { findings: [{ id: 'A1', severity: 'ERROR' }] },
      corrections: { audit: 1, revised: 1 },
      failureReason: 'INVALID_CANDIDATE',
      mechanicalErrors: { auditCorrected: 'still invalid' },
    };
    const second = beginPromptMechanicalRecovery('PROMPT', 'FAILED', steps, nextFailure)!;
    expect(second.mechanicalRecovery).toMatchObject({ epoch: 2, phase: 'audit' });
    expect((second.mechanicalRecovery as { history: unknown[] }).history).toHaveLength(2);
    expect((second.mechanicalRecovery as { history: unknown[] }).history[0]).toEqual(
      metadata.history[0],
    );
  });

  it.each(['RENDER', 'IMAGE', 'SHOTS'])(
    'never rewrites %s provider or successful checkpoints',
    (operation) => {
      const output = failed();
      expect(beginPromptMechanicalRecovery(operation, 'FAILED', steps, output)).toBeNull();
    },
  );
  it('ordinary RENDER retry retains the provider identity and entire saved output', async () => {
    const h = harness('RENDER');
    const before = structuredClone(h.row.output);
    await h.repo.action('project', 'task', false);
    expect(h.row.output).toEqual(before);
    expect(h.update.mock.calls[0]![0].data).not.toHaveProperty('output');
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
  it('does not reset normal cached successes or business failures and rejects oversized archives', () => {
    expect(beginPromptMechanicalRecovery('PROMPT', 'COMPLETED', steps, failed())).toBeNull();
    expect(
      beginPromptMechanicalRecovery('PROMPT', 'FAILED', steps, {
        ...failed(),
        failureReason: 'REVIEW_UNRESOLVED',
      }),
    ).toBeNull();
    expect(
      beginPromptMechanicalRecovery('PROMPT', 'FAILED', steps, {
        ...failed(),
        auditCorrected: undefined,
      }),
    ).toBeNull();
    expect(() =>
      beginPromptMechanicalRecovery('PROMPT', 'FAILED', steps, {
        ...failed(),
        value: { content: 'x'.repeat(2_000_000) },
      }),
    ).toThrow('大小限制');
  });

  it('uses same-task retry once; repeated requests are idempotent and old callbacks cannot overwrite the recovery', async () => {
    const h = harness();
    const input = structuredClone(h.row.inputSnapshot);
    await h.repo.action('project', 'task', false);
    await h.repo.action('project', 'task', false);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.row.inputSnapshot).toEqual(input);
    expect(h.row.attemptToken).toBeNull();
    expect(h.row.output).toHaveProperty('mechanicalRecovery.epoch', 1);
    await expect(
      h.repo.checkpoint('project', 'task', 'old-token', steps[0]!, failed(), 'VIDEO'),
    ).rejects.toThrow('租约失效');
    expect(h.update).toHaveBeenCalledTimes(1);
    h.row.status = 'RUNNING';
    h.row.attemptToken = 'new-token';
    h.row.leaseExpiresAt = new Date(Date.now() + 60000);
    await expect(
      h.repo.checkpoint('project', 'task', 'old-token', steps[0]!, failed(), 'VIDEO'),
    ).rejects.toThrow('租约失效');
    await expect(
      h.repo.checkpoint('project', 'task', 'new-token', steps[0]!, failed(), 'VIDEO'),
    ).rejects.toThrow('恢复轮次不匹配');
  });

  it('keeps every record unchanged when source/draft or activity validation fails', async () => {
    for (const block of ['source', 'active']) {
      const h = harness();
      const before = structuredClone(h.row);
      if (block === 'source') h.valid.mockRejectedValue(new Error('source or draft changed'));
      else h.tx.customizedProductionTask.count.mockResolvedValue(1);
      await expect(h.repo.action('project', 'task', false)).rejects.toThrow();
      expect(h.row).toEqual(before);
      expect(h.update).not.toHaveBeenCalled();
      expect(h.enqueue).not.toHaveBeenCalled();
    }
  });
});
