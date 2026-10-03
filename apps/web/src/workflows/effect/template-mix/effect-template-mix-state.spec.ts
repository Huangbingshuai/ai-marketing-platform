import type { EffectTemplateMixVariant, EffectTemplateMixWorkspace } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import { serializeEffectTemplateMixDraft } from './api/effect-template-mix.api';
import {
  assignEffectTemplateMixCaptionLanes,
  cloneMix,
  createEffectTemplateMixEntry,
  EFFECT_TEMPLATE_MIX_TRANSITIONS,
  EFFECT_TEMPLATE_MIX_TRANSITION_LIBRARY,
  effectTemplateMixCaptionRowKeys,
  effectTemplateMixCaptionTrackKey,
  effectTemplateMixTiming,
  effectTemplateMixTransitionDuration,
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
  it('saves pre-fill material choices and resets per template without changing project content', () => {
    const first = createEffectTemplateMixEntry('模板一');
    const second = createEffectTemplateMixEntry('模板二');
    first.materialRoleOverrides = { clip: 'PRODUCT', reset: null };
    first.materialRoleEditVersion = 3;
    const editVersion = first.workspace.editVersion;
    const serialized = serializeEffectTemplateMixDraft([first, second], first.id);
    const restored = JSON.parse(JSON.stringify(serialized));
    expect(restored.templates[0].materialRoleOverrides).toEqual({ clip: 'PRODUCT', reset: null });
    expect(restored.templates[0].materialRoleEditVersion).toBe(3);
    expect(restored.templates[1].materialRoleOverrides).toBeUndefined();
    expect(restored.templates[0].workspace.editVersion).toBe(editVersion);
    expect(restored.templates[0].workspace.variants).toEqual([]);
    expect(restored.templates[0].workspace.materials).toBeUndefined();
  });
  it('keeps the server-recorded template creation time when saving its draft again', () => {
    const entry = createEffectTemplateMixEntry('跑量模板');
    entry.createdAt = '2026-09-28T01:00:00.000Z';
    expect(serializeEffectTemplateMixDraft([entry], entry.id).templates[0]?.createdAt).toBe(
      entry.createdAt,
    );
  });

  it('creates one lane per manual caption track above the existing narration subtitle lane', () => {
    const lanes = assignEffectTemplateMixCaptionLanes(
      [
        { id: 'generated-1', start: 0, end: 3 },
        { id: 'generated-2', start: 4, end: 5 },
        {
          id: 'manual-older',
          manual: true,
          trackId: 'subtitle-track-0000000000001-test',
          start: 0,
          end: 3,
        },
        {
          id: 'manual-newest',
          manual: true,
          trackId: 'subtitle-track-0000000000002-test',
          start: 10,
          end: 12,
        },
      ],
      30,
    );
    expect(lanes.get('manual-newest')).toBe(0);
    expect(lanes.get('manual-older')).toBe(1);
    expect(lanes.get('generated-1')).toBe(2);
    expect(lanes.get('generated-2')).toBe(2);
  });

  it('names the group that owns each drawn row, newest track first', () => {
    expect(
      effectTemplateMixCaptionRowKeys(
        [
          { id: 'generated-1', start: 0, end: 3 },
          { id: 'generated-2', start: 4, end: 5 },
          {
            id: 'manual-older',
            manual: true,
            trackId: 'subtitle-track-0000000000001-test',
            start: 0,
            end: 3,
          },
          {
            id: 'manual-newest',
            manual: true,
            trackId: 'subtitle-track-0000000000002-test',
            start: 10,
            end: 12,
          },
        ],
        30,
      ),
    ).toEqual([
      'track:subtitle-track-0000000000002-test',
      'track:subtitle-track-0000000000001-test',
      'legacy-generated',
    ]);
  });

  it('gives every row of a multi-row group the same key, so any of them can be joined', () => {
    // Two legacy cards overlap in time, so the packer spreads them over two rows — but both rows
    // still belong to the implicit group, which is what a drop on either of them has to report.
    const captions = [
      { id: 'a', start: 0, end: 5 },
      { id: 'b', start: 1, end: 6 },
    ];
    expect(effectTemplateMixCaptionRowKeys(captions, 30)).toEqual([
      'legacy-generated',
      'legacy-generated',
    ]);
    expect(effectTemplateMixCaptionTrackKey(captions[0]!)).toBe('legacy-generated');
    expect(effectTemplateMixCaptionTrackKey({ id: 'm', manual: true })).toBe('manual:m');
    expect(effectTemplateMixCaptionTrackKey({ id: 'm', manual: true, trackId: 't1' })).toBe(
      'track:t1',
    );
  });

  it('keeps a new template without a project until AI fill completes', () => {
    const value = workspace();
    expect(value.variants).toEqual([]);
  });

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

  it('keeps a variant-only clip on its own track through a template resync', () => {
    const value = workspace();
    value.variants = [variant(value, 'selected')];
    const selected = value.variants[0]!;
    const extra = {
      id: 'free-clip',
      role: 'PRODUCT' as const,
      purpose: 'PRODUCT_DISPLAY' as const,
      label: 'MAT-9',
      duration: 5,
      transition: '硬切' as const,
      transitionDuration: 0,
    };
    selected.slots.push(extra);
    selected.bindings[extra.id] = 'material-9';
    selected.videoLanes = { [extra.id]: 2 };
    selected.timelineStarts = { [extra.id]: 12 };
    value.template.slots[0]!.duration = 6;
    markEffectTemplateMixChanged(value, 'selected');
    // The template's own slot is resynced...
    expect(selected.slots[0]!.duration).toBe(6);
    expect(selected.slots).toHaveLength(7);
    // ...while the clip the template never knew about keeps its binding, row and start.
    expect(selected.slots.at(-1)).toEqual(extra);
    expect(selected.bindings[extra.id]).toBe('material-9');
    expect(selected.videoLanes[extra.id]).toBe(2);
    expect(selected.timelineStarts[extra.id]).toBe(12);
  });

  it('reorders without mutating the template array', () => {
    const slots = workspace().template.slots;
    const moved = moveEffectTemplateMixSlot(slots, slots[0]!.id, 1);
    expect(moved[1]!.id).toBe(slots[0]!.id);
    expect(slots[0]!.id).not.toBe(moved[0]!.id);
  });

  it('clamps transition duration to the adjacent slot lengths', () => {
    const slots = workspace().template.slots.slice(0, 2);
    slots[0]!.duration = 1.4;
    slots[1]!.duration = 2.2;
    slots[1]!.transition = '叠化';
    slots[1]!.transitionDuration = 4;
    expect(effectTemplateMixTransitionDuration(slots[1]!, slots[0]!)).toBe(1.4);
    expect(effectTemplateMixTransitionDuration(slots[0]!)).toBe(0);
  });

  it('uses one second as the default duration for every non-cut transition', () => {
    const slots = workspace().template.slots.slice(0, 2);
    slots[0]!.duration = 3;
    slots[1]!.duration = 3;
    slots[1]!.transition = '闪白';
    delete slots[1]!.transitionDuration;
    expect(effectTemplateMixTransitionDuration(slots[1]!, slots[0]!)).toBe(1);
  });

  it('exposes the popular transition set in the shared editor state', () => {
    expect(EFFECT_TEMPLATE_MIX_TRANSITION_LIBRARY).toContainEqual(
      expect.objectContaining({ id: '硬切', label: '无转场' }),
    );
    expect(EFFECT_TEMPLATE_MIX_TRANSITIONS).toEqual(
      expect.arrayContaining([
        '擦除',
        '左滑',
        '上推',
        '翻转',
        '圆形展开',
        '右滑',
        '旋转',
        '像素化',
        '波纹',
        '圆形扩散',
        '翻页',
        '立方体',
        '噪点溶解',
      ]),
    );
    expect(
      EFFECT_TEMPLATE_MIX_TRANSITION_LIBRARY.filter((item) => item.category === '热门'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: '擦除' }),
        expect.objectContaining({ id: '圆形展开' }),
        expect.objectContaining({ id: '旋转' }),
        expect.objectContaining({ id: '像素化' }),
        expect.objectContaining({ id: '波纹' }),
        expect.objectContaining({ id: '翻页' }),
        expect.objectContaining({ id: '液体扭曲' }),
      ]),
    );
  });
});
