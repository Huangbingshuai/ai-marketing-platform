import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS,
  EFFECT_TEMPLATE_MIX_MUSIC_FADE_DEFAULT,
  PACKAGING_AUDIO_DB_CEILING,
  PACKAGING_AUDIO_DB_FLOOR,
  PACKAGING_AUDIO_GAIN_CEILING,
  effectTemplateMixContentDuration,
  effectTemplateMixPlacedContentDuration,
  packagingAudioFade,
  packagingAudioFromDb,
  packagingAudioLevel,
  packagingAudioToDb,
  packagingTimelineClips,
  packagingTimelineDuration,
  packagingPictureOnlyVariant,
  packagingCaptionFontPixels,
  PACKAGING_CAPTION_REFERENCE_HEIGHT,
} from './effect-template-mix-packaging';
import type { EffectTemplateMixVariant } from './effect-template-mix';
import type { PackagingCheckpoint } from './effect-template-mix-packaging';

describe('caption canvas sizing', () => {
  it('keeps the reference size and historical default stable', () => {
    expect(PACKAGING_CAPTION_REFERENCE_HEIGHT).toBe(360);
    expect(packagingCaptionFontPixels(undefined, 360)).toBe(16);
    expect(packagingCaptionFontPixels(Number.NaN, 360)).toBe(16);
    expect(packagingCaptionFontPixels(16, 0)).toBe(16);
    expect(packagingCaptionFontPixels(16, Number.NaN)).toBe(16);
  });
  it.each([180, 360, 480, 720, 960, 1080, 1280, 1440, 2160, 3840])(
    'preserves relative subtitle height on a %ipx canvas',
    (height) => {
      expect(packagingCaptionFontPixels(undefined, height) / height).toBeCloseTo(16 / 360);
      expect(packagingCaptionFontPixels(24, height) / height).toBeCloseTo(24 / 360);
      expect(packagingCaptionFontPixels(1, height) / height).toBeCloseTo(8 / 360);
      expect(packagingCaptionFontPixels(100, height) / height).toBeCloseTo(48 / 360);
    },
  );
  it('does not cap a valid high-resolution font at 48 output pixels', () => {
    expect(packagingCaptionFontPixels(16, 2160)).toBe(96);
    expect(packagingCaptionFontPixels(24, 960)).toBe(64);
  });
});

describe('fresh packaging picture-only projection', () => {
  it('removes every non-video track without mutating the baseline or collapsing gaps and tails', () => {
    const variant = {
      id: 'v',
      slots: [{ id: 's', duration: 6 }],
      bindings: { s: 'asset' },
      clipStarts: { s: 6 },
      captions: [{ start: 18, end: 22, text: 'original' }],
      voice: { start: 0, duration: 10 },
      bgm: { start: 0, duration: 30 },
      detachedAudios: [{ start: 26, duration: 6 }],
      audioLanes: { a: 1 },
      originalVolume: 1,
      intentionallyEmptySlotIds: ['empty'],
      preservedTimelineEnd: 28,
    } as unknown as EffectTemplateMixVariant;
    const baseline = structuredClone(variant);
    const clean = packagingPictureOnlyVariant(variant, {
      music: { start: 0, duration: 36 },
    } as PackagingCheckpoint);
    expect(variant).toEqual(baseline);
    expect(clean).toMatchObject({
      preservedTimelineEnd: 36,
      captions: [],
      voice: null,
      bgm: null,
      detachedAudios: [],
      audioLanes: {},
      originalVolume: 0,
      intentionallyEmptySlotIds: ['empty'],
      bindings: { s: 'asset' },
    });
    expect(clean.slots).toEqual(baseline.slots);
  });
});

describe('packaging audio fades', () => {
  it('reports the fade the worker will actually render', () => {
    const voice = { duration: 2.4 };
    const music = { duration: 10 };
    // A narration line is not eased unless the editor asked for it.
    expect(packagingAudioFade(voice, 'VOICE', 'fadeIn')).toBe(0);
    expect(packagingAudioFade(voice, 'VOICE', 'fadeOut')).toBe(0);
    // The music bed carries the pipeline's own easing.
    expect(packagingAudioFade(music, 'MUSIC', 'fadeIn')).toBe(
      EFFECT_TEMPLATE_MIX_MUSIC_FADE_DEFAULT,
    );
    expect(packagingAudioFade(music, 'MUSIC', 'fadeOut')).toBe(
      EFFECT_TEMPLATE_MIX_MUSIC_FADE_DEFAULT,
    );
    // An explicit value always wins, including an explicit zero.
    expect(packagingAudioFade({ duration: 10, fadeIn: 0 }, 'MUSIC', 'fadeIn')).toBe(0);
    expect(packagingAudioFade({ duration: 2.4, fadeOut: 1.2 }, 'VOICE', 'fadeOut')).toBe(1.2);
  });

  it('halves the music default rather than overrunning a very short bed', () => {
    const short = { duration: 0.6 };
    expect(packagingAudioFade(short, 'MUSIC', 'fadeIn')).toBe(0.3);
    expect(packagingAudioFade(short, 'MUSIC', 'fadeOut')).toBe(0.3);
  });

  it('agrees with the worker it mirrors', () => {
    const worker = readFileSync(
      resolve(
        __dirname,
        '../../../workers/effect-template-mix/src/effect_template_mix/final_output.py',
      ),
      'utf8',
    );
    // `music.get('fadeIn', min(0.5, music_length / 2))` and the narration's `0.0` fallback.
    expect(worker).toContain("float(music.get('fadeIn', min(0.5, music_length / 2)) or 0.0)");
    expect(worker).toContain("float(music.get('fadeOut', min(0.5, music_length / 2)) or 0.0)");
    expect(worker).toContain("float(voice.get('fadeIn', 0.0) or 0.0)");
    expect(worker).toContain("float(voice.get('fadeOut', 0.0) or 0.0)");
    expect(EFFECT_TEMPLATE_MIX_MUSIC_FADE_DEFAULT).toBe(0.5);
  });
});

describe('packaging audio volume scale', () => {
  it('anchors the scale on silence and on unity gain', () => {
    expect(PACKAGING_AUDIO_DB_FLOOR).toBe(-60);
    expect(PACKAGING_AUDIO_DB_CEILING).toBe(20);
    // The top of the scale is the gain the server accepts, so the row's last step is a legal value.
    expect(PACKAGING_AUDIO_GAIN_CEILING).toBe(10);
    expect(packagingAudioFromDb(PACKAGING_AUDIO_DB_CEILING)).toBeCloseTo(10, 10);
  });

  it('folds everything at or under the floor onto the floor, so silence reads as -infinity', () => {
    expect(packagingAudioToDb(0)).toBe(PACKAGING_AUDIO_DB_FLOOR);
    // Anything below the floor is indistinguishable from a mute, and must not report a lower number.
    expect(packagingAudioToDb(1e-9)).toBe(PACKAGING_AUDIO_DB_FLOOR);
    expect(packagingAudioFromDb(PACKAGING_AUDIO_DB_FLOOR)).toBe(0);
    expect(packagingAudioFromDb(PACKAGING_AUDIO_DB_FLOOR - 30)).toBe(0);
  });

  it('round-trips a gain through dB and back', () => {
    for (const gain of [0.12, 0.3, 0.5, 1, 2, 10]) {
      expect(packagingAudioFromDb(packagingAudioToDb(gain))).toBeCloseTo(gain, 10);
    }
    expect(packagingAudioToDb(1)).toBe(0);
  });

  it('places a level line where the dB row says it is, not where the raw gain is', () => {
    expect(packagingAudioLevel(0)).toBe(0);
    expect(packagingAudioLevel(PACKAGING_AUDIO_GAIN_CEILING)).toBe(1);
    // Unity is three quarters of the way up a -60..+20 scale; drawing the raw gain would put a normal
    // level at a tenth of the strip and read as almost silent.
    expect(packagingAudioLevel(1)).toBeCloseTo(0.75, 10);
    // Out-of-range values clamp rather than escaping the strip.
    expect(packagingAudioLevel(1000)).toBe(1);
    expect(packagingAudioLevel(-1)).toBe(0);
  });
});

describe('packaging timeline geometry', () => {
  const variant = (): EffectTemplateMixVariant =>
    ({
      id: 'v',
      slots: [
        { id: 'a', duration: 4 },
        { id: 'b', duration: 6 },
      ],
      bindings: { a: 'clip', b: 'clip' },
      timelineStarts: { b: 5 },
      videoLanes: { a: 0, b: 1 },
    }) as unknown as EffectTemplateMixVariant;

  it('reads explicit starts and lane assignments', () => {
    expect(packagingTimelineClips(variant()).map((row) => [row.start, row.lane])).toEqual([
      [0, 0],
      [5, 1],
    ]);
    // The furthest bound clip ends at 11, not the 10 the slot durations would sum to.
    expect(packagingTimelineDuration(variant())).toBe(11);
  });

  it('ignores unbound slots when measuring the timeline', () => {
    const unbound = variant();
    unbound.bindings = { a: 'clip' };
    expect(packagingTimelineDuration(unbound)).toBe(4);
    expect(packagingTimelineDuration({ ...unbound, slots: [] })).toBe(0);
  });
});

describe('packaging content duration', () => {
  const variant = (): EffectTemplateMixVariant =>
    ({
      id: 'v',
      slots: [
        { id: 'a', duration: 4 },
        { id: 'b', duration: 6 },
      ],
      bindings: { a: 'clip', b: 'clip' },
      timelineStarts: { b: 5 },
    }) as unknown as EffectTemplateMixVariant;

  it('is the visual timeline when nothing has been carried past its end', () => {
    expect(effectTemplateMixContentDuration(variant())).toBe(11);
    // The frozen snapshot's own length is untouched: it stays the visual timeline's.
    expect(packagingTimelineDuration(variant())).toBe(11);
  });

  it('follows a detached track the editor carried past the last clip', () => {
    const extended = variant();
    extended.detachedAudios = [
      { id: 'd1', fileObjectId: 'f', sourceSlotId: 'a', start: 20, duration: 5 },
    ] as unknown as NonNullable<EffectTemplateMixVariant['detachedAudios']>;
    expect(packagingTimelineDuration(extended)).toBe(11);
    expect(effectTemplateMixContentDuration(extended)).toBe(25);
  });

  it('follows the checkpoint, which is where placed audio and captions live', () => {
    const checkpoint = {
      voices: { a: { fileObjectId: 'f', start: 30, duration: 4, volume: 1 } },
      music: { fileObjectId: 'f', start: 0, duration: 12, volume: 1 },
      captions: [{ id: 'c', text: 't', start: 40, end: 41 }],
    } as unknown as PackagingCheckpoint;
    // The longest of the three wins, not the sum.
    expect(effectTemplateMixContentDuration(variant(), checkpoint)).toBe(41);
  });

  it('counts a caption narration the editor generated, which the renderer mixes like any other', () => {
    const checkpoint = {
      voices: { a: { fileObjectId: 'f', start: 0, duration: 4, volume: 1 } },
      captionVoices: { 'caption-1': { fileObjectId: 'g', start: 30, duration: 6, volume: 1 } },
    } as unknown as PackagingCheckpoint;
    // A line longer than the picture has to extend the film, or the renderer's own bound check
    // would reject it instead of rendering a black tail under it.
    expect(effectTemplateMixContentDuration(variant(), checkpoint)).toBe(36);
  });

  it('prefers the checkpoint captions over the draft, and tolerates an empty one', () => {
    const withDraftCaptions = variant();
    withDraftCaptions.captions = [{ id: 'c', text: 't', start: 50, end: 52 }] as never;
    // No checkpoint yet: the draft's captions are the only caption source there is.
    expect(effectTemplateMixContentDuration(withDraftCaptions)).toBe(52);
    // Once a checkpoint exists its captions are the frozen ones, so the draft's are ignored.
    expect(
      effectTemplateMixContentDuration(withDraftCaptions, { captions: [] } as PackagingCheckpoint),
    ).toBe(11);
    expect(effectTemplateMixContentDuration({ ...variant(), slots: [] } as never)).toBe(0);
  });

  it('caps the film an hour out, which is the only bound left once length follows content', () => {
    expect(EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS).toBe(3600);
  });
  it('treats empty template slots as signs, not content or implicit gaps', () => {
    const sparse = variant();
    sparse.bindings = { b: 'clip' };
    sparse.timelineStarts = {};
    expect(packagingTimelineClips(sparse)[1]?.start).toBe(0);
    expect(effectTemplateMixPlacedContentDuration(sparse)).toBe(6);
    sparse.bindings = {};
    expect(effectTemplateMixPlacedContentDuration(sparse)).toBe(0);
    expect(effectTemplateMixContentDuration(sparse)).toBe(0);
  });
  it('counts only actual placed audio or captions for a new film', () => {
    const empty = { ...variant(), bindings: {}, preservedTimelineEnd: 40 };
    expect(effectTemplateMixPlacedContentDuration(empty)).toBe(0);
    expect(
      effectTemplateMixPlacedContentDuration({
        ...empty,
        captions: [{ id: 'c', text: '字幕', start: 1, end: 3 }],
      }),
    ).toBe(3);
    const voice = { fileObjectId: 'f', name: '音频', start: 2, duration: 5, offset: 0, volume: 1 };
    expect(effectTemplateMixPlacedContentDuration({ ...empty, voice })).toBe(7);
    expect(effectTemplateMixContentDuration({ ...variant(), bindings: {}, voice })).toBe(7);
    expect(effectTemplateMixPlacedContentDuration({ ...empty, bgm: voice })).toBe(7);
    expect(
      effectTemplateMixPlacedContentDuration({
        ...empty,
        captions: [{ id: 'c', text: ' ', start: 1, end: 3 }],
      }),
    ).toBe(0);
  });
});
