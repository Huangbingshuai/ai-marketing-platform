import type { EffectTemplateMixMaterial, EffectTemplateMixPurpose } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import {
  createEffectTemplateMixEntry,
  createEffectTemplateMixVariant,
  effectTemplateMixTiming,
  formatEffectTemplateMixTime,
  markEffectTemplateMixChanged,
  moveEffectTemplateMixSlot,
  syncEffectTemplateMixVariants,
} from './effect-template-mix-state';

const material = (id: string, purpose: EffectTemplateMixPurpose): EffectTemplateMixMaterial => ({
  id,
  code: id,
  name: '片段 ' + id,
  duration: 4,
  purpose,
  compatiblePurposes: [],
  artifactId: id,
  artifactKey: 'render-clip:' + id,
  artifactRevision: 2,
  fileObjectId: 'file-' + id,
  contentHash: 'hash-' + id,
  contentUrl: '/api/' + id,
  ratio: '9:16',
  resolution: '1080p',
  available: true,
});
const workspace = () => {
  const value = createEffectTemplateMixEntry('跑量模板').workspace;
  value.materials = value.template.slots.map((slot, index) =>
    material('clip-' + index, slot.purpose),
  );
  return value;
};

describe('effect template mix state', () => {
  it('derives contiguous ranges and a real-time total', () => {
    const slots = workspace().template.slots.slice(0, 3);
    slots[0]!.duration = 4;
    slots[1]!.duration = 3;
    slots[2]!.duration = 2;
    expect(effectTemplateMixTiming(slots).slots.map(({ start, end }) => [start, end])).toEqual([
      [0, 4],
      [4, 7],
      [7, 9],
    ]);
    expect(effectTemplateMixTiming(slots).duration).toBe(9);
    expect(formatEffectTemplateMixTime(77)).toBe('01:17.0');
  });
  it('fills without repeating sources and records their revisions', () => {
    const value = workspace();
    const variant = createEffectTemplateMixVariant(value);
    expect(variant.conflictSlotIds).toEqual([]);
    expect(new Set(Object.values(variant.bindings)).size).toBe(variant.slots.length);
    expect(Object.values(variant.bindingRevisions).every((revision) => revision === 2)).toBe(true);
  });
  it('keeps explicit gaps when the confirmed source pool is insufficient', () => {
    const value = workspace();
    value.materials = value.materials.slice(0, 2);
    expect(createEffectTemplateMixVariant(value).conflictSlotIds.length).toBe(4);
  });
  it('changes another project only after explicit synchronization', () => {
    const value = workspace();
    value.variants = [
      createEffectTemplateMixVariant(value, 0),
      createEffectTemplateMixVariant(value, 1),
    ];
    const selected = value.variants[0]!;
    const other = value.variants[1]!;
    const before = other.slots[0]!.duration;
    value.template.slots[0]!.duration = 2.2;
    markEffectTemplateMixChanged(value, selected.id);
    expect(other.slots[0]!.duration).toBe(before);
    expect(other.status).toBe('PENDING');
    syncEffectTemplateMixVariants(value, selected.id);
    expect(other.slots[0]!.duration).toBe(2.2);
  });
  it('preserves a manually selected source during synchronization', () => {
    const value = workspace();
    value.variants = [
      createEffectTemplateMixVariant(value, 0),
      createEffectTemplateMixVariant(value, 1),
    ];
    const target = value.variants[1]!;
    const slot = target.slots[0]!;
    const fixed = target.bindings[slot.id]!;
    target.manualSlotIds.push(slot.id);
    markEffectTemplateMixChanged(value, value.variants[0]!.id);
    syncEffectTemplateMixVariants(value, value.variants[0]!.id);
    expect(target.bindings[slot.id]).toBe(fixed);
  });
  it('reorders without mutating the template array', () => {
    const slots = workspace().template.slots;
    const moved = moveEffectTemplateMixSlot(slots, slots[0]!.id, 1);
    expect(moved[1]!.id).toBe(slots[0]!.id);
    expect(slots[0]!.id).not.toBe(moved[0]!.id);
  });
});
