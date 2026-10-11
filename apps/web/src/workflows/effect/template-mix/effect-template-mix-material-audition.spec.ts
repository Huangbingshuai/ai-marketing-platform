import { describe, expect, it } from 'vitest';
import pageSource from './EffectTemplateMixNodePage.vue?raw';

describe('material library audition owns the player image', () => {
  it('hides the entire spatial layer, including inline opacity and transformed video', () => {
    const layer = pageSource.match(/<div[^>]*class="video-spatial-layer"[^>]*>/)?.[0];
    expect(layer).toContain('v-show="!auditionMaterial"');
    // Preserve mounted media and decoded frames for returning to the timeline.
    expect(layer).toContain('v-if="materialForSlot(slot.id)"');
    expect(layer).not.toContain('v-if="!auditionMaterial');
  });

  it('does not cover the audition with a frozen transition frame or overlay', () => {
    expect(pageSource).toContain('v-if="transitionFrame && !auditionMaterial"');
    expect(pageSource).toContain(
      'v-if="!auditionMaterial && activeTransitionPreview && transitionOverlayStyle"',
    );
  });

  it('keeps library audition separate from timeline binding and playback', () => {
    const preview = pageSource
      .split('const previewLibraryMaterial =')[1]!
      .split('const selectTemplate =')[0]!;
    expect(preview).toContain('pauseTimelinePlayers()');
    expect(preview).toContain('auditionMaterial.value = material');
    expect(preview).toContain('await video.play()');
    expect(preview).not.toMatch(/scheduleSave|rememberTimelineEdit|bindings\[/);
    expect(pageSource).toContain('if (auditionMaterial.value) void toggleAuditionPlayback()');
  });

  it('renders time and progress on the native frame clock instead of low-frequency timeupdate', () => {
    const playing = pageSource
      .split('const onAuditionPlay =')[1]!
      .split('const toggleAuditionPlayback =')[0]!;
    expect(playing).toContain('materialPreviewClock.start(video');
    expect(playing).toContain('syncPlayerTimecode(seconds)');
    expect(playing).toContain('setPlayerScrubber(seconds)');
    expect(playing).not.toContain('startPlayerScrubberMotion(');
    expect(pageSource).toContain(
      '<span ref="playerTimecode" class="player-time current">00:00:00:00</span>',
    );
    expect(pageSource.split('onDeactivated(() => {')[1]).toContain('closeMaterialPreview()');
    expect(pageSource.split('onBeforeUnmount(() => {')[1]).toContain('materialPreviewClock.stop()');
  });

  it('keeps the matching cached cover until decoded presentation and avoids unconditional reloads', () => {
    const preview = pageSource
      .split('const previewLibraryMaterial =')[1]!
      .split('const selectTemplate =')[0]!;
    expect(preview).toContain('if (video.error) video.load()');
    expect(preview).toContain('materialFirstFrame.wait(video');
    expect(preview).toContain('if (request !== auditionRequest) return');
    expect(pageSource).toContain(':key="auditionMediaIdentity"');
    expect(pageSource).toContain(':class="{ \'is-visible\': auditionFrameReady }"');
    expect(pageSource).toContain('v-if="auditionMaterial && !auditionFrameReady"');
    expect(pageSource).toContain(':poster="auditionCachedPoster || undefined"');
    expect(pageSource).toContain('event.currentTarget !== auditionPlayer.value');
    expect(
      pageSource
        .split('const closeMaterialPreview =')[1]!
        .split('const previewLibraryMaterial =')[0],
    ).toContain('materialFirstFrame.reset()');
    expect(
      pageSource.split('const onAuditionError =')[1]!.split('const toggleAuditionPlayback =')[0],
    ).toContain('materialFirstFrame.reset()');
    expect(pageSource.split('onBeforeUnmount(() => {')[1]).toContain('materialFirstFrame.reset()');
  });
});
