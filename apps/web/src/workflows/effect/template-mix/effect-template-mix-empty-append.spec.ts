import { describe, expect, it } from 'vitest';
import { transpileModule, ScriptTarget } from 'typescript';
import { packagingTimelineClips } from '@ai-marketing/contracts';
import page from './EffectTemplateMixNodePage.vue?raw';
import timeline from './EffectTemplateMixTimeline.vue?raw';

const variant = () => ({
  slots: [
    { id: 'first', role: 'HOOK', duration: 4, transition: '硬切' },
    { id: 'hole', role: 'PAIN_POINT', duration: 6, transition: '叠化' },
    { id: 'last', role: 'END', duration: 4, transition: '叠化' },
  ],
  bindings: { first: 'm1', last: 'm3' } as Record<string, string>,
  intentionallyEmptySlotIds: ['hole'],
  preservedTimelineEnd: 14,
});
function execute(source: string, name: string, context: Record<string, unknown>) {
  const js = transpileModule(`${source}; return ${name};`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(context), js)(...Object.values(context));
}

describe('partial local append workbench', () => {
  it('drops into the actual empty slot, rather than replacing the last bound clip', () => {
    const v = variant();
    const source = `const slotIdFromDragEvent =${
      timeline.split('const slotIdFromDragEvent =')[1]!.split('const acceptsMaterialDrag =')[0]!
    }`;
    const fromEvent = execute(source, 'slotIdFromDragEvent', {
      props: { variant: v },
      packagingTimelineClips,
      videoLaneAtClientY: () => null,
      Element: class {},
      viewport: { value: { getBoundingClientRect: () => ({ left: 0 }), scrollLeft: 0 } },
      pixelsPerSecond: { value: 10 },
    });
    expect(fromEvent({ clientX: 60, target: null })).toBe('hole');
    expect(fromEvent({ clientX: 110, target: null })).toBe('last');
    v.bindings.hole = 'new';
    v.intentionallyEmptySlotIds = [];
    expect(fromEvent({ clientX: 60, target: null })).toBe('hole');
  });
  it('does not start incoming media early across an empty slot, but keeps real adjacent transitions', () => {
    const v = variant();
    const source = `const timelinePlaybackStart =${
      page.split('const timelinePlaybackStart =')[1]!.split('const timelineSourceTime =')[0]!
    }`;
    const start = execute(source, 'timelinePlaybackStart', {
      selectedVariant: { value: v },
      currentTiming: {
        value: {
          slots: [
            { id: 'first', start: 0, end: 4 },
            { id: 'hole', start: 4, end: 10 },
            { id: 'last', start: 10, end: 14 },
          ],
        },
      },
      effectTemplateMixTransitionDuration: () => 1,
      TIMELINE_FPS: 30,
    });
    expect(start('last')).toBe(10);
    v.bindings.hole = 'new';
    expect(start('last')).toBe(9.5);
  });
  it('keeps intentional holes as informational reminders, not source failures', () => {
    const source = `const variantEmptySlotCount =${
      page.split('const variantEmptySlotCount =')[1]!.split('const complete =')[0]!
    }`;
    const count = execute(source, 'variantEmptySlotCount', {});
    const v = variant();
    expect(count(v)).toBe(1);
    v.bindings.hole = 'new';
    expect(count(v)).toBe(0);
    expect(page).toContain('条成片含空槽待补充');
    expect(timeline).toContain("? '空槽待补充' : '模板槽位'");
  });
});
