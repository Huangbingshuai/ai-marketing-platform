import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixAiSnapshot,
} from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { EffectTemplateMixService } from './effect-template-mix.service';

const roles = ['HOOK', 'PAIN_POINT', 'PRODUCT', 'SELLING_POINT', 'TRANSFORMATION', 'END'] as const;
function fixture(limit = 100, shortMaterial = false) {
  const assigned = [...roles, 'PRODUCT', 'PRODUCT', 'PRODUCT'] as const;
  const rows: EffectTemplateMixAiClassification[] = assigned.map((role, index) => ({
    materialId: `m${index}`,
    scores: Object.fromEntries(
      roles.map((candidate) => [candidate, Number(candidate === role)]),
    ) as EffectTemplateMixAiClassification['scores'],
    reasons: {},
  }));
  const snapshot = {
    requireAllMaterials: true,
    template: {
      slots: roles.map((role, index) => ({ id: `s${index}`, role, label: role, duration: 4 })),
    },
    materials: rows.map((row, index) => ({
      id: row.materialId,
      code: `R-${index}`,
      duration: shortMaterial && index === 8 ? 3 : 4,
    })),
    targetVariantId: null,
    lockedBindings: [],
    existingVariantBindings: [],
    maxOutputVariants: limit,
  } as unknown as EffectTemplateMixAiSnapshot;
  const repo = {
    find: vi
      .fn()
      .mockResolvedValue({ status: 'RUNNING', attemptToken: 'token', inputSnapshot: snapshot }),
    saveSelection: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const service = new EffectTemplateMixService(
    {} as WorkflowWorkingService,
    repo as unknown as EffectTemplateMixAiRepository,
  );
  return { service, repo, rows, snapshot };
}

describe('full-batch material coverage boundary', () => {
  it('saves one trim per material, not one paid trim per output combination', async () => {
    const { service, repo, rows } = fixture();
    const result = await service.classifyAiRun('p', 'r', 'token', rows);
    expect(result.selections).toHaveLength(9);
    expect(new Set(result.selections.map((row) => row.materialId)).size).toBe(9);
    expect(repo.saveSelection).toHaveBeenCalledOnce();
  });
  it('reports capacity-limited omissions instead of claiming partial coverage succeeded', async () => {
    const { service, repo, rows } = fixture(2);
    await expect(service.classifyAiRun('p', 'r', 'token', rows)).rejects.toThrow(
      '未能覆盖全部素材',
    );
    expect(repo.saveSelection).not.toHaveBeenCalled();
  });
  it('identifies a too-short clip rather than silently dropping it', async () => {
    const { service, repo, rows } = fixture(100, true);
    await expect(service.classifyAiRun('p', 'r', 'token', rows)).rejects.toThrow('R-8');
    expect(repo.saveSelection).not.toHaveBeenCalled();
  });
  it('reads old snapshots without imposing a new coverage requirement on recovery', async () => {
    const { service, rows, snapshot } = fixture(2);
    delete snapshot.requireAllMaterials;
    const result = await service.classifyAiRun('p', 'r', 'token', rows);
    expect(result.selections).toHaveLength(7);
  });
});
