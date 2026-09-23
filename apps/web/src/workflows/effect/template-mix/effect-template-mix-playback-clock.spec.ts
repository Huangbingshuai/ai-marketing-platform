import { describe, expect, it } from 'vitest';

import pageSource from './EffectTemplateMixNodePage.vue?raw';
import timelineSource from './EffectTemplateMixTimeline.vue?raw';

describe('template mix compositor playback clock', () => {
  it('moves the timeline needle through a linear browser animation', () => {
    expect(timelineSource).toContain('const startPlaybackNeedle');
    expect(timelineSource).toContain('playheadElement.value');
    expect(timelineSource).toContain('element.animate(');
    expect(timelineSource).toContain("easing: 'linear'");
    expect(timelineSource).toContain('startPlaybackNeedle, stopPlaybackNeedle');
  });

  it('animates the player progress separately from Vue playhead renders', () => {
    expect(pageSource).toContain('const startPlayerScrubberMotion');
    expect(pageSource).toContain('fill.animate(');
    expect(pageSource).toContain('thumb.animate(');
    expect(pageSource).not.toContain('setPlayerScrubber(next)');
    expect(pageSource).toContain('lastUiPlaybackMilliseconds = performance.now()');
    expect(pageSource).toContain('v-memo="[');
  });

  it('freezes playback on pointer-down and invalidates pending resume work', () => {
    expect(pageSource).toContain('@pointerdown="onPreviewPlaybackPointerDown"');
    expect(pageSource).toContain('const pausedAt = currentPlaybackClockSeconds()');
    expect(pageSource).toContain('seekSyncRequestId++');
    expect(pageSource).toContain('playing.value = false');
  });
});
