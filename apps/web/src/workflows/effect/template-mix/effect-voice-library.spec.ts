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
  it('isolates scope changes, aborts polling and preserves uncertain submission keys', () => {
    expect(source).toContain('props.projectId, props.workflowRunId, props.templateId');
    expect(source).toContain('current !== generation');
    expect(source).toContain('onBeforeUnmount');
    expect(source).toContain('controller?.abort()');
    expect(source).toContain('pendingKeys.get(profile.id)');
    expect(source).toContain('isActive(cached)');
  });
  it('plays a voice when its card is selected and replays cached audio on another click', () => {
    expect(source).toContain("cached?.status === 'COMPLETED'");
    expect(source).toContain('async function selectAndPlay(profile: EffectVoiceProfile)');
    expect(source).toContain('emit(\'select\', profile.id)');
    expect(source).toContain('await playPreview(cached)');
    expect(source).toContain('playAfterGenerationId.value = profile.id');
    expect(source).toContain('audio.currentTime = 0');
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
});
