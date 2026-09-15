import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixPurpose,
  EffectTemplateMixVariant,
  EffectTemplateMixWorkspace,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  applyVariantToTemplate,
  composeAlgorithmicVariants,
  createVariant,
  fillVariant,
  maximumWeightedAiSelection,
  maximumWeightedAiSelectionBatch,
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

describe('effect template mix domain', () => {
  it('recombines cached AI trims into distinct projects while balancing reuse', () => {
    const value = workspace();
    value.materials = [
      ...[0, 1, 2].map((index) => material(`hook-${index}`, 'HOOK')),
      ...[0, 1, 2].map((index) => material(`effect-${index}`, 'EFFECT')),
    ];
    for (let index = 0; index < 3; index += 1) {
      const variant = createVariant(value);
      variant.bindings = { 'slot-hook': `hook-${index}`, 'slot-effect': `effect-${index}` };
      variant.bindingRevisions = { 'slot-hook': 3, 'slot-effect': 3 };
      variant.offsets = { 'slot-hook': 0.25, 'slot-effect': 0.5 };
      variant.bindingMetadata = Object.fromEntries(
        value.template.slots.map((slot) => [
          slot.id,
          {
            source: 'AI',
            matchScore: 0.8,
            matchLevel: 'NORMAL',
            classificationReason: 'Prompt 归槽',
            trimReason: '关键帧',
          },
        ]),
      );
      value.variants.push(variant);
    }
    const created = composeAlgorithmicVariants(value, 6);
    expect(created).toHaveLength(6);
    const all = [...value.variants, ...created];
    expect(
      new Set(
        all.map((variant) =>
          value.template.slots.map((slot) => variant.bindings[slot.id]).join('|'),
        ),
      ).size,
    ).toBe(9);
    expect(created.every((variant) => new Set(Object.values(variant.bindings)).size === 2)).toBe(
      true,
    );
    expect(created[0]!.offsets).toEqual({ 'slot-hook': 0.25, 'slot-effect': 0.5 });
    expect(created[0]!.bindingMetadata?.['slot-hook']?.source).toBe('AI');
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

  it('builds as many non-repeating AI output groups as the material pool allows', () => {
    const slots = workspace().template.slots;
    const materials = [
      material('one', 'HOOK'),
      material('two', 'EFFECT'),
      material('three', 'HOOK'),
      material('four', 'EFFECT'),
    ];
    const classifications = materials.map((item, index) => ({
      materialId: item.id,
      scores: {
        HOOK: index % 2 === 0 ? 0.9 : 0.2,
        PAIN_POINT: index % 2 === 1 ? 0.9 : 0.2,
        PRODUCT: 0,
        SELLING_POINT: 0,
        TRANSFORMATION: 0,
        END: 0,
      },
      reasons: {},
    }));

    const groups = maximumWeightedAiSelectionBatch(slots, materials, classifications);

    expect(groups).toHaveLength(2);
    expect(groups.flat().map(({ variantIndex }) => variantIndex)).toEqual([0, 0, 1, 1]);
    expect(new Set(groups.flat().map(({ materialId }) => materialId))).toHaveProperty('size', 4);
  });
});
