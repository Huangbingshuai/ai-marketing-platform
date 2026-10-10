import { describe, expect, it } from 'vitest';
import type {
  EffectTemplateMixAiSnapshot,
  EffectTemplateMixAiClassification,
  EffectTemplateMixRole,
} from '@ai-marketing/contracts';
import {
  incrementalVariantId,
  adaptiveIncrementalSelections,
  pendingAddedMaterials,
  validateIncrementalPlan,
  validatePartialAppendSelections,
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
  it('collects two unprocessed addition batches together and acknowledges only successful consumption', () => {
    const added = ['batch-1-a', 'batch-1-b', 'batch-2-a', 'batch-2-b'].map((id) => ({
      id,
      sourcePromptId: id,
      available: true,
    }));
    const materials = [pool[0]!, ...added];
    const inputSnapshot = {
      materials: added.map(({ id }) => ({ id, promptId: id })),
      incremental: { materialIds: added.map(({ id }) => id) },
    };
    const completed = {
      templateId: 't',
      status: 'COMPLETED',
      inputSnapshot,
      selectionResult: added.map(({ id }) => ({ materialId: id })),
    };
    expect(pendingAddedMaterials('t', materials, [baseline])).toEqual(added.map(({ id }) => id));
    expect(
      pendingAddedMaterials('t', materials, [baseline, { ...completed, status: 'RUNNING' }]),
    ).toEqual(added.map(({ id }) => id));
    expect(pendingAddedMaterials('t', materials, [completed, baseline])).toEqual([]);
    const next = { id: 'batch-3', sourcePromptId: 'batch-3', available: true };
    expect(pendingAddedMaterials('t', [...materials, next], [completed, baseline])).toEqual([
      'batch-3',
    ]);
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
  it('does not acknowledge new materials present only in a source-replacement trim snapshot', () => {
    const trim = {
      templateId: 't',
      status: 'COMPLETED',
      inputSnapshot: {
        trimOnly: true,
        materials: [
          { id: 'replacement', promptId: 'old-prompt' },
          { id: 'new', promptId: 'new-prompt' },
        ],
      },
      selectionResult: [{ materialId: 'replacement' }],
    };
    expect(pendingAddedMaterials('t', pool, [trim, baseline])).toEqual(['new']);
  });
  it('only flags additions that fit at least one slot, including equality', () => {
    const timed = pool.map((item) => ({ ...item, duration: 4 }));
    expect(
      pendingAddedMaterials('t', timed, [baseline], [{ duration: 5 }, { duration: 8 }]),
    ).toEqual([]);
    expect(
      pendingAddedMaterials('t', timed, [baseline], [{ duration: 4 }, { duration: 8 }]),
    ).toEqual(['new']);
  });
});

describe('adaptive incremental combination reuse', () => {
  it.each([[0], [2], [5], [1, 3, 5]])(
    'allows only genuine empty pools in new append: %j',
    (...missing) => {
      const { snapshot, rows } = fixture();
      const missingIndexes = missing as number[];
      snapshot.incremental!.emptySlotPolicy = 'ALLOW_EMPTY_POOLS';
      if (missingIndexes.includes(0)) {
        snapshot.materialRoleAssignments!.new = 'PRODUCT';
        rows.find((row) => row.materialId === 'new')!.scores.PRODUCT = 1;
      }
      const removed = new Set(missingIndexes.map((index) => `m${index}`));
      snapshot.materials = snapshot.materials.filter((m) => !removed.has(m.id));
      const remainingRows = rows.filter((row) => !removed.has(row.materialId));
      const selections = adaptiveIncrementalSelections(snapshot, remainingRows);
      expect(selections).toHaveLength(6 - missingIndexes.length);
      expect(selections[0]!.intentionallyEmptySlotIds).toEqual(
        missingIndexes.map((index) => `s${index}`),
      );
      expect(selections.some((item) => item.materialId === 'new')).toBe(true);
      expect(() =>
        validatePartialAppendSelections(snapshot, remainingRows, selections),
      ).not.toThrow();
      delete snapshot.incremental!.emptySlotPolicy;
      expect(() => adaptiveIncrementalSelections(snapshot, remainingRows)).toThrow();
    },
  );
  it('keeps a single nonempty slot, never creates all-empty films, and detects tampered holes', () => {
    const { snapshot, rows } = fixture();
    snapshot.incremental!.emptySlotPolicy = 'ALLOW_EMPTY_POOLS';
    snapshot.materials = snapshot.materials.filter((m) => m.id === 'new');
    const remainingRows = rows.filter((row) => row.materialId === 'new');
    const selections = adaptiveIncrementalSelections(snapshot, remainingRows);
    expect(selections).toHaveLength(1);
    expect(selections[0]!.intentionallyEmptySlotIds).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(() =>
      validatePartialAppendSelections(snapshot, remainingRows, [
        {
          ...selections[0]!,
          intentionallyEmptySlotIds: ['s0', 's2', 's3', 's4', 's5'],
        },
      ]),
    ).toThrow('覆盖');
    snapshot.materials[0]!.duration = 1;
    expect(() => adaptiveIncrementalSelections(snapshot, remainingRows)).toThrow(
      '没有可采用的新增素材',
    );
  });
  it('does not voluntarily empty a usable slot and excludes existing sparse combinations', () => {
    const { snapshot, rows } = fixture();
    snapshot.incremental!.emptySlotPolicy = 'ALLOW_EMPTY_POOLS';
    const selections = adaptiveIncrementalSelections(snapshot, rows);
    expect(selections[0]!.intentionallyEmptySlotIds).toEqual([]);
    const tampered = structuredClone(selections).filter((item) => item.slotId !== 's2');
    tampered[0]!.intentionallyEmptySlotIds = ['s2'];
    expect(() => validatePartialAppendSelections(snapshot, rows, tampered)).toThrow();
    snapshot.materials = snapshot.materials.filter((m) => m.id !== 'm2');
    const remaining = rows.filter((row) => row.materialId !== 'm2');
    const sparse = adaptiveIncrementalSelections(snapshot, remaining);
    snapshot.existingVariantBindings.push(sparse);
    expect(() => adaptiveIncrementalSelections(snapshot, remaining)).toThrow();
  });
  it('reports unusable additions without acknowledging them and covers all usable additions', () => {
    const { snapshot, rows } = fixture();
    snapshot.incremental!.emptySlotPolicy = 'ALLOW_EMPTY_POOLS';
    snapshot.materials.push({ ...snapshot.materials[0]!, id: 'short', duration: 1 });
    snapshot.incremental!.materialIds.push('short');
    rows.push({ ...rows[0]!, materialId: 'short' });
    const selections = adaptiveIncrementalSelections(snapshot, rows);
    expect(selections[0]!.omittedNewMaterials).toEqual([
      expect.objectContaining({ materialId: 'short' }),
    ]);
    expect(selections.some((item) => item.materialId === 'short')).toBe(false);
  });
  it('covers additions, preserves roles/durations and excludes existing exact films', () => {
    const { snapshot, rows } = fixture();
    const selections = adaptiveIncrementalSelections(snapshot, rows);
    expect(selections).toHaveLength(6);
    expect(selections.filter((item) => item.materialId === 'new')).toHaveLength(1);
    expect(new Set(selections.map((item) => item.materialId)).size).toBe(6);
    expect(selections.every((item) => item.variantIndex === 0)).toBe(true);
    snapshot.materials.find((item) => item.id === 'new')!.duration = 3;
    expect(() => adaptiveIncrementalSelections(snapshot, rows)).toThrow('未能全部');
  });
  it('adds more than one cover round when new structural combinations are worthwhile', () => {
    const { snapshot, rows } = fixture();
    for (let roleIndex = 1; roleIndex < roles.length - 1; roleIndex++) {
      for (let i = 0; i < 3; i++) {
        const id = `extra-${roleIndex}-${i}`;
        snapshot.materials.push({ ...snapshot.materials[roleIndex]!, id, promptId: id });
        rows.push({ ...rows[roleIndex]!, materialId: id });
        snapshot.materialRoleAssignments![id] = roles[roleIndex]!;
        snapshot.incremental!.materialIds.push(id);
      }
    }
    snapshot.maxOutputVariants = 100;
    const selections = adaptiveIncrementalSelections(snapshot, rows);
    const count = new Set(selections.map((item) => item.variantIndex)).size;
    expect(count).toBeGreaterThan(4);
    expect(count).toBeLessThan(100);
    const covered = new Set(selections.map((item) => item.materialId));
    expect(snapshot.incremental!.materialIds.every((id) => covered.has(id))).toBe(true);
    for (let index = 0; index < count; index++) {
      const group = selections.filter((item) => item.variantIndex === index);
      expect(
        group.some((item) => snapshot.incremental!.materialIds.includes(item.materialId)),
      ).toBe(true);
    }
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
