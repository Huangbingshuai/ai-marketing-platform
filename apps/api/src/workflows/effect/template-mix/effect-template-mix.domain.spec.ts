import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixMaterial,
  EffectTemplateMixPurpose,
  EffectTemplateMixRole,
  EffectTemplateMixVariant,
  EffectTemplateMixWorkspace,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  applyVariantToTemplate,
  balancedSlotAssignment,
  buildAssignedPools,
  createEmptyVariant,
  createVariant,
  enumerateAssignedVariants,
  fillVariant,
  maximumWeightedAiSelection,
  selectAssignedVariant,
} from './effect-template-mix.domain';

const material = (
  id: string,
  purpose: EffectTemplateMixPurpose,
  compatiblePurposes: EffectTemplateMixPurpose[] = [],
): EffectTemplateMixMaterial => ({
  id,
  code: id,
  name: id,
  duration: 4,
  purpose,
  compatiblePurposes,
  artifactId: id,
  artifactKey: 'render-clip:' + id,
  artifactRevision: 3,
  fileObjectId: 'file-' + id,
  contentHash: 'hash-' + id,
  contentUrl: '/content/' + id,
  ratio: '9:16',
  resolution: '1080p',
  available: true,
});

const workspace = (): EffectTemplateMixWorkspace => ({
  editVersion: 1,
  template: {
    name: '跑量模板',
    editVersion: 1,
    slots: [
      {
        id: 'slot-hook',
        label: '钩子',
        role: 'HOOK',
        purpose: 'HOOK',
        duration: 3,
        transition: '硬切',
      },
      {
        id: 'slot-effect',
        label: '效果',
        role: 'TRANSFORMATION',
        purpose: 'EFFECT',
        duration: 3,
        transition: '叠化',
      },
    ],
  },
  variants: [],
  materials: [material('flex', 'HOOK', ['EFFECT']), material('hook-only', 'HOOK')],
});

const ROLES = ['HOOK', 'PAIN_POINT', 'PRODUCT', 'SELLING_POINT', 'TRANSFORMATION', 'END'] as const;

const zeroScores = (): Record<EffectTemplateMixRole, number> => ({
  HOOK: 0,
  PAIN_POINT: 0,
  PRODUCT: 0,
  SELLING_POINT: 0,
  TRANSFORMATION: 0,
  END: 0,
});

const balancedClassification = (
  materialId: string,
  scores: Record<EffectTemplateMixRole, number>,
): EffectTemplateMixAiClassification => ({ materialId, scores, reasons: {} });

describe('effect template mix domain', () => {
  it('reserves fixed roles first and covers the remaining roles without borrowing fixed clips', () => {
    const slots = ROLES.map((role) => ({ id: role, role, duration: 4 }));
    const classifications = ROLES.map((role, index) => ({
      materialId: `m${index}`,
      scores: { ...zeroScores(), [role]: 0.9 },
      reasons: {},
    }));
    classifications[0]!.scores.END = 1;
    const materials = classifications.map((item) => ({
      id: item.materialId,
      available: true,
      duration: 5,
    }));
    const pools = buildAssignedPools(slots, materials, classifications, new Set(), { m0: 'HOOK' });
    expect(pools.get('HOOK')?.map((item) => item.materialId)).toEqual(['m0']);
    expect(pools.get('END')?.some((item) => item.materialId === 'm0')).toBe(false);
    expect([...pools.values()].every((pool) => pool.length === 1)).toBe(true);
    const groups = enumerateAssignedVariants(slots, materials, classifications, [], 1, 2, {
      m0: 'HOOK',
    });
    expect(groups[0]!.find((item) => item.materialId === 'm0')?.role).toBe('HOOK');
    const insufficient = buildAssignedPools(
      slots,
      materials.slice(0, 5),
      classifications.slice(0, 5),
      new Set(),
      { m0: 'HOOK' },
    );
    expect(insufficient.get('END')).toEqual([]);
    const short = buildAssignedPools(
      slots,
      [{ id: 'm0', available: true, duration: 3 }],
      [classifications[0]!],
      new Set(),
      { m0: 'HOOK' },
    );
    expect([...short.values()].flat()).toEqual([]);
  });
  it('creates a genuinely empty project even when matching materials exist', () => {
    const value = workspace();
    const result = createEmptyVariant(value);
    expect(result.slots).toEqual(value.template.slots);
    expect(result.bindings).toEqual({});
    expect(result.bindingRevisions).toEqual({});
    expect(result.offsets).toEqual({});
    expect(result.conflictSlotIds).toEqual([]);
  });

  it('uses maximum matching, records exact revisions and never repeats a clip', () => {
    const value = workspace();
    const result = createVariant(value);
    expect(result.conflictSlotIds).toEqual([]);
    expect(result.bindings['slot-hook']).toBe('hook-only');
    expect(result.bindings['slot-effect']).toBe('flex');
    expect(new Set(Object.values(result.bindings)).size).toBe(2);
    expect(result.bindingRevisions).toEqual({ 'slot-hook': 3, 'slot-effect': 3 });
  });

  it('preserves manual bindings and leaves explicit gaps when sources are insufficient', () => {
    const value = workspace();
    value.materials = [material('hook-only', 'HOOK')];
    const result = createVariant(value);
    result.manualSlotIds = ['slot-hook'];
    fillVariant(value, result);
    expect(result.bindings['slot-hook']).toBe('hook-only');
    expect(result.conflictSlotIds).toEqual(['slot-effect']);
  });

  it('syncs only sibling projects in the same workspace and preserves manual clips', () => {
    const value = workspace();
    const source = createVariant(value);
    value.variants.push(source);
    const sibling: EffectTemplateMixVariant = createVariant(value);
    sibling.manualSlotIds = ['slot-hook'];
    const fixed = sibling.bindings['slot-hook'];
    value.variants.push(sibling);
    source.slots[0]!.duration = 2;

    const result = applyVariantToTemplate(value, source, true);

    expect(result).toEqual({ conflicts: 0, synced: 1 });
    expect(value.template.slots[0]!.duration).toBe(2);
    expect(sibling.slots[0]!.duration).toBe(2);
    expect(sibling.bindings['slot-hook']).toBe(fixed);
    expect(sibling.status).toBe('SYNCED');
  });

  it('promotes only the template slots and keeps every variant clip dropped on its own track', () => {
    const value = workspace();
    const source = createVariant(value);
    const extra = {
      id: 'free-clip',
      label: 'extra',
      role: 'PRODUCT' as const,
      purpose: 'PRODUCT_DISPLAY' as const,
      duration: 4,
      transition: '硬切' as const,
      transitionDuration: 0,
    };
    source.slots.push(extra);
    source.bindings[extra.id] = 'flex';
    source.videoLanes = { [extra.id]: 1 };
    value.variants.push(source);
    const sibling: EffectTemplateMixVariant = createVariant(value);
    const siblingExtra = { ...extra, id: 'sibling-clip' };
    sibling.slots.push(siblingExtra);
    sibling.bindings[siblingExtra.id] = 'hook-only';
    sibling.videoLanes = { [siblingExtra.id]: 1 };
    value.variants.push(sibling);

    applyVariantToTemplate(value, source, true);

    // The template keeps its own two slots — a variant's free clip is not a template slot.
    expect(value.template.slots.map(({ id }) => id)).toEqual(['slot-hook', 'slot-effect']);
    // The promoted variant keeps its clip, and the sibling keeps its own.
    expect(source.slots.map(({ id }) => id)).toEqual(['slot-hook', 'slot-effect', 'free-clip']);
    expect(sibling.slots.map(({ id }) => id)).toEqual(['slot-hook', 'slot-effect', 'sibling-clip']);
    expect(sibling.bindings['sibling-clip']).toBe('hook-only');
    expect(sibling.videoLanes['sibling-clip']).toBe(1);
  });

  it('uses global AI scores, keeps materials unique and marks low-match fill', () => {
    const slots = workspace().template.slots;
    const materials = [material('one', 'HOOK'), material('two', 'EFFECT')];
    const result = maximumWeightedAiSelection(slots, materials, [
      {
        materialId: 'one',
        scores: {
          HOOK: 0.9,
          PAIN_POINT: 0,
          PRODUCT: 0,
          SELLING_POINT: 0,
          TRANSFORMATION: 0.8,
          END: 0,
        },
        reasons: { HOOK: '开场动作直接', TRANSFORMATION: '可表现结果' },
      },
      {
        materialId: 'two',
        scores: {
          HOOK: 0.55,
          PAIN_POINT: 0,
          PRODUCT: 0,
          SELLING_POINT: 0,
          TRANSFORMATION: 0.1,
          END: 0,
        },
        reasons: { HOOK: '只能低分补位', TRANSFORMATION: '结果不明显' },
      },
    ]);
    expect(result?.map(({ materialId }) => materialId)).toEqual(['two', 'one']);
    expect(result?.[0]?.matchLevel).toBe('LOW_MATCH');
    expect(new Set(result?.map(({ materialId }) => materialId)).size).toBe(2);
  });

  const sixSlots = (): Array<{ id: string; role: EffectTemplateMixRole; duration: number }> => [
    { id: 'slot-hook', role: 'HOOK', duration: 3 },
    { id: 'slot-pain', role: 'PAIN_POINT', duration: 3 },
    { id: 'slot-product', role: 'PRODUCT', duration: 3 },
    { id: 'slot-selling', role: 'SELLING_POINT', duration: 3 },
    { id: 'slot-transform', role: 'TRANSFORMATION', duration: 3 },
    { id: 'slot-end', role: 'END', duration: 3 },
  ];

  const assignedSetup = (perRole: number) => {
    const slots = sixSlots();
    const materials: Array<{ id: string; duration: number; available: boolean }> = [];
    const classifications: EffectTemplateMixAiClassification[] = [];
    for (const slot of slots) {
      for (let index = 0; index < perRole; index += 1) {
        const id = `${slot.role.toLowerCase()}-${index}`;
        materials.push({ id, duration: 4, available: true });
        classifications.push({
          materialId: id,
          scores: { ...zeroScores(), [slot.role]: 0.9 },
          reasons: {},
        });
      }
    }
    return { slots, materials, classifications };
  };

  it('hard-assigns every clip to exactly one role and never borrows across slots', () => {
    const { slots, materials, classifications } = assignedSetup(3);
    const pools = buildAssignedPools(slots, materials, classifications);
    const seen = new Set<string>();
    for (const items of pools.values()) {
      for (const item of items) expect(seen.has(item.materialId)).toBe(false);
      for (const item of items) seen.add(item.materialId);
    }
    expect(seen.size).toBe(18);
    for (const slot of slots) expect(pools.get(slot.role)).toHaveLength(3);
    const variants = enumerateAssignedVariants(slots, materials, classifications, [], 100);
    for (const variant of variants) {
      expect(variant).toHaveLength(6);
      for (const selection of variant) {
        const slot = slots.find(({ id }) => id === selection.slotId)!;
        expect(selection.role).toBe(slot.role);
      }
    }
  });

  it('reserves six distinct feasible roles before balancing a skewed ten-clip pool', () => {
    const slots = sixSlots();
    const classifications = slots.map((slot, index) => ({
      materialId: `role-${index}`,
      scores: {
        ...zeroScores(),
        [slot.role]: slot.role === 'HOOK' ? 0.7 : 0.9,
        ...(slot.role === 'HOOK' ? { SELLING_POINT: 0.95 } : {}),
      },
      reasons: {},
    }));
    classifications.push(
      ...Array.from({ length: 4 }, (_, index) => ({
        materialId: `product-extra-${index}`,
        scores: { ...zeroScores(), PRODUCT: 0.95 },
        reasons: {},
      })),
    );
    const materials = classifications.map(({ materialId }) => ({
      id: materialId,
      duration: 4,
      available: true,
    }));
    const pools = buildAssignedPools(slots, materials, classifications);
    expect(slots.every((slot) => (pools.get(slot.role)?.length ?? 0) > 0)).toBe(true);
    expect(pools.get('HOOK')?.[0]?.materialId).toBe('role-0');
    const variant = enumerateAssignedVariants(slots, materials, classifications, [], 1)[0];
    expect(variant).toHaveLength(6);
    expect(new Set(variant?.map(({ materialId }) => materialId)).size).toBe(6);
  });

  it('chooses the higher-scoring complete matching instead of a greedy reservation', () => {
    const slots = sixSlots().slice(0, 2);
    const materials = ['flexible', 'hook-only'].map((id) => ({
      id,
      duration: 4,
      available: true,
    }));
    const classifications = [
      {
        materialId: 'flexible',
        scores: { ...zeroScores(), HOOK: 0.9, PAIN_POINT: 0.95 },
        reasons: {},
      },
      {
        materialId: 'hook-only',
        scores: { ...zeroScores(), HOOK: 0.8, PAIN_POINT: 0.1 },
        reasons: {},
      },
    ];
    const pools = buildAssignedPools(slots, materials, classifications);
    expect(pools.get('HOOK')?.[0]?.materialId).toBe('hook-only');
    expect(pools.get('PAIN_POINT')?.[0]?.materialId).toBe('flexible');
  });

  it('reserves only duration-feasible clips and reports a genuinely empty role', () => {
    const slots = sixSlots().map((slot) =>
      slot.role === 'HOOK' ? { ...slot, duration: 5 } : slot,
    );
    const { materials, classifications } = assignedSetup(1);
    const shortHook = materials.find(({ id }) => id === 'hook-0')!;
    shortHook.duration = 4;
    expect(buildAssignedPools(slots, materials, classifications).get('HOOK')).toHaveLength(0);
    materials.push({ id: 'long-hook', duration: 5, available: true });
    classifications.push({
      materialId: 'long-hook',
      scores: { ...zeroScores(), HOOK: 0.55, PRODUCT: 0.8 },
      reasons: {},
    });
    const pools = buildAssignedPools(slots, materials, classifications);
    expect(pools.get('HOOK')?.[0]?.materialId).toBe('long-hook');
    expect(selectAssignedVariant(slots, materials, classifications)).toHaveLength(6);
  });

  it('reuses clips across variants while keeping pairwise overlap within budget', () => {
    const { slots, materials, classifications } = assignedSetup(3);
    const variants = enumerateAssignedVariants(slots, materials, classifications, [], 100);
    expect(variants.length).toBeGreaterThan(3);
    for (let left = 0; left < variants.length; left += 1) {
      for (let right = left + 1; right < variants.length; right += 1) {
        const bindings = new Map(
          variants[left]!.map(({ slotId, materialId }) => [slotId, materialId]),
        );
        const shared = variants[right]!.filter(
          ({ slotId, materialId }) => bindings.get(slotId) === materialId,
        ).length;
        expect(shared).toBeLessThanOrEqual(2);
      }
    }
  });

  it('returns no variants when a slot role has no assigned clips', () => {
    const { slots, materials, classifications } = assignedSetup(3);
    const withoutEnd = materials.filter(({ id }) => !id.startsWith('end-'));
    const withoutEndClassifications = classifications.filter(
      ({ materialId }) => !materialId.startsWith('end-'),
    );
    expect(
      buildAssignedPools(slots, withoutEnd, withoutEndClassifications).get('END'),
    ).toHaveLength(0);
    expect(
      enumerateAssignedVariants(slots, withoutEnd, withoutEndClassifications, [], 100),
    ).toEqual([]);
  });

  it('fills a single variant drawing only from each role own pool', () => {
    const { slots, materials, classifications } = assignedSetup(3);
    const selections = selectAssignedVariant(slots, materials, classifications);
    expect(selections).toHaveLength(6);
    expect(new Set(selections.map(({ materialId }) => materialId)).size).toBe(6);
    for (const selection of selections) {
      const slot = slots.find(({ id }) => id === selection.slotId)!;
      expect(selection.role).toBe(slot.role);
    }
  });

  it('assigns every material to exactly one valid role', () => {
    const classifications = Array.from({ length: 18 }, (_, index) =>
      balancedClassification(`m${index}`, { ...zeroScores(), HOOK: 0.9 - index * 0.01, END: 0.85 }),
    );
    const assignment = balancedSlotAssignment(ROLES, classifications);
    expect(assignment.size).toBe(18);
    for (const role of assignment.values()) expect(ROLES).toContain(role);
  });

  it('spreads nearly-tied materials across roles instead of piling into one', () => {
    const classifications = Array.from({ length: 30 }, (_, index) =>
      balancedClassification(`m${index}`, {
        ...zeroScores(),
        HOOK: 0.55,
        PAIN_POINT: 0.5,
        PRODUCT: 0.5,
        SELLING_POINT: 0.5,
        TRANSFORMATION: 0.5,
        END: 0.5,
      }),
    );
    const assignment = balancedSlotAssignment(ROLES, classifications);
    const counts = new Map<EffectTemplateMixRole, number>();
    for (const role of assignment.values()) counts.set(role, (counts.get(role) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThan(10);
  });

  it('keeps a material with a clear best role on that role', () => {
    const classifications = ROLES.map((role, index) => {
      const scores = zeroScores();
      scores[role] = 0.9;
      return balancedClassification(`m${index}`, scores);
    });
    const assignment = balancedSlotAssignment(ROLES, classifications);
    ROLES.forEach((role, index) => {
      expect(assignment.get(`m${index}`)).toBe(role);
    });
  });
});
