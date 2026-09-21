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

const ROLES = [
  'HOOK',
  'PAIN_POINT',
  'PRODUCT',
  'SELLING_POINT',
  'TRANSFORMATION',
  'END',
] as const;

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
    expect(buildAssignedPools(slots, withoutEnd, withoutEndClassifications).get('END')).toHaveLength(
      0,
    );
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
