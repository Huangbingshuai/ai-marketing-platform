import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixPurpose,
  EffectTemplateMixVariant,
  EffectTemplateMixWorkspace,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import { applyVariantToTemplate, createVariant, fillVariant } from './effect-template-mix.domain';

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
});
