import { describe, expect, it } from 'vitest';

import pageSource from './EffectTemplateMixNodePage.vue?raw';
import timelineSource from './EffectTemplateMixTimeline.vue?raw';

describe('template mix compositor playback clock', () => {
  it('warms the next clip without reloads and reuses positioned frames at natural boundaries', () => {
    expect(pageSource).toContain('prepareTimelineVideo(video, timelineVideoSeeks, targetTime');
    const timelinePreparation = pageSource.slice(
      pageSource.indexOf('const syncTimelineVideo ='),
      pageSource.indexOf('const closeMaterialPreview ='),
    );
    expect(timelinePreparation.includes('video.load()')).toBe(false);
    expect(pageSource).not.toContain("entering ? 'drift' : 'once'");
    expect(pageSource).toContain('const needsSlotSeek = !positionedTimelinePlayers.has(video)');
    expect(pageSource).toContain('if (incomingRange) primeUpcomingTimelinePlayer(incomingRange)');
    expect(pageSource).toContain('timelineSourceTime(slot.id, playbackTime)');
    expect(pageSource).toContain('resume && timelineVideoSeeks.isSettled(video) && video.paused');
  });
  it('moves the timeline needle through a linear browser animation', () => {
    expect(timelineSource).toContain('const startPlaybackNeedle');
    expect(timelineSource).toContain('playheadElement.value');
    expect(timelineSource).toContain('element.animate(');
    expect(timelineSource).toContain("easing: 'linear'");
    expect(timelineSource).toContain('startPlaybackNeedle,');
    expect(timelineSource).toContain('stopPlaybackNeedle,');
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

  it('updates the player timecode on every animation frame without a full Vue render', () => {
    expect(pageSource).toContain('const playerTimecode = ref<HTMLSpanElement | null>(null)');
    expect(pageSource).toContain(
      'playerTimecode.value.textContent = formatPlayerTimecode(seconds)',
    );
    expect(pageSource).toContain('syncPlayerTimecode(next)');
    expect(pageSource).toContain('ref="playerTimecode"');
  });

  it('keeps Space playback available when the player scrubber has focus', () => {
    const scrubberSpaceHandler = pageSource.indexOf(
      "if (event.code === 'Space' && target === playerScrubber.value)",
    );
    const genericInputGuard = pageSource.indexOf(
      'target?.matches(\'input, textarea, select, [contenteditable="true"]\')',
    );
    expect(scrubberSpaceHandler).toBeGreaterThan(-1);
    expect(genericInputGuard).toBeGreaterThan(scrubberSpaceHandler);
    expect(pageSource).toContain('if (!event.repeat) togglePreviewPlayback()');
  });

  it('steps left and right by one whole frame and clamps at the preview ends', () => {
    expect(pageSource).toContain(
      'const lastFrame = Math.max(0, Math.ceil(previewDuration.value * TIMELINE_FPS) - 1)',
    );
    expect(pageSource).toContain('Math.round(previewCurrentTime.value * TIMELINE_FPS)');
    expect(pageSource).toContain('currentFrame + direction');
    expect(pageSource).toContain('/ TIMELINE_FPS);');
  });
});
