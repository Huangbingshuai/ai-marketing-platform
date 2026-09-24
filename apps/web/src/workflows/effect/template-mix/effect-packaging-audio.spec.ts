import { describe, expect, it } from 'vitest';
import { packagingPlaybackError } from './effect-packaging-audio';
import packagingSource from './EffectTemplateMixPackaging.vue?raw';

describe('packaging audio playback wiring', () => {
  it('has no separate audio switch or control strip', () => {
    expect(packagingSource).not.toContain('previewEnabled');
    expect(packagingSource).not.toContain('packaging-strip');
    expect(packagingSource).not.toContain('静音口播与配乐');
    expect(packagingSource).not.toContain('开启同步试听');
    expect(packagingSource).not.toContain('旧版整片口播');
  });
  it('keeps completed and legacy variant audio available while the visual draft changes', () => {
    expect(packagingSource).toContain("item.status === 'COMPLETED'");
    expect(packagingSource).toContain('selectedVariant.value?.voice');
    expect(packagingSource).toContain('selectedVariant.value?.bgm');
    expect(packagingSource).toContain('previewAvailable,');
    expect(packagingSource).toMatch(/emit\('preview', enabled\);[\s\S]*?immediate: true/);
  });
  it('keeps playback and error recovery controlled by the main player', () => {
    expect(packagingSource).toContain(
      'playbackBlocked[kind] || (!props.playing && !forcePlayback)',
    );
    expect(packagingSource).toContain('() => [props.playing, props.selectedVariantId]');
    expect(packagingSource).toContain('playbackBlocked.MUSIC = false');
    expect(packagingSource).toContain('playbackBlocked.VOICE = false');
    expect(packagingSource).toContain('const timelineTime = props.playhead - audio.start');
    expect(packagingSource).toContain('timelineTime + Math.max(0, audio.offset ?? 0)');
    expect(packagingSource).toContain('element?.pause()');
    expect(packagingSource).not.toMatch(/<audio[^>]*\bautoplay\b/);
  });
  it('shares one mute flag per audio row and starts audio from the player gesture', () => {
    // Rows carry no meaning, so the preview silences a clip by the row the workbench says it is on
    // rather than by the kind of audio it is.
    expect(packagingSource).toContain('audioRowMuted: boolean[]');
    expect(packagingSource).toContain('audioRowByClipId: Record<string, number>');
    expect(packagingSource).toContain('const rowMuted = (clipId: string): boolean =>');
    expect(packagingSource).toContain('const currentVoiceEntry = computed<PreviewVoice | undefined>');
    expect(packagingSource).toContain(
      "['VOICE', voiceElement.value, currentVoice.value, rowMuted(currentVoiceEntry.value?.id ?? 'voice')]",
    );
    expect(packagingSource).toContain("['MUSIC', musicElement.value, currentMusic.value, rowMuted('music')]");
    expect(packagingSource).toContain('element.muted = muted');
    expect(packagingSource).not.toContain('voiceMuted');
    expect(packagingSource).not.toContain('musicMuted');
    expect(packagingSource).toContain('function startPlaybackAudio()');
    expect(packagingSource).toContain('syncAudio(true)');
    expect(packagingSource).toContain('startPlaybackAudio');
  });
  it('keeps legacy whole-film narration playable while repackaging', () => {
    expect(packagingSource).toContain("narrationLayoutVersion !== 'SLOT_V1'");
    expect(packagingSource).toContain('selectedVariant.value?.voice');
    expect(packagingSource).toContain('selectedVariant.value?.bgm');
    expect(packagingSource).toContain('previewAvailable');
  });
  it('plays a caption narration from an element of its own', () => {
    // It is added *alongside* the script-line voices it was generated next to, so their clips
    // overlap by design and one element cannot follow both.
    expect(packagingSource).toContain('const captionVoiceElement = ref<HTMLAudioElement | null>(null);');
    expect(packagingSource).toContain('CAPTION_VOICE: false');
    expect(packagingSource).toContain(
      'const currentCaptionVoiceEntry = computed<PreviewVoice | undefined>(',
    );
    expect(packagingSource).toContain("id: `capvoice:${captionId}`");
    expect(packagingSource).toContain('ref="captionVoiceElement"');
    // It joins the shared sync loop, so it gets the same seek, volume and fade treatment.
    expect(packagingSource).toContain("'CAPTION_VOICE',");
    expect(packagingSource).toContain("rowMuted(currentCaptionVoiceEntry.value?.id ?? ''),");
    // A narration that starts long after the play gesture has to be primed or the browser refuses
    // its later play(); both primed clips are released with the volume the prime borrowed.
    expect(packagingSource).toContain('function primeElement(');
    expect(packagingSource).toContain('primeElement(currentVoice.value, voiceElement.value,');
    expect(packagingSource).toContain('releaseElement(captionVoiceElement.value);');
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
