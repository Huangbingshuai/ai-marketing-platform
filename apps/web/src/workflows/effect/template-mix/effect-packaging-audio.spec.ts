import { describe, expect, it } from 'vitest';
import { packagingPlaybackError } from './effect-packaging-audio';
import packagingSource from './EffectTemplateMixPackaging.vue?raw';
import pageSource from './EffectTemplateMixNodePage.vue?raw';

describe('packaging audio playback wiring', () => {
  it('uses one sample-scheduled transport for voices, caption voices and music', () => {
    expect(packagingSource).toContain('new PackagingSampleClock(fileUrl)');
    expect(packagingSource).toContain('checkpoint?.voices');
    expect(packagingSource).toContain('checkpoint?.captionVoices');
    expect(packagingSource).toContain('checkpoint?.music');
    expect(packagingSource).toContain('rowMuted(id)');
    expect(packagingSource).toContain('playbackAudioTime,');
    expect(packagingSource).not.toContain('timelineEntryKey');
    expect(packagingSource).not.toContain('primeElement(');
    expect(packagingSource).not.toContain('@canplay="syncAudio()"');
  });
  it('keeps completed and legacy audio available and invalidates pause, seek and project changes', () => {
    expect(packagingSource).toContain("item.status === 'COMPLETED'");
    expect(packagingSource).toContain("checkpoint.narrationLayoutVersion !== 'SLOT_V1'");
    expect(packagingSource).toContain('selectedVariant.value?.voice');
    expect(packagingSource).toContain('selectedVariant.value?.bgm');
    expect(packagingSource).toContain('() => props.seekVersion');
    expect(packagingSource).toContain('() => props.playing');
    expect(packagingSource).toContain('sampleClock.dispose()');
    expect(packagingSource).toContain('emit(\'playbackFailed\')');
  });
  it('reads output time every frame for captions without advancing the full editor tree each frame', () => {
    expect(pageSource).toContain('packagingPanel.value?.playbackAudioTime()');
    expect(pageSource).toContain('captionPresentationTime.value = next');
    expect(pageSource).toContain('const next = currentPlaybackClockSeconds()');
    expect(pageSource).toContain('now - lastUiPlaybackMilliseconds >= 1000');
    expect(pageSource).toContain('syncPlaybackNeedleClock(next)');
    expect(pageSource).toContain('await Promise.all([videoReady, audioReady])');
    expect(pageSource).not.toContain(':playback-time="packagingPlaybackTime"');
  });
  it('uses one editable package-wide subtitle font size for every preview caption', () => {
    expect(pageSource).toContain('const stageCaptionFontSize = ref(16)');
    expect(pageSource).not.toContain('element.clientWidth / 22');
    expect(pageSource).toContain(
      'selectedPackaging.value?.checkpoint.captionFontSize ?? stageCaptionFontSize.value',
    );
    expect(pageSource).toContain('fontSize: `${captionFontSize.value}px`');
    expect(pageSource).toContain('checkpoint.captionFontSize = next');
    expect(pageSource).toContain('changeCaptionFontSize(-1)');
    expect(pageSource).toContain('changeCaptionFontSize(1)');
    expect(pageSource).not.toContain('stageCaptionFontSize.value * box.scale');
    expect(pageSource).not.toContain('changeCaptionScale');
    expect(pageSource).not.toContain('caption-scale-handle');
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
