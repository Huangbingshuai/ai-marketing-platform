import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EFFECT_TEMPLATE_MIX_MUSIC_FADE_DEFAULT,
  PACKAGING_AUDIO_DB_CEILING,
  PACKAGING_AUDIO_DB_FLOOR,
  PACKAGING_AUDIO_GAIN_CEILING,
  packagingAudioFade,
  packagingAudioFromDb,
  packagingAudioLevel,
  packagingAudioToDb,
  packagingTimelineClips,
  packagingTimelineDuration,
} from './effect-template-mix-packaging';
import type { EffectTemplateMixVariant } from './effect-template-mix';

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
