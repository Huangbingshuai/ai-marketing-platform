import { describe, expect, it } from 'vitest';
import source from './EffectVoiceLibrary.vue?raw';
import page from './EffectTemplateMixNodePage.vue?raw';

describe('voice library UI boundaries', () => {
  it('uses the audio pane and persists a preference without automatically generating', () => {
    expect(page).toContain('<EffectVoiceLibrary');
    expect(page).toContain(':selected-id="workspace.template.voiceProfileId"');
    const select = page.slice(
      page.indexOf('const selectVoiceProfile'),
      page.indexOf('const pauseForVoiceAudition'),
    );
    expect(select).toContain('workspace.value.template.voiceProfileId = id');
    expect(select).toContain('bump()');
    expect(select).not.toMatch(/createPackaging|requestJson|\.start\(/);
  });
  it('isolates scope changes and aborts stale catalog requests', () => {
    expect(source).toContain('props.projectId, props.workflowRunId, props.templateId');
    expect(source).toContain('current !== generation');
    expect(source).toContain('onBeforeUnmount');
    expect(source).toContain('controller?.abort()');
  });
  it('plays a pre-generated catalog sample without submitting synthesis on card click', () => {
    expect(source).toContain('async function selectAndPlay(profile: EffectVoiceProfile)');
    expect(source).toContain("emit('select', profile.id)");
    expect(source).toContain('voice-profiles/${encodeURIComponent(profile.id)}/sample');
    expect(source).not.toContain('/voice-previews');
    expect(source).not.toContain("method: 'POST'");
    expect(source).toContain('audio.currentTime = 0');
    expect(source).toContain('async function prepareSample(profile: EffectVoiceProfile)');
    expect(source).toContain('sampleRequests.get(key)');
    expect(source).toContain('URL.createObjectURL(blob)');
    expect(source).toContain('preloadVisiblePage');
    expect(source).toContain('preload="auto"');
    expect(source).toContain('playingVoiceProfileId.value = currentPlayingId.value');
    expect(source).toContain('@play="markPreviewPlaying"');
    expect(source).toContain('@pause="markPreviewStopped"');
    expect(source).toContain('voice-card-playing');
    expect(source).toContain('@keyframes equalize');
    expect(source).toContain('aria-label="音色选择"');
    expect(source).not.toContain('试听</button>');
    expect(source).not.toContain('controls');
    expect(source).toMatch(/watch\(\s*\(\) => props\.playing/);
    expect(source).toContain('if (playing) stop()');
    expect(source).toContain('role="alert"');
    expect(source).toContain('aria-pressed');
    expect(source).not.toContain('openspeech.bytedance.com');
    expect(source).not.toContain('火山音色库');
  });
  it('removes the standalone refresh toolbar and paginates voice cards', () => {
    expect(source).not.toContain('RefreshCw');
    expect(source).not.toContain('刷新音色');
    expect(source).toContain('const pageSize = 20');
    expect(source).toContain('catalog.value.profiles.slice(start, start + pageSize)');
    expect(source).toContain('v-for="profile in paginatedProfiles"');
    expect(source).toContain('aria-label="音色分页"');
    expect(source).toContain('aria-label="上一页音色"');
    expect(source).toContain('aria-label="下一页音色"');
    expect(source).not.toContain('profile.gender');
    expect(source).not.toContain('voice-card-meta');
    expect(source).toContain('overflow-wrap: anywhere');
    expect(source).not.toContain('text-overflow: ellipsis');
  });
});
