import { describe, expect, it } from 'vitest';
import type {
  EffectTemplateMixAiSnapshot,
  EffectTemplateMixAiClassification,
  EffectTemplateMixRole,
} from '@ai-marketing/contracts';
import {
  incrementalVariantId,
  pendingAddedMaterials,
  validateIncrementalPlan,
} from './effect-template-mix-incremental';

const roles: EffectTemplateMixRole[] = [
  'HOOK',
  'PAIN_POINT',
  'PRODUCT',
  'SELLING_POINT',
  'TRANSFORMATION',
  'END',
];
function fixture() {
  const slots = roles.map((role, i) => ({ id: `s${i}`, role, duration: 4 }));
  const materials = roles.map((_, i) => ({ id: `m${i}`, promptId: `p${i}`, duration: 10 }));
  materials.push({ id: 'new', promptId: 'new-prompt', duration: 10 });
  const snapshot = {
    template: { slots },
    materials,
    maxOutputVariants: 3,
    incremental: { materialIds: ['new'], oldVariantIds: ['old'], packageNewVariants: true },
    existingVariantBindings: [slots.map((slot, i) => ({ slotId: slot.id, materialId: `m${i}` }))],
    materialRoleAssignments: Object.fromEntries([
      ...materials.map((m, i) => [m.id, roles[i] ?? 'HOOK']),
    ]),
  } as unknown as EffectTemplateMixAiSnapshot;
  const rows: EffectTemplateMixAiClassification[] = materials.map((m, i) => ({
    materialId: m.id,
    scores: Object.fromEntries(
      roles.map((role) => [role, Number(role === (roles[i] ?? 'HOOK'))]),
    ) as Record<EffectTemplateMixRole, number>,
    reasons: {},
  }));
  const plan = {
    variants: [
      {
        difference: '从新画面的产品开启动作展开',
        bindings: slots.map((slot, i) => ({
          slotId: slot.id,
          materialId: i === 0 ? 'new' : `m${i}`,
        })),
      },
    ],
    omitted: [],
  };
  return { snapshot, rows, plan };
}

describe('same-branch incremental material provenance', () => {
  const pool = [
    { id: 'replacement', sourcePromptId: 'old-prompt', available: true },
    { id: 'new', sourcePromptId: 'new-prompt', available: true },
    { id: 'inactive', sourcePromptId: 'retired', available: true, activeSource: false },
  ];
  const baseline = {
    templateId: 't',
    status: 'COMPLETED',
    inputSnapshot: { materials: [{ id: 'old', promptId: 'old-prompt' }] },
  };
  it('distinguishes a replacement from an addition and isolates template history', () => {
    expect(pendingAddedMaterials('t', pool, [baseline])).toEqual(['new']);
    expect(pendingAddedMaterials('another', pool, [baseline])).toEqual([]);
    expect(pendingAddedMaterials('t', pool, [{ ...baseline, status: 'FAILED' }])).toEqual([]);
  });
  it('does not consume omitted additions just because an append run completed', () => {
    const append = {
      templateId: 't',
      status: 'COMPLETED',
      inputSnapshot: {
        materials: [{ id: 'new', promptId: 'new-prompt' }],
        incremental: { materialIds: ['new'] },
      },
      selectionResult: [],
    };
    expect(pendingAddedMaterials('t', pool, [baseline, append])).toEqual(['new']);
    expect(
      pendingAddedMaterials('t', pool, [
        baseline,
        { ...append, selectionResult: [{ materialId: 'new' }] },
      ]),
    ).toEqual([]);
  });
});

describe('incremental plans have no combinatorial fallback', () => {
  it('allows old material reuse but records separate selections per new film', () => {
    const { snapshot, rows, plan } = fixture();
    expect(validateIncrementalPlan(snapshot, rows, plan)).toHaveLength(6);
    expect(incrementalVariantId('run', 0)).toBe('run');
    expect(incrementalVariantId('run', 1)).toBe(incrementalVariantId('run', 1));
    expect(incrementalVariantId('run', 1)).not.toBe(incrementalVariantId('other', 1));
  });
  it('rejects old-only plans, duplicate combinations, duplicate clips and wrong-role bindings', () => {
    const { snapshot, rows, plan } = fixture();
    expect(() =>
      validateIncrementalPlan(snapshot, rows, {
        ...plan,
        variants: [plan.variants[0]!, plan.variants[0]!],
      }),
    ).toThrow('完全重复');
    const oldOnly = structuredClone(plan);
    oldOnly.variants[0]!.bindings[0]!.materialId = 'm0';
    expect(() => validateIncrementalPlan(snapshot, rows, oldOnly)).toThrow('新增素材');
    const duplicate = structuredClone(plan);
    duplicate.variants[0]!.bindings[1]!.materialId = 'new';
    expect(() => validateIncrementalPlan(snapshot, rows, duplicate)).toThrow('素材不重复');
    const wrongRole = structuredClone(plan);
    [
      wrongRole.variants[0]!.bindings[1]!.materialId,
      wrongRole.variants[0]!.bindings[2]!.materialId,
    ] = ['m2', 'm1'];
    expect(() => validateIncrementalPlan(snapshot, rows, wrongRole)).toThrow('归槽');
  });
  it('requires AI reasons for every unused addition and validates duration/capacity', () => {
    const { snapshot, rows, plan } = fixture();
    snapshot.incremental!.materialIds.push('unused');
    expect(() => validateIncrementalPlan(snapshot, rows, plan)).toThrow('模型说明');
    const withReason = { ...plan, omitted: [{ materialId: 'unused', reason: '当前槽位时长不足' }] };
    expect(validateIncrementalPlan(snapshot, rows, withReason)[0]!.omittedNewMaterials).toEqual(
      withReason.omitted,
    );
    snapshot.materials.find((item) => item.id === 'new')!.duration = 1;
    expect(() => validateIncrementalPlan(snapshot, rows, withReason)).toThrow('时长');
    snapshot.maxOutputVariants = 0;
    expect(() => validateIncrementalPlan(snapshot, rows, withReason)).toThrow('数量');
  });
});
