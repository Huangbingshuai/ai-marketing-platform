import type { EffectTemplateMixVariant, EffectTemplateMixWorkspace } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import {
  cloneMix,
  createEffectTemplateMixEntry,
  effectTemplateMixTiming,
  formatEffectTemplateMixTime,
  markEffectTemplateMixChanged,
  moveEffectTemplateMixSlot,
} from './effect-template-mix-state';

const workspace = (): EffectTemplateMixWorkspace =>
  createEffectTemplateMixEntry('跑量模板').workspace;

const variant = (value: EffectTemplateMixWorkspace, id: string): EffectTemplateMixVariant => ({
  id,
  name: id,
  appliedTemplateVersion: value.template.editVersion,
  slots: cloneMix(value.template.slots),
  bindings: {},
  bindingRevisions: {},
  offsets: {},
  manualSlotIds: [],
  conflictSlotIds: [],
  status: 'CURRENT',
  captions: [],
  subtitleStyle: 'standard',
  bgm: null,
  voice: null,
  originalVolume: 1,
});

describe('effect template mix presentation state', () => {
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

  it('marks sibling projects pending without overwriting their snapshot', () => {
    const value = workspace();
    value.variants = [variant(value, 'selected'), variant(value, 'sibling')];
    const siblingDuration = value.variants[1]!.slots[0]!.duration;
    value.template.slots[0]!.duration = 2.2;
    markEffectTemplateMixChanged(value, 'selected');
    expect(value.variants[0]!.slots[0]!.duration).toBe(2.2);
    expect(value.variants[1]!.slots[0]!.duration).toBe(siblingDuration);
    expect(value.variants[1]!.status).toBe('PENDING');
  });

  it('reorders without mutating the template array', () => {
    const slots = workspace().template.slots;
    const moved = moveEffectTemplateMixSlot(slots, slots[0]!.id, 1);
    expect(moved[1]!.id).toBe(slots[0]!.id);
    expect(slots[0]!.id).not.toBe(moved[0]!.id);
  });
});
