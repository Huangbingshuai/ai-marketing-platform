import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import { effectTemplateMixSourceChanges } from '@ai-marketing/contracts';
import type { EffectTemplateMixMaterial, EffectTemplateMixVariant } from '@ai-marketing/contracts';
import { createMixSourceChangesReader } from './effect-template-mix-source-changes-reader';

function fixture() {
  const material = {
    id: 'clip',
    artifactKey: 'render-clip:clip',
    artifactId: 'artifact',
    artifactRevision: 1,
    fileObjectId: 'file-1',
    contentHash: 'hash-1',
    duration: 10,
    available: true,
  } as EffectTemplateMixMaterial;
  const variant = reactive({
    id: 'film',
    slots: [{ id: 'slot', duration: 6 }],
    bindings: { slot: material.id },
    offsets: { slot: 0 },
    bindingRevisions: { slot: 1 },
    bindingSources: { slot: { ...material } },
  } as unknown as EffectTemplateMixVariant);
  return { variant, materials: reactive([{ ...material }]), read: createMixSourceChangesReader() };
}

describe('reactive mix source differences', () => {
  it('reuses one calculation across repeated card, count and action reads', () => {
    const { read, variant, materials } = fixture();
    const changes = read(variant, materials);
    for (let i = 0; i < 100; i++) expect(read(variant, materials)).toBe(changes);
    expect(changes).toEqual([]);
  });
  it('invalidates for two source revisions and explicit adoption, without changing a sibling', () => {
    const { read, variant, materials } = fixture();
    const sibling = reactive({ ...variant, bindings: {}, bindingSources: {} });
    const siblingChanges = read(sibling, materials);
    expect(read(variant, materials)).toEqual([]);
    for (const revision of [2, 3]) {
      Object.assign(materials[0]!, {
        artifactRevision: revision,
        fileObjectId: `file-${revision}`,
      });
      expect(read(variant, materials)).toEqual(effectTemplateMixSourceChanges(variant, materials));
      expect(read(variant, materials)).toHaveLength(1);
      variant.bindingSources!.slot = { ...materials[0]! };
      variant.bindingRevisions.slot = revision;
      expect(read(variant, materials)).toEqual([]);
      expect(read(sibling, materials)).toBe(siblingChanges);
    }
  });
  it('recalculates deletion, re-addition and short replacements in place', () => {
    const { read, variant, materials } = fixture();
    read(variant, materials);
    materials[0]!.sourceRemoved = true;
    expect(read(variant, materials)[0]?.kind).toBe('REMOVED');
    materials.push({
      ...materials[0]!,
      id: 'new',
      sourceRemoved: false,
      fileObjectId: 'file-new',
      artifactRevision: 2,
      duration: 5,
    });
    expect(read(variant, materials)[0]?.blockedReason).toContain('时长不足');
    variant.slots[0]!.duration = 4;
    expect(read(variant, materials)[0]?.material?.id).toBe('new');
    variant.bindings.slot = '';
    expect(read(variant, materials)).toEqual([]);
  });
  it('keeps separate pools and reader lifetimes isolated', () => {
    const { read, variant, materials } = fixture();
    const original = read(variant, materials);
    const otherPool = reactive([{ ...materials[0]!, fileObjectId: 'other', artifactRevision: 2 }]);
    expect(read(variant, otherPool)).toHaveLength(1);
    expect(read(variant, materials)).toBe(original);
    expect(createMixSourceChangesReader()(variant, otherPool)).toEqual(read(variant, otherPool));
    expect(createMixSourceChangesReader()(variant, materials)).not.toBe(original);
  });
});
