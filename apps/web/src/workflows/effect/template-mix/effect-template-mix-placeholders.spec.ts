import { describe, expect, it } from 'vitest';
import timeline from './EffectTemplateMixTimeline.vue?raw';
import page from './EffectTemplateMixNodePage.vue?raw';
import packaging from './EffectTemplateMixPackaging.vue?raw';

describe('decorative empty template markers', () => {
  it('has no selectable clip identity or pointer interaction', () => {
    expect(timeline).toContain(':data-slot-id="variant.bindings[slot.id] ? slot.id : undefined"');
    expect(timeline).toMatch(/\.video-clip\.is-template-marker\s*\{[^}]*pointer-events:\s*none/s);
    expect(timeline).toContain(".filter((slot) => props.variant?.bindings[slot.id])");
    expect(timeline).toContain('props.variant?.slots.filter(({ id }) => props.variant?.bindings[id])');
  });
  it('shows a neutral sign instead of a missing-media warning', () => {
    expect(timeline).toContain("variant.bindings[slot.id] ? '素材不可用' : '模板槽位'");
    expect(timeline).toContain('Boolean(variant.bindings[slot.id]) && (!materialForSlot(slot.id)');
    expect(timeline).toMatch(/\.video-clip\.is-template-marker\s*\{[^}]*border:\s*1px dashed #cbd5e1/s);
  });
  it('does not reserve a replacement target, transition or conflict', () => {
    expect(timeline).toContain('selectedTarget && props.variant?.bindings[selectedTarget]');
    expect(timeline).toContain('variant?.bindings[slot.id] && variant?.bindings[variant.slots[index]!.id]');
    expect(page).toContain('variant.conflictSlotIds.filter((id) => Boolean(variant.bindings[id])).length');
  });
  it('lets the first audio or caption create content without a video-duration fence', () => {
    const audio = page.split('const pasteTimelineAudioMaterial =')[1]?.split('const applyMaterialToSlot =')[0];
    expect(audio).not.toContain('currentDuration.value');
    const caption = page.split('const addCaption =')[1]?.split('const quantizeTimelineTime')[0];
    expect(caption).not.toContain('Math.min(currentDuration.value, start + 3)');
    expect(caption).toContain('EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS, start + 3');
  });
  it('does not require filling the signs before intelligent packaging', () => {
    expect(packaging).toContain('v.slots.some((s) => v.bindings[s.id])');
    expect(packaging).not.toContain('v.slots.every((s) => v.bindings[s.id])');
  });
});
