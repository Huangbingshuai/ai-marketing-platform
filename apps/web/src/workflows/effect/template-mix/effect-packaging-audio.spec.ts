import { describe, expect, it } from 'vitest';
import { packagingPlaybackError } from './effect-packaging-audio';
import packagingSource from './EffectTemplateMixPackaging.vue?raw';

describe('packaging audio playback wiring', () => {
  it('has no separate audio switch or control strip', () => {
    expect(packagingSource).not.toContain('previewEnabled');
    expect(packagingSource).not.toContain('packaging-strip');
    expect(packagingSource).not.toContain('静音口播与配乐');
    expect(packagingSource).not.toContain('开启同步试听');
  });
  it('only enables completed, current packaging and immediately informs the source-audio mix', () => {
    expect(packagingSource).toContain(
      "selected.value?.status === 'COMPLETED' && !selected.value.stale",
    );
    expect(packagingSource).toContain('() => !playbackBlocked.value && previewAvailable.value');
    expect(packagingSource).toMatch(/emit\('preview', enabled\);[\s\S]*?immediate: true/);
  });
  it('keeps playback and error recovery controlled by the main player', () => {
    expect(packagingSource).toContain('playbackBlocked.value || !props.playing');
    expect(packagingSource).toContain('() => [props.playing, props.selectedVariantId]');
    expect(packagingSource).toContain('playbackBlocked.value = false');
    expect(packagingSource).toContain('const time = props.playhead - audio.start');
    expect(packagingSource).toContain('element?.pause()');
    expect(packagingSource).not.toMatch(/<audio[^>]*\bautoplay\b/);
  });
});

describe('packaging audio play promise', () => {
  it('does not disable preview when a sentence switch or pause aborts pending playback', () => {
    expect(packagingPlaybackError({ name: 'AbortError' }, true)).toBeNull();
  });
  it('ignores obsolete media, project and disabled-preview promises', () => {
    expect(packagingPlaybackError({ name: 'NotAllowedError' }, false)).toBeNull();
    expect(packagingPlaybackError(new Error('old media'), false)).toBeNull();
  });
  it('distinguishes permission refusal from unsupported or unreadable audio', () => {
    expect(packagingPlaybackError({ name: 'NotAllowedError' }, true)).toContain('浏览器阻止');
    expect(packagingPlaybackError({ name: 'NotSupportedError' }, true)).toContain('暂时无法播放');
  });
});
